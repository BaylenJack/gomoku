// WebSocket 服务端 — 静态文件 + 实时对局同步
//
// 稳定性设计:
//   1. 服务端是唯一权威 —— 客户端只发意图, 所有规则判定在服务端做,
//      前端被改也无法作弊, 双方看到的棋局必然一致
//   2. 心跳(ping/pong) 30s —— 及时发现半开连接(手机切后台/网络漂移),
//      否则连接会假死, 表现为"对方明明在线却收不到棋"
//   3. 全部状态持久化 —— 服务重启、断网、关页面都不丢棋局
//   4. 单连接单房间, 消息体积上限, 防止异常输入拖垮进程

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BLACK, WHITE } from './game.js';
import { Store } from './store.js';
import {
  createRoom,
  claimSeat,
  colorOf,
  tokenOf,
  tryMove,
  requestUndo,
  resolveUndo,
  newGame,
  publicView,
  seatCount,
} from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'rooms.json');
const MAX_MSG = 4096; // 单条消息字节上限
const ROOM_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天无活动的房间清理掉

const store = new Store(DATA_FILE);

// ---------- 对局落子日志 ----------
// 每局全部落子追加到 data/games/<roomId>.jsonl —— 重开/悔棋不会覆盖历史,
// 对局结束后可完整复盘 (review-game.js)。行: { ts, type: move|new-game|undo|end, ... }
const GAME_LOG_DIR = path.join(__dirname, '..', 'data', 'games');
function logGameEvent(roomId, ev) {
  try {
    fs.mkdirSync(GAME_LOG_DIR, { recursive: true });
    const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.appendFileSync(path.join(GAME_LOG_DIR, safe + '.jsonl'),
      JSON.stringify({ ts: Date.now(), roomId, ...ev }) + '\n');
  } catch (e) {
    console.error('[server] 落子日志失败:', e.message);
  }
}

