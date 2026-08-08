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
import { Store } from './store.js';
import {
  createRoom,
  claimSeat,
  colorOf,
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

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
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
    // AI 提示功能对所有人开放
    // AI 提示: 仅白名单 token 可见(你的专属, 其他人看不到)
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
      newGame(room);
      store.markDirty();
      broadcastState(ws.roomId, { event: 'new-game' });
      break;
    }

    case 'set-timer': {
      if (colorOf(room, ws.token) == null) return;
      room.timer = {
        enabled: !!msg.enabled,
        perMoveSec: Math.min(Math.max(parseInt(msg.perMoveSec, 10) || 60, 10), 600),
      };
      room.updatedAt = Date.now();
      store.markDirty();
      broadcastState(ws.roomId, { event: 'timer' });
      break;
    }

    case 'timeout': {
      // 客户端报告超时 —— 服务端复核回合与计时开关后才采信
      if (!room.timer?.enabled || room.status !== 'playing') return;
      const color = colorOf(room, ws.token);
      if (color == null || room.turn !== color) return;
      // 超时判负: 由超时方自己上报, 不给对方伪造的机会
      room.status = 'won';
      room.winner = room.turn === 1 ? 2 : 1;
      room.winLine = null;
      room.updatedAt = Date.now();
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

// ---------- 优雅退出 ----------
function shutdown(sig) {
  console.log(`[server] 收到 ${sig}, 正在保存并退出...`);
  clearInterval(heartbeat);
  clearInterval(janitor);
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