// 特权白名单 —— 仅 HINT_TOKEN 环境变量中列出的 token 能看到 AI 提示按钮
// (你专用, 从环境变量注入, 代码里不写死)
const PRIVILEGED_TOKENS = new Set(
  (process.env.HINT_TOKEN || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
);

// 专属链接兑换密钥 —— ?claim=<HINT_KEY> 访问时, 自动把当前浏览器
// 身份升级为特权。换电脑/清缓存后重新打开专属链接即可恢复, 不用改配置。
const CLAIM_KEY = process.env.HINT_KEY || '';
const HINT_TOKENS_FILE = path.join(__dirname, '..', 'data', 'hint_tokens.json');

// 持久化特权 token 名单(兑换产生的), 服务重启不丢
function loadHintTokens() {
  try {
    if (!fs.existsSync(HINT_TOKENS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(HINT_TOKENS_FILE, 'utf8'));
    if (Array.isArray(raw.tokens)) {
      for (const t of raw.tokens) PRIVILEGED_TOKENS.add(t);
    }
  } catch (e) {
    console.error('[server] hint_tokens.json 读取失败:', e.message);
  }
}
function saveHintToken(token) {
  try {
    const raw = fs.existsSync(HINT_TOKENS_FILE) ? JSON.parse(fs.readFileSync(HINT_TOKENS_FILE, 'utf8')) : {};
    const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
    if (!tokens.includes(token)) tokens.push(token);
    fs.writeFileSync(HINT_TOKENS_FILE, JSON.stringify({ savedAt: Date.now(), tokens }));
  } catch (e) {
    console.error('[server] hint_tokens.json 写入失败:', e.message);
  }
}
loadHintTokens();

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// ---------- 服务器端 AI 提示引擎 ----------
// 用 worker_threads 跑引擎(独立线程), 主进程事件循环不被阻塞。
// 只保留 10 秒深度档，所有提示请求统一走 Lazy SMP。
// 特权 token 才允许调用(沿用 HINT_TOKEN / claim 兑换机制)。

import { Worker } from 'node:worker_threads';

const HINT_WORKER_COUNT = 4; // 4 个 dispatcher 分担并发; 每个深度请求内部用 4 路 Lazy SMP
const hintWorkers = []; // { worker, busy, current }

function spawnHintWorker() {
  const worker = new Worker(new URL('./hint-worker.cjs', import.meta.url), {
    workerData: { publicDir: PUBLIC_DIR },
  });
  const entry = { worker, busy: false, current: null };
  worker.on('message', (m) => {
    const q = entry.current;
    entry.current = null;
    entry.busy = false;
    if (q) q.resolve(m);
  });
  worker.on('error', (e) => respawnHintWorker(entry, `错误: ${e.message}`));
  worker.on('exit', (code) => respawnHintWorker(entry, code === 0 ? '正常退出' : `异常退出 code=${code}`));
  return entry;
}

// worker 崩溃/退出: 拒绝所有排队请求, 重建并回到池子。
// (旧实现: 重建的 worker 没 push 回 hintWorkers —— 每崩一次池子永久缩水,
// 崩 2 次后 /hint 全部 500)
function respawnHintWorker(entry, reason) {
  console.error(`[hint] worker ${reason}: 重建中`);
  if (entry.current) entry.current.reject(new Error('引擎不可用'));
  entry.current = null;
  const i = hintWorkers.indexOf(entry);
  if (i < 0) return; // 已处理过(error 与 exit 可能先后触发)
  hintWorkers.splice(i, 1);
  hintWorkers.push(spawnHintWorker());
}

for (let i = 0; i < HINT_WORKER_COUNT; i++) hintWorkers.push(spawnHintWorker());

function requestHint(board, color) {
  return new Promise((resolve, reject) => {
    // 不排队：只有立即开算才能保证端到端不超过 10 秒。4 路全忙时快速失败，
    // 避免旧棋盘请求在后台积压并继续吞掉 CPU。
    const entry = hintWorkers.find((w) => !w.busy);
    if (!entry) return reject(new Error('引擎忙, 请稍后再试'));
    const id = Math.random().toString(36).slice(2);
    entry.busy = true;
    entry.current = { id, resolve, reject };
    try {
      entry.worker.postMessage({ id, board, color });
    } catch (e) {
      entry.busy = false;
      entry.current = null;
      reject(e);
    }
  });
}

// 棋面签名: 子数 + 散列 —— 日志里能认出是哪盘棋, 又不刷满 225 个数字
function hintBoardSig(board) {
  let n = 0, h = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i]) { n++; h = (h * 33 + i * 7 + board[i]) >>> 0; }
  }
  return `${n}子/${h.toString(16)}`;
}

function handleHint(req, res) {
  // 只接受小体积 JSON (225 数字)
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8192) {
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '请求过大' }));
    }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const token = typeof body.token === 'string' ? body.token : '';
      // 特权校验: 只有白名单 token 能调用服务器 AI
      if (!PRIVILEGED_TOKENS.has(token)) {
        // v11.2: /hint 请求日志 —— 之前完全无日志, 问题再发生无从追溯
        console.log(`[hint] 拒绝: token=${token.slice(0, 8)}… 不在白名单`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '无权限' }));
      }
      const board = Array.isArray(body.board) ? body.board : null;
      const color = body.color === 1 || body.color === 2 ? body.color : 0;
      if (!board || board.length !== 225 || color === 0) {
        console.log(`[hint] 参数不合法: board=${Array.isArray(board) ? board.length + '格' : typeof board} color=${color}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '参数不合法' }));
      }
      const sig = hintBoardSig(board);
      // v11.2: /hint 请求日志 —— 之前完全无日志, 问题再发生无从追溯
      console.log(`[hint] 深度请求: token=${token.slice(0, 8)}… color=${color} ${sig}`);
      const t0 = Date.now();
      requestHint(board, color)
        .then((r) => {
          const ms = Date.now() - t0;
          console.log(`[hint] 深度完成: ${sig} ms=${ms} → ${
            r.error ? '错误: ' + r.error : `(${r.x},${r.y})`}`);
          if (r.error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: r.error }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 把 votes / incomplete 透传给前端；部分 worker 超时时仍可使用谈合结果。
          const payload = { ok: true, x: r.x, y: r.y, ms, deep: true };
          if (r.votes !== undefined) payload.votes = r.votes;
          if (r.incomplete !== undefined) payload.incomplete = r.incomplete;
          if (r.depth !== undefined) payload.depth = r.depth;
          if (r.nodes !== undefined) payload.nodes = r.nodes;
          if (r.predictedStop !== undefined) payload.predictedStop = r.predictedStop;
          if (r.value !== undefined) payload.value = r.value;
          if (r.verified !== undefined) payload.verified = r.verified;
          res.end(JSON.stringify(payload));
        })
        .catch((e) => {
          console.log(`[hint] 深度失败: ${sig} 错误: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '计算失败: ' + e.message }));
        });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '计算失败: ' + e.message }));
    }
  });
  req.on('error', () => {
    try { res.writeHead(400); res.end(); } catch {}
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    // 服务器端 AI 提示: POST /hint { board, color, token }
    // 特权 token 校验 → 10 秒深度搜索 → 返回 { x, y, ms, deep: true }
    if (pathname === '/hint' && req.method === 'POST') {
      handleHint(req, res);
      return;
    }

    // 专属链接兑换: ?claim=<HINT_KEY>&token=<现有token> → 把当前浏览器身份升级为特权。
    // 幂等: 已有合法 token 时原地升级(身份不变, 棋局座位不丢);
    // 无 token 时才生成新的。换电脑/清缓存后重新打开专属链接即可恢复。
    if (pathname === '/claim') {
      const key = url.searchParams.get('key') || '';
      if (!CLAIM_KEY || key !== CLAIM_KEY) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '密钥无效' }));
      }
      const existing = url.searchParams.get('token') || '';
      let token;
      if (/^[A-Za-z0-9_-]{8,64}$/.test(existing) && !/^hint_/.test(existing)) {
        token = existing; // 原地升级, 保持身份稳定
      } else {
        token = Array.from(crypto.randomBytes(16))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      }
      PRIVILEGED_TOKENS.add(token);
      saveHintToken(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, token }));
    }

    if (pathname === '/') pathname = '/index.html';
    // 阻断路径穿越 (../../etc/passwd)
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('forbidden');
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        // SPA 式回退: 任何未知路径都返回棋盘页, 方便直接访问 /room/xxx
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idxBuf) => {
          if (e2) {
            res.writeHead(404);
            return res.end('not found');
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(idxBuf);
        });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
      });
      res.end(buf);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('server error');
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

// roomId -> Set<ws>
const channels = new Map();

function subscribers(roomId) {
  let s = channels.get(roomId);
  if (!s) {
    s = new Set();
    channels.set(roomId, s);
  }
  return s;
}

function send(ws, type, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {
    /* 连接已断, 忽略 */
  }
}

// 向房间内所有人推送各自视角的状态(每人的 you 字段不同)
function broadcastState(roomId, extra = {}) {
  const room = store.get(roomId);
  if (!room) return;
  for (const ws of subscribers(roomId)) {
    if (ws.readyState !== ws.OPEN) continue;
    send(ws, 'state', { state: publicView(room, ws.token), ...extra });
  }
}

function broadcastPresence(roomId) {
  const room = store.get(roomId);
  if (!room) return;
  const online = new Set();
  for (const ws of subscribers(roomId)) {
    if (ws.readyState === ws.OPEN && ws.color != null) online.add(ws.color);
  }
  for (const ws of subscribers(roomId)) {
    send(ws, 'presence', { online: [...online] });
  }
}

const isValidRoomId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
const isValidToken = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.token = null;
  ws.color = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, 'error', { error: '消息格式错误' });
    }
    if (!msg || typeof msg.type !== 'string') return;

    try {
      handleMessage(ws, msg);
    } catch (e) {
      console.error('[ws] 处理消息出错:', e);
      send(ws, 'error', { error: '服务器处理出错' });
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const s = channels.get(ws.roomId);
      if (s) {
        s.delete(ws);
        if (s.size === 0) channels.delete(ws.roomId);
      }
      broadcastPresence(ws.roomId);
    }
  });

  ws.on('error', () => {
    /* 由 close 统一清理 */
  });
});

function handleMessage(ws, msg) {
  // --- 加入房间 ---
  if (msg.type === 'join') {
    if (!isValidRoomId(msg.roomId)) return send(ws, 'error', { error: '房间号不合法' });
    if (!isValidToken(msg.token)) return send(ws, 'error', { error: '身份标识不合法' });

    const roomId = msg.roomId;
    let room = store.get(roomId);
    if (!room) {
      room = createRoom(roomId);
      store.set(roomId, room);
    }

    const name = typeof msg.name === 'string' ? msg.name.slice(0, 16) : '';
    const color = claimSeat(room, msg.token, name);

    ws.roomId = roomId;
    ws.token = msg.token;
    ws.color = color;
    subscribers(roomId).add(ws);
    store.markDirty();

    // 特权身份: 仅当 token 命中白名单时, 在握手消息里附带隐藏标志。
    // 白名单在环境变量里(部署时设置), 前端拿不到名单本身。
    // AI 提示仅白名单 token 可见 —— 普通玩家永远拿不到按钮/引擎/网络痕迹。
    const isPrivileged = PRIVILEGED_TOKENS.has(msg.token);
    send(ws, 'joined', { color, state: publicView(room, msg.token), hint: isPrivileged ? 1 : 0 });
    broadcastState(roomId);
    broadcastPresence(roomId);
    return;
  }

  // 之后的所有操作都要求已入房
  const room = ws.roomId ? store.get(ws.roomId) : null;
  if (!room) return send(ws, 'error', { error: '尚未加入房间' });

  switch (msg.type) {
    case 'move': {
      const r = tryMove(room, ws.token, msg.x, msg.y);
      if (!r.ok) return send(ws, 'error', { error: r.error });
      store.markDirty();
      logGameEvent(room.id, {
        type: 'move', n: room.moves.length,
        color: colorOf(room, ws.token), x: msg.x, y: msg.y,
      });
      if (room.status === 'won') {
        logGameEvent(room.id, { type: 'end', winner: room.winner, winLine: room.winLine });
      }
      broadcastState(ws.roomId, { event: 'move', at: { x: msg.x, y: msg.y } });
      break;
    }

    case 'undo-request': {
      const r = requestUndo(room, ws.token);
      if (!r.ok) return send(ws, 'error', { error: r.error });
      store.markDirty();
      broadcastState(ws.roomId, { event: 'undo-request' });
      break;
    }

    case 'undo-reply': {
      const r = resolveUndo(room, ws.token, !!msg.accept);
      if (!r.ok) return send(ws, 'error', { error: r.error });
      store.markDirty();
      if (r.accepted) logGameEvent(room.id, { type: 'undo', by: r.by, n: r.undone });
      broadcastState(ws.roomId, {
        event: r.accepted ? 'undo-accepted' : 'undo-rejected',
      });
      break;
    }

    case 'new-game': {
      if (colorOf(room, ws.token) == null)
        return send(ws, 'error', { error: '观战者不能开新局' });
      if (room.status === 'playing' && room.moves.length > 0) {
        // 对局进行中要开新局, 需要双方都点 —— 避免一方单方面清盘
        room.newGameVotes = room.newGameVotes || {};
        room.newGameVotes[ws.token] = true;
        const votes = Object.keys(room.newGameVotes).length;
        if (votes < seatCount(room)) {
          store.markDirty();
          return broadcastState(ws.roomId, { event: 'new-game-vote' });
        }
      }
      room.newGameVotes = {};
      logGameEvent(room.id, { type: 'new-game' }); // 分段标记: 复盘脚本据此切局
      newGame(room);
      store.markDirty();
      broadcastState(ws.roomId, { event: 'new-game' });
      break;
    }

    case 'set-timer': {
      if (colorOf(room, ws.token) == null) return;
      const wasEnabled = !!room.timer?.enabled;
      room.timer = {
        enabled: !!msg.enabled,
        perMoveSec: Math.min(Math.max(parseInt(msg.perMoveSec, 10) || 60, 10), 600),
      };
      // 计时从禁用→启用 且当前在 playing → 现在开始计时; 否则保持原值
      if (room.timer.enabled && !wasEnabled && room.status === 'playing') {
        room.turnStartedAt = Date.now();
      } else if (!room.timer.enabled) {
        room.turnStartedAt = null;
      }
      room.updatedAt = Date.now();
      store.markDirty();
      broadcastState(ws.roomId, { event: 'timer' });
      break;
    }

    case 'timeout': {
      // 客户端报告超时 —— 服务端复核后才采信。
      // v11.5+: 服务端每 5s 也会独立扫描, 即使客户端关闭/掉线也能判负。
      // 这里保留客户端即时上报路径 —— 用户体验上更跟手 (RAF 倒计时归零立即判负, 不必等服务端 5s 扫描)。
      if (!room.timer?.enabled || room.status !== 'playing') return;
      const color = colorOf(room, ws.token);
      if (color == null || room.turn !== color) return;
      // 超时判负: 由超时方自己上报, 不给对方伪造的机会
      room.status = 'won';
      room.winner = room.turn === 1 ? 2 : 1;
      room.winLine = null;
      room.turnStartedAt = null;
      const winToken = tokenOf(room, room.winner);
      if (winToken) room.score[winToken] = (room.score[winToken] || 0) + 1;
      room.updatedAt = Date.now();
      logGameEvent(room.id, { type: 'end', winner: room.winner, winLine: null, reason: 'timeout' });
      store.markDirty();
      broadcastState(ws.roomId, { event: 'timeout' });
      break;
    }

    case 'chat-emoji': {
      // 轻量互动: 只允许固定几个表情, 不做自由文本(你们有微信)
      const allowed = ['👏', '😄', '😮', '🤔', '❤️', '😭'];
      if (!allowed.includes(msg.emoji)) return;
      for (const peer of subscribers(ws.roomId)) {
        send(peer, 'emoji', { emoji: msg.emoji, from: ws.color });
      }
      break;
    }

    case 'ping':
      send(ws, 'pong', {});
      break;

    default:
      send(ws, 'error', { error: '未知指令' });
  }
}

// ---------- 心跳: 清除半开连接 ----------
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);

// ---------- 定期清理 + 落盘 ----------
const janitor = setInterval(() => {
  store.prune(ROOM_TTL);
  store.flush();
}, 60 * 60 * 1000);

// ---------- 服务端超时检查器 ----------
// v11.5+: 即使客户端关闭/掉线, 服务端也能按时判负 —— 不再依赖客户端上报。
// 5s 扫描一次所有房间: playing + 计时启用 + 超过限时 → 当前回合方判负。
// 老存档加载后 turnStartedAt 可能为 undefined, 这里用 `== null` 同时兜住 undefined。
const TIMEOUT_CHECK_MS = 5000;
const timeoutChecker = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of store.rooms) {
    if (room.status !== 'playing') continue;
    if (!room.timer?.enabled) continue;
    if (room.turnStartedAt == null) continue; // 老房间未初始化, 等下次落子
    const limit = (room.timer.perMoveSec || 60) * 1000;
    if (now - room.turnStartedAt < limit) continue;

    // 超时: 当前回合方判负
    const loserColor = room.turn;
    const winnerColor = loserColor === BLACK ? WHITE : BLACK;
    room.status = 'won';
    room.winner = winnerColor;
    room.winLine = null;
    room.turnStartedAt = null;
    room.updatedAt = now;
    const winToken = tokenOf(room, winnerColor);
    if (winToken) room.score[winToken] = (room.score[winToken] || 0) + 1;
    logGameEvent(room.id, {
      type: 'end', winner: winnerColor, winLine: null, reason: 'timeout-server',
    });
    store.markDirty();
    broadcastState(roomId, { event: 'timeout' });
    console.log(`[server] 超时判负: room=${roomId} loser=${loserColor} winner=${winnerColor}`);
  }
}, TIMEOUT_CHECK_MS);

// ---------- 优雅退出 ----------
function shutdown(sig) {
  console.log(`[server] 收到 ${sig}, 正在保存并退出...`);
  clearInterval(heartbeat);
  clearInterval(janitor);
  clearInterval(timeoutChecker);
  store.flushSync();
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server restarting');
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 未捕获异常不能让进程静默死掉 —— 先落盘再交给 systemd 重启
process.on('uncaughtException', (e) => {
  console.error('[server] 未捕获异常:', e);
  try {
    store.flushSync();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[server] 五子棋服务已启动 http://${HOST}:${PORT}`);
  console.log(`[server] 存档: ${DATA_FILE}`);
});
