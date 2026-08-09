/* 五子棋前端 — Canvas 渲染 + WebSocket 实时同步
 *
 * 稳定性要点:
 *   - 指数退避自动重连, 网络抖动/切 WiFi/手机息屏回来都能自愈
 *   - 身份 token 存 localStorage, 刷新页面不丢座位
 *   - 服务端是唯一权威, 本地只做乐观预览, 以服务端状态为准
 */
'use strict';

const SIZE = 15;
const EMPTY = 0, BLACK = 1, WHITE = 2;

// ---------- 本地身份 ----------
function getToken() {
  let t = localStorage.getItem('gomoku.token');
  if (!t || !/^[A-Za-z0-9_-]{8,64}$/.test(t)) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    t = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('gomoku.token', t);
  }
  return t;
}
let TOKEN = getToken();

// ---------- 专属链接兑换特权 ----------
// 打开带 ?claim=<密钥> 的链接时, 自动把当前浏览器身份升级为特权(AI 提示可见)。
// 换电脑/清缓存后重新打开专属链接即可恢复, 无需改服务器配置。
// 兑换成功后把 key 从 URL 里去掉, 防止密钥留在地址栏。
(async function claimPrivilege() {
  const claim = new URLSearchParams(location.search).get('claim');
  if (!claim) return;
  try {
    // 带上现有 token: 服务器原地升级特权, 身份/棋局座位不丢
    const resp = await fetch('/claim?key=' + encodeURIComponent(claim) + '&token=' + encodeURIComponent(TOKEN));
    const data = await resp.json();
    if (data.ok && data.token) {
      if (data.token !== TOKEN) {
        localStorage.setItem('gomoku.token', data.token);
        TOKEN = data.token;
      }
      toast('已激活专属 AI 提示');
    } else {
      toast('专属链接无效', 3000);
    }
  } catch {
    toast('专属链接激活失败, 请检查网络', 3000);
  }
  // 无论成败都去掉密钥参数, 避免残留
  const url = new URL(location.href);
  url.searchParams.delete('claim');
  history.replaceState(null, '', url);
})();

// ---------- 元素 ----------
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), app = $('app');
const canvas = $('board'), cctx = canvas.getContext('2d');
const statusBar = $('statusBar'), toastEl = $('toast');

// ---------- 状态 ----------
let ws = null;
let roomId = '';
let myName = '';
let myColor = null;
let state = null;
let online = [];
let soundOn = true;
let reconnectAttempt = 0;
let reconnectTimer = null;
let manualClose = false;

// 渲染用
let hoverCell = null;
let placeAnim = null;   // { x, y, color, start }
let winAnim = null;     // { start }
let dpr = 1, cell = 0, pad = 0, boardPx = 0;

// 提示引擎状态
let hintOn = false;          // 提示开关
let hintMark = null;         // { x, y }  本地计算的推荐落点, 仅本地渲染
let hintHighlightUntil = 0;  // 显示持续到某时刻(给"闪烁"留时间)
let hintDeep = false;        // 深度模式(长按触发, 常驻直到关闭/落子)

// 计时
let timerDeadline = null;
let timerRaf = null;

// ================= 音效 =================
let actx = null;
function audio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function tone({ freq = 440, dur = 0.1, type = 'sine', vol = 0.25, delay = 0 }) {
  if (!soundOn) return;
  const c = audio(); if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator(), g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
const SFX = {
  // 落子: 木头相碰的短促闷响
  place() { tone({ freq: 320, dur: 0.08, type: 'triangle', vol: 0.3 });
            tone({ freq: 170, dur: 0.13, type: 'sine', vol: 0.22 }); },
  win()   { [523, 659, 784, 1047].forEach((f, i) =>
              tone({ freq: f, dur: 0.32, type: 'sine', vol: 0.3, delay: i * 0.11 })); },
  lose()  { [392, 330, 262].forEach((f, i) =>
              tone({ freq: f, dur: 0.36, type: 'sine', vol: 0.24, delay: i * 0.14 })); },
  notify(){ tone({ freq: 660, dur: 0.1, type: 'sine', vol: 0.2 });
            tone({ freq: 880, dur: 0.12, type: 'sine', vol: 0.16, delay: 0.1 }); },
  err()   { tone({ freq: 180, dur: 0.14, type: 'sawtooth', vol: 0.16 }); },
};

// ================= 胜利特效(粒子) =================
function spawnVictory() {
  // 创建覆盖层
  const layer = document.createElement('div');
  layer.className = 'victory-layer';
  document.body.appendChild(layer);
  // 60 颗暖金粒子, 2.5 秒后清掉
  const colors = ['#d8a657', '#f3dca6', '#b07a36', '#e8be7a', '#fff'];
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('div');
    p.className = 'victory-particle';
    p.style.background = colors[i % colors.length];
    p.style.left = (Math.random() * 100) + 'vw';
    p.style.top = '-10px';
    p.style.animationDelay = (Math.random() * 0.8) + 's';
    p.style.animationDuration = (1.8 + Math.random() * 1.2) + 's';
    p.style.boxShadow = `0 0 6px ${colors[i % colors.length]}`;
    layer.appendChild(p);
  }
  setTimeout(() => layer.remove(), 3500);
}

// 落子高光: 在 (x,y) 棋盘坐标位置闪一道金色脉冲
function flashMove(x, y) {
  const wrap = document.getElementById('board')?.parentElement;
  if (!wrap) return;
  const SIZE = 15, rect = wrap.getBoundingClientRect();
  const cell = rect.width / (SIZE - 1 + 2 * 0.04);
  // 棋盘 padding: 与 draw 里的 pad 等比
  const pad = rect.width * 0.04;
  const px = (rect.left + pad + x * (rect.width - 2 * pad) / (SIZE - 1)) - rect.left;
  const py = (rect.top + pad + y * (rect.width - 2 * pad) / (SIZE - 1)) - rect.top;
  const g = document.createElement('div');
  g.className = 'move-glow';
  g.style.left = (px / rect.width * 100) + '%';
  g.style.top = (py / rect.height * 100) + '%';
  wrap.appendChild(g);
  setTimeout(() => g.remove(), 850);
}

// ================= 提示 =================
let toastTimer = null;
function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ================= 木纹棋盘 =================
// 木纹用确定性伪随机生成, 保证每次重绘纹理一致(不会闪)
let woodCanvas = null;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWood(px) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const rnd = mulberry32(20240807);

  // 底色渐变
  const base = g.createLinearGradient(0, 0, px, px);
  base.addColorStop(0, '#dcae72');
  base.addColorStop(0.45, '#cf9c57');
  base.addColorStop(1, '#c08c48');
  g.fillStyle = base;
  g.fillRect(0, 0, px, px);

  // 年轮纹理: 一族横向缓慢起伏的曲线
  g.lineCap = 'round';
  for (let i = 0; i < 46; i++) {
    const y0 = rnd() * px;
    const amp = 5 + rnd() * 16;
    const period = 140 + rnd() * 240;
    const w = 0.7 + rnd() * 2.2;
    const dark = rnd() > 0.42;
    g.strokeStyle = dark
      ? `rgba(120, 78, 38, ${0.05 + rnd() * 0.1})`
      : `rgba(240, 205, 158, ${0.05 + rnd() * 0.09})`;
    g.lineWidth = w;
    g.beginPath();
    for (let x = 0; x <= px; x += 5) {
      const y = y0 + Math.sin((x / period) * Math.PI * 2 + i) * amp
                   + Math.sin((x / (period * 0.37)) * Math.PI * 2) * amp * 0.25;
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  }

  // 细密竖向丝纹, 增加"实木"的颗粒感
  for (let i = 0; i < 240; i++) {
    const x = rnd() * px, y = rnd() * px;
    const h = 8 + rnd() * 40;
    g.strokeStyle = `rgba(110, 72, 34, ${0.015 + rnd() * 0.035})`;
    g.lineWidth = 0.6 + rnd() * 0.8;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 5, y + h); g.stroke();
  }

  // 边缘压暗, 形成中间亮的球面感
  const vig = g.createRadialGradient(px / 2, px / 2, px * 0.28, px / 2, px / 2, px * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(58,32,10,.30)');
  g.fillStyle = vig;
  g.fillRect(0, 0, px, px);

  return c;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  boardPx = Math.round(rect.width * dpr);
  canvas.width = boardPx;
  canvas.height = boardPx;
  pad = boardPx * 0.052;
  cell = (boardPx - pad * 2) / (SIZE - 1);
  woodCanvas = buildWood(boardPx);
  draw();
}

const gx = (x) => pad + x * cell;
const gy = (y) => pad + y * cell;

function draw() {
  if (!boardPx) return;
  const g = cctx;
  const now = performance.now();
  g.clearRect(0, 0, boardPx, boardPx);

  if (woodCanvas) g.drawImage(woodCanvas, 0, 0);

  // 网格线 —— 内侧细描一层浅色, 模拟刻线的凹陷感
  g.strokeStyle = 'rgba(252, 228, 194, .16)';
  g.lineWidth = Math.max(1, dpr * 0.9);
  g.beginPath();
  for (let i = 0; i < SIZE; i++) {
    g.moveTo(gx(i) + 0.7, gy(0) + 0.7); g.lineTo(gx(i) + 0.7, gy(SIZE - 1) + 0.7);
    g.moveTo(gx(0) + 0.7, gy(i) + 0.7); g.lineTo(gx(SIZE - 1) + 0.7, gy(i) + 0.7);
  }
  g.stroke();

  g.strokeStyle = 'rgba(62, 36, 14, .62)';
  g.lineWidth = Math.max(1, dpr * 0.9);
  g.beginPath();
  for (let i = 0; i < SIZE; i++) {
    g.moveTo(gx(i), gy(0)); g.lineTo(gx(i), gy(SIZE - 1));
    g.moveTo(gx(0), gy(i)); g.lineTo(gx(SIZE - 1), gy(i));
  }
  g.stroke();

  // 外框加粗
  g.lineWidth = Math.max(1.6, dpr * 1.7);
  g.strokeRect(gx(0), gy(0), cell * (SIZE - 1), cell * (SIZE - 1));

  // 星位(天元 + 四角)
  const stars = [[3,3],[11,3],[3,11],[11,11],[7,7]];
  g.fillStyle = 'rgba(52, 30, 12, .8)';
  for (const [sx, sy] of stars) {
    g.beginPath();
    g.arc(gx(sx), gy(sy), Math.max(2.2, cell * 0.075), 0, Math.PI * 2);
    g.fill();
  }

  if (!state) return;

  // 悬停预览
  if (hoverCell && canPlay() && state.board[hoverCell.y * SIZE + hoverCell.x] === EMPTY) {
    g.globalAlpha = 0.32;
    drawStone(g, hoverCell.x, hoverCell.y, myColor, 1);
    g.globalAlpha = 1;
  }

  // 提示标记(纯本地, 淡黄圆环 + 中心点, 缓缓呼吸)
  if (hintMark && performance.now() < hintHighlightUntil && state.status === 'playing') {
    const cx = gx(hintMark.x), cy = gy(hintMark.y);
    const pulse = 0.6 + Math.sin(now / 320) * 0.25;
    g.save();
    g.strokeStyle = `rgba(255, 200, 90, ${pulse})`;
    g.lineWidth = Math.max(2, dpr * 2.4);
    g.shadowColor = 'rgba(255, 200, 90, .7)';
    g.shadowBlur = 14 * dpr * pulse;
    g.beginPath();
    g.arc(cx, cy, cell * 0.36, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = `rgba(255, 200, 90, ${pulse * 0.9})`;
    g.beginPath();
    g.arc(cx, cy, Math.max(2, cell * 0.07), 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // 棋子
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = state.board[y * SIZE + x];
      if (v === EMPTY) continue;
      let scale = 1;
      if (placeAnim && placeAnim.x === x && placeAnim.y === y) {
        const t = Math.min((now - placeAnim.start) / 190, 1);
        // 轻微回弹, 像棋子落在木板上
        scale = t < 1 ? 0.55 + 0.55 * t + Math.sin(t * Math.PI) * 0.12 : 1;
      }
      drawStone(g, x, y, v, scale);
    }
  }

  // 最后一手标记
  if (state.lastMove && !state.winLine) {
    const { x, y } = state.lastMove;
    g.strokeStyle = state.lastMove.color === BLACK
      ? 'rgba(255, 214, 140, .95)' : 'rgba(150, 90, 40, .95)';
    g.lineWidth = Math.max(1.6, dpr * 1.8);
    g.beginPath();
    g.arc(gx(x), gy(y), cell * 0.2, 0, Math.PI * 2);
    g.stroke();
  }

  // 胜利连线高亮
  if (state.winLine && state.winLine.length) {
    const t = winAnim ? Math.min((now - winAnim.start) / 420, 1) : 1;
    const pulse = 0.55 + Math.sin(now / 260) * 0.3;

    const a = state.winLine[0], b = state.winLine[state.winLine.length - 1];
    g.save();
    g.strokeStyle = `rgba(255, 226, 150, ${0.55 * t})`;
    g.lineWidth = cell * 0.16;
    g.lineCap = 'round';
    g.shadowColor = 'rgba(255, 200, 90, .9)';
    g.shadowBlur = 22 * dpr * pulse;
    g.beginPath();
    g.moveTo(gx(a[0]), gy(a[1]));
    g.lineTo(gx(a[0]) + (gx(b[0]) - gx(a[0])) * t, gy(a[1]) + (gy(b[1]) - gy(a[1])) * t);
    g.stroke();
    g.restore();

    for (const [x, y] of state.winLine) {
      g.save();
      g.strokeStyle = `rgba(255, 232, 168, ${pulse})`;
      g.lineWidth = Math.max(2, dpr * 2.2);
      g.shadowColor = 'rgba(255,200,90,.8)';
      g.shadowBlur = 14 * dpr;
      g.beginPath();
      g.arc(gx(x), gy(y), cell * 0.42, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }
}

// 立体棋子: 底部投影 + 主体径向渐变 + 高光
function drawStone(g, x, y, color, scale = 1) {
  const cx = gx(x), cy = gy(y);
  const r = cell * 0.435 * scale;
  if (r <= 0) return;

  // 投影
  g.save();
  g.beginPath();
  g.ellipse(cx + r * 0.1, cy + r * 0.2, r * 0.98, r * 0.9, 0, 0, Math.PI * 2);
  g.fillStyle = 'rgba(40, 22, 6, .42)';
  g.filter = 'blur(0px)';
  g.fill();
  g.restore();

  // 主体
  const grd = g.createRadialGradient(
    cx - r * 0.34, cy - r * 0.38, r * 0.08,
    cx, cy, r * 1.06
  );
  if (color === BLACK) {
    grd.addColorStop(0, '#7d7d7d');
    grd.addColorStop(0.34, '#3a3a3a');
    grd.addColorStop(1, '#0d0d0d');
  } else {
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.42, '#f2ece1');
    grd.addColorStop(1, '#bfb3a1');
  }
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = grd;
  g.fill();

  // 边缘暗环, 增加体积
  g.strokeStyle = color === BLACK ? 'rgba(0,0,0,.55)' : 'rgba(140,128,110,.5)';
  g.lineWidth = Math.max(0.6, dpr * 0.6);
  g.stroke();

  // 高光
  g.save();
  g.beginPath();
  g.ellipse(cx - r * 0.33, cy - r * 0.36, r * 0.3, r * 0.2, -0.7, 0, Math.PI * 2);
  g.fillStyle = color === BLACK ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.85)';
  g.fill();
  g.restore();
}

// 需要动画时才持续重绘, 空闲时不占 CPU
function loop() {
  const need = (placeAnim && performance.now() - placeAnim.start < 260)
            || (state && state.winLine && state.winLine.length)
            || (hintMark && performance.now() < hintHighlightUntil);
  if (placeAnim && performance.now() - placeAnim.start >= 260) placeAnim = null;
  if (need) { draw(); requestAnimationFrame(loop); }
  else draw();
}

// ================= 交互 =================
function canPlay() {
  return state && state.status === 'playing' && myColor != null && state.turn === myColor;
}

function posToCell(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const x = Math.round((px - pad) / cell);
  const y = Math.round((py - pad) / cell);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  // 离交叉点太远不算(防误触)
  if (Math.hypot(px - gx(x), py - gy(y)) > cell * 0.52) return null;
  return { x, y };
}

canvas.addEventListener('mousemove', (e) => {
  const c = posToCell(e);
  const changed = (!c !== !hoverCell) || (c && hoverCell && (c.x !== hoverCell.x || c.y !== hoverCell.y));
  hoverCell = c;
  if (changed) draw();
});
canvas.addEventListener('mouseleave', () => { hoverCell = null; draw(); });

canvas.addEventListener('click', (e) => {
  const c = posToCell(e);
  if (!c) return;
  if (!state) return;
  if (myColor == null) return toast('你是观战者');
  if (state.status !== 'playing') {
    return toast(state.status === 'waiting' ? '等对方进来才能开始' : '本局已结束');
  }
  if (state.turn !== myColor) return toast('还没轮到你');
  if (state.board[c.y * SIZE + c.x] !== EMPTY) return toast('这里已经有子了');
  send({ type: 'move', x: c.x, y: c.y });
});

// 触屏
canvas.addEventListener('touchend', (e) => {
  if (e.changedTouches.length !== 1) return;
  const t = e.changedTouches[0];
  const c = posToCell(t);
  if (!c) return;
  e.preventDefault();
  canvas.dispatchEvent(new MouseEvent('click', { clientX: t.clientX, clientY: t.clientY }));
}, { passive: false });

// ================= WebSocket =================
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  manualClose = false;
  setStatus('正在连接…');

  try { ws = new WebSocket(wsURL()); }
  catch { return scheduleReconnect(); }

  ws.onopen = () => {
    reconnectAttempt = 0;
    send({ type: 'join', roomId, token: TOKEN, name: myName });
  };

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };

  ws.onclose = () => {
    if (manualClose) return;
    setStatus('连接断开，正在重连…', 'warn');
    markAllOffline();
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose 会接手 */ };
}

function scheduleReconnect() {
  reconnectAttempt++;
  // 指数退避, 上限 8 秒 —— 兼顾及时性和不打爆服务器
  const delay = Math.min(600 * Math.pow(1.6, reconnectAttempt - 1), 8000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('还没连上，请稍候');
  try { ws.send(JSON.stringify(obj)); } catch { toast('发送失败'); }
}

function handle(m) {
  switch (m.type) {
    case 'joined':
      myColor = m.color;
      state = m.state;
      if (m.color == null) toast('房间已满，你正在观战', 3000);
      // 仅特权身份(hint===1)创建提示按钮, 其他人没有
      if (m.hint === 1 && !hintEnabled) {
        hintEnabled = true;
        createHintButton();
      }
      render();
      break;

    case 'state': {
      const prev = state;
      state = m.state;
      if (myColor == null && state.you != null) myColor = state.you;

      if (m.event === 'move' && m.at) {
        placeAnim = { x: m.at.x, y: m.at.y, start: performance.now() };
        SFX.place();
        flashMove(m.at.x, m.at.y); // 落子高光
        // 对方落子后, 如果提示还开着, 自动刷新建议
        autoRefreshHint();
      }
      if (m.event === 'undo-request' && state.undoRequest && state.undoRequest.by !== myColor) {
        showUndoModal();
        SFX.notify();
      }
      if (m.event === 'undo-accepted') toast('悔棋已生效');
      if (m.event === 'undo-rejected') toast('对方不同意悔棋');
      if (m.event === 'new-game') { winAnim = null; toast('新的一局，先手已交换'); resetHint(); autoRefreshHint(); }
      if (m.event === 'new-game-vote') toast('等待对方确认开新局…');
      if (m.event === 'timeout') toast('超时判负');

      // 刚分出胜负
      const justEnded = (!prev || prev.status === 'playing') &&
                        (state.status === 'won' || state.status === 'draw');
      if (justEnded) {
        winAnim = { start: performance.now() };
        showOver();
        if (state.status === 'won') {
          state.winner === myColor ? SFX.win() : SFX.lose();
          spawnVictory(); // 胜利粒子
        }
        // 胜负已分, 提示清除
        resetHint();
      }
      resetTurnTimer();
      render();
      loop();
      break;
    }

    case 'presence':
      online = m.online || [];
      render();
      break;

    case 'emoji':
      flyEmoji(m.emoji);
      break;

    case 'error':
      toast(m.error || '出错了');
      SFX.err();
      break;
  }
}

function markAllOffline() {
  online = [];
  render();
}

// ================= 渲染 UI =================
function setStatus(text, cls = '') {
  statusBar.textContent = text;
  statusBar.className = 'status' + (cls ? ' ' + cls : '');
}

function render() {
  if (!state) return;

  // 玩家条
  for (const [color, el] of [[BLACK, $('pBlack')], [WHITE, $('pWhite')]]) {
    const name = (state.names && state.names[color]) || (color === BLACK ? '黑方' : '白方');
    el.querySelector('.pname').textContent = name;
    el.querySelector('.pscore').textContent = (state.score && state.score[color]) || 0;
    const isOn = online.includes(color);
    el.classList.toggle('online', isOn);
    el.classList.toggle('is-you', myColor === color);
    el.classList.toggle('active', state.status === 'playing' && state.turn === color);
    el.querySelector('.pstat').textContent = isOn ? '在线' : '离线';
  }

  // 状态文案
  if (state.status === 'waiting') {
    setStatus('等待对方进入棋室…', 'warn');
    showMask('把棋室名发给对方<br>你们就能一起下了');
  } else if (state.status === 'won') {
    const who = (state.names && state.names[state.winner]) || (state.winner === BLACK ? '黑方' : '白方');
    setStatus(state.winner === myColor ? `你赢了 · ${who}五连` : `${who}获胜`);
    hideMask();
  } else if (state.status === 'draw') {
    setStatus('和棋 · 棋盘已满');
    hideMask();
  } else {
    const yourTurn = state.turn === myColor;
    if (myColor == null) {
      setStatus(`观战中 · 轮到${state.turn === BLACK ? '黑方' : '白方'}`);
    } else {
      setStatus(yourTurn ? '轮到你落子' : '等待对方落子…', yourTurn ? 'warn' : '');
    }
    hideMask();
  }

  // 按钮可用性
  $('undoBtn').disabled = !(state.moves > 0 && myColor != null && !state.undoRequest);
  $('newBtn').disabled = myColor == null;
  const tm = state.timer || { enabled: false, perMoveSec: 60 };
  $('timerBtn').textContent = tm.enabled ? `计时 ${tm.perMoveSec}s` : '计时 关';

  $('roomName').textContent = state.id || roomId;
  draw();
}

function showMask(html) {
  const m = $('boardMask');
  m.querySelector('.mask-text').innerHTML = html;
  m.classList.remove('hidden');
}
function hideMask() { $('boardMask').classList.add('hidden'); }

// ================= 计时 =================
function resetTurnTimer() {
  cancelAnimationFrame(timerRaf);
  timerDeadline = null;
  if (!state || !state.timer || !state.timer.enabled || state.status !== 'playing') return;
  timerDeadline = Date.now() + state.timer.perMoveSec * 1000;
  tickTimer();
}

function tickTimer() {
  if (!timerDeadline || !state || state.status !== 'playing') return;
  const left = Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000));
  const mine = state.turn === myColor;
  setStatus(
    (mine ? '轮到你落子' : '等待对方落子…') + ` · ${left}s`,
    left <= 10 ? 'err' : (mine ? 'warn' : '')
  );
  if (left <= 0) {
    // 只有轮到自己时才上报超时 —— 避免双方同时上报
    if (mine) send({ type: 'timeout' });
    timerDeadline = null;
    return;
  }
  timerRaf = requestAnimationFrame(tickTimer);
}

// ================= 弹窗 =================
function showUndoModal() {
  const by = state.undoRequest.by;
  const name = (state.names && state.names[by]) || (by === BLACK ? '黑方' : '白方');
  $('undoText').textContent = `${name} 想要悔棋，同意后将退回其上一手。`;
  $('undoModal').classList.remove('hidden');
}
$('undoYes').onclick = () => { send({ type: 'undo-reply', accept: true }); $('undoModal').classList.add('hidden'); };
$('undoNo').onclick  = () => { send({ type: 'undo-reply', accept: false }); $('undoModal').classList.add('hidden'); };

function showOver() {
  const icon = $('overIcon'), title = $('overTitle'), sub = $('overSub');
  if (state.status === 'draw') {
    icon.textContent = '🤝'; title.textContent = '和棋';
    sub.textContent = '棋盘下满了，谁也没能连成五子。';
  } else {
    const win = state.winner === myColor;
    const name = (state.names && state.names[state.winner]) ||
                 (state.winner === BLACK ? '黑方' : '白方');
    icon.textContent = win ? '🎉' : '🌙';
    title.textContent = win ? '你赢了' : `${name} 获胜`;
    sub.textContent = win ? '五子连珠，漂亮。' : '再来一局，先手会交换。';
  }
  $('overModal').classList.remove('hidden');
}
$('overClose').onclick = () => $('overModal').classList.add('hidden');
$('overNew').onclick = () => { $('overModal').classList.add('hidden'); send({ type: 'new-game' }); };

// ================= 特权提示(仅服务端白名单身份可见) =================

// ================= 特权提示(仅服务端白名单身份可见) =================
// 普通玩家的浏览器: 没有按钮、没有引擎、没有网络痕迹 —— 整个功能不存在。
// 只有 joined.hint===1 时(服务端按 token 白名单判定)才动态创建一切。
let hintEnabled = false;     // 本次会话是否有特权

// 动态创建提示按钮(普通玩家永远不会执行到这里)
function createHintButton() {
  const row = document.createElement('div');
  row.className = 'hint-row';
  const btn = document.createElement('button');
  btn.id = 'hintBtn';
  btn.className = 'btn-hint';
  btn.textContent = '💡 提示';
  btn.title = '点击: 普通提示(快) · 长按: 深度提示(最强)';

  function setDeepUI(on) {
    btn.classList.toggle('deep', on);
    btn.textContent = on ? '🧠 深度 开' : (hintOn ? '💡 提示 开' : '💡 提示');
  }

  // 长按 600ms → 深度提示; 松开早于 600ms → 普通提示
  let pressTimer = null;
  let longPressFired = false;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    longPressFired = false;
    pressTimer = setTimeout(() => {
      longPressFired = true;
      btn.classList.add('deep-press');
      btn.textContent = '🧠 深度计算中…';
      showHint(true);
    }, 600);
  });
  btn.addEventListener('pointerup', () => {
    clearTimeout(pressTimer);
    if (!longPressFired) {
      // 单击 → 开关/普通提示
      if (hintDeep) {
        // 深度模式开着, 单击关闭
        hintDeep = false;
        hintOn = false;
        btn.classList.remove('active');
        setDeepUI(false);
        hintMark = null;
        hintHighlightUntil = 0;
        draw();
        return;
      }
      if (!hintOn) {
        hintOn = true;
        btn.classList.add('active');
        btn.textContent = '💡 提示 开';
      } else {
        hintOn = false;
        btn.classList.remove('active');
        btn.textContent = '💡 提示';
        hintMark = null;
        hintHighlightUntil = 0;
        draw();
        return;
      }
      showHint(false);
    } else {
      btn.classList.remove('deep-press');
      // 深度计算成功后由 showHint 设置常驻 UI, 这里只清掉"计算中"临时态
      if (!hintDeep) setDeepUI(false);
    }
  });
  btn.addEventListener('pointerleave', () => {
    clearTimeout(pressTimer);
    btn.classList.remove('deep-press');
    if (!longPressFired && !hintDeep && !hintOn) btn.textContent = '💡 提示';
  });
  btn.addEventListener('pointercancel', () => {
    clearTimeout(pressTimer);
    btn.classList.remove('deep-press');
  });
  row.appendChild(btn);
  document.querySelector('.toolbar').after(row);
  return btn;
}

// 按需加载提示引擎(只有特权用户才会触发)
// v9: Web Worker 后台搜索 — 主线程不卡, 预算 3 秒, 深度 8
let hintWorker = null;
let hintWorkerBusy = false;
let hintWorkerQueue = null; // 排队中的请求 { board, color, resolve }
function loadHintEngine() {
  return new Promise((resolve, reject) => {
    if (self.GomokuHint && hintWorker) return resolve();
    if (!hintWorker) {
      try {
        hintWorker = new Worker('/worker.js');
        hintWorker.onmessage = (ev) => {
          hintWorkerBusy = false;
          const { x, y, error } = ev.data || {};
          if (hintWorkerQueue) {
            const q = hintWorkerQueue;
            hintWorkerQueue = null;
            if (error) q.reject(new Error(error));
            else q.resolve({ x, y });
          }
        };
        hintWorker.onerror = () => {
          hintWorkerBusy = false;
          if (hintWorkerQueue) {
            const q = hintWorkerQueue;
            hintWorkerQueue = null;
            q.reject(new Error('Worker 错误'));
          }
        };
      } catch {
        hintWorker = null;
      }
    }
    // 同步引擎(备用, Worker 不可用时回退)
    if (!hintWorker) {
      if (self.GomokuHint) return resolve();
      const s = document.createElement('script');
      s.src = '/hint.js?v=12';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('引擎加载失败'));
      document.head.appendChild(s);
      return;
    }
    resolve();
  });
}

// 计算最佳落点: 服务器端 AI 优先(3s 普通 / 15s 深度), 失败/超时回退本地 Worker
function computeHintAsync(board, color, deep) {
  // 超时: 普通 8s, 深度 30s → 回退本地
  const timeoutMs = deep ? 30000 : 8000;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('hint timeout')), timeoutMs));
  return Promise.race([
    fetch('/hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board, color, token: TOKEN, deep: deep === true }),
    })
      .then((resp) => {
        if (!resp.ok) throw new Error('hint ' + resp.status);
        return resp.json();
      })
      .then((data) => {
        if (!data.ok || typeof data.x !== 'number' || typeof data.y !== 'number') throw new Error('hint bad');
        return { x: data.x, y: data.y, server: true, deep: data.deep === true };
      }),
    timeout,
  ])
    .catch((e) => {
      // 回退本地 Worker (断网 / 服务器挂了 / 无权限 / 超时都走这里)
      return computeHintLocal(board, color).then((r) => ({ ...r, server: false }));
    });
}

// 原本地 Worker 计算逻辑 (兜底)
function computeHintLocal(board, color) {
  return new Promise((resolve, reject) => {
    if (!hintWorker) {
      // 回退同步
      try {
        const r = self.GomokuHint.computeBest(board, color);
        resolve(r);
      } catch (e) { reject(e); }
      return;
    }
    if (hintWorkerBusy) { reject(new Error('搜索进行中')); return; }
    hintWorkerBusy = true;
    hintWorkerQueue = { resolve, reject };
    hintWorker.postMessage({ board, color });
  });
}

// 重置提示状态(落子/新对局/胜负/关闭时调用)
function resetHint() {
  hintMark = null;
  hintHighlightUntil = 0;
  hintDeep = false;
  hintOn = false;
  const btn = document.getElementById('hintBtn');
  if (btn) {
    btn.classList.remove('active', 'deep', 'deep-press');
    btn.textContent = '💡 提示';
  }
}

// 显示提示: 服务器优先, 本地回退
async function showHint(deep) {
  if (!hintEnabled) return;
  if (!state || state.status !== 'playing') {
    toast('对局未开始'); return;
  }
  try {
    await loadHintEngine();
    const { x, y, server, deep: isDeep } = await computeHintAsync(state.board, state.turn, deep);
    if (state.board[y * SIZE + x] !== EMPTY) { toast('提示暂不可用'); return; }
    hintMark = { x, y };
    if (isDeep) {
      // 深度模式: 提示常驻显示(不自动消失), 按钮切到"深度 开"
      hintDeep = true;
      hintHighlightUntil = Infinity;
      const btn = document.getElementById('hintBtn');
      if (btn) {
        btn.classList.remove('deep-press');
        btn.classList.add('active', 'deep');
        btn.textContent = '🧠 深度 开';
      }
    } else {
      hintHighlightUntil = performance.now() + 8000;
    }
    const tag = server ? (isDeep ? '🧠 深度' : '🤖 普通') : '📱 本地';
    toast(`${tag} 建议 (${x + 1}, ${y + 1})`, 2500);
    draw();
    loop();
  } catch {
    toast('提示引擎不可用');
  }
}

// 每次 state 更新后, 若提示开着则自动刷新
function autoRefreshHint() {
  // 提示开着才自动刷新(落子后)
  if (!hintEnabled || !(hintOn || hintDeep) || !state || state.status !== 'playing') return;
  // 深度模式: 每次落子自动重新深算(常驻, 不重置按钮)
  showHint(hintDeep);
}

// ================= 表情 =================
function flyEmoji(e) {
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.textContent = e;
  el.style.left = (20 + Math.random() * 60) + '%';
  el.style.bottom = '18%';
  $('emojiLayer').appendChild(el);
  setTimeout(() => el.remove(), 1900);
}
document.querySelectorAll('.emoji-bar button').forEach((b) => {
  b.onclick = () => send({ type: 'chat-emoji', emoji: b.dataset.e });
});

// ================= 工具栏 =================
$('undoBtn').onclick = () => { send({ type: 'undo-request' }); toast('已发出悔棋请求'); };
$('newBtn').onclick  = () => send({ type: 'new-game' });
$('timerBtn').onclick = () => {
  const cur = state && state.timer ? state.timer.enabled : false;
  send({ type: 'set-timer', enabled: !cur, perMoveSec: 60 });
};
$('soundBtn').onclick = () => {
  soundOn = !soundOn;
  $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
  if (soundOn) SFX.notify();
};
$('copyBtn').onclick = async () => {
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  try { await navigator.clipboard.writeText(url); toast('邀请链接已复制'); }
  catch { toast(url, 4000); }
};
$('leaveBtn').onclick = () => {
  manualClose = true;
  if (ws) ws.close();
  location.href = '/';
};

// ================= 入口 =================
function enter() {
  const name = $('nameInput').value.trim();
  const room = $('roomInput').value.trim();
  if (!room) { toast('请填写棋室名'); return; }
  if (!/^[A-Za-z0-9_一-龥-]{1,32}$/.test(room)) {
    toast('棋室名只能用中英文、数字、下划线和短横线'); return;
  }
  myName = name || '无名氏';
  // 中文房间名转成安全 ID(服务端只收 ASCII)
  roomId = /^[A-Za-z0-9_-]+$/.test(room) ? room : hashRoom(room);
  localStorage.setItem('gomoku.name', myName);
  localStorage.setItem('gomoku.room', room);

  lobby.classList.add('hidden');
  app.classList.remove('hidden');
  requestAnimationFrame(() => { resize(); connect(); });
}

// 中文房名 → 稳定的 ASCII ID(双方输入同样的名字得到同样的 ID)
function hashRoom(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return 'r' + h1.toString(36) + h2.toString(36);
}

$('enterBtn').onclick = enter;
$('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('roomInput').focus(); });

// 回填上次的名字/房间
$('nameInput').value = localStorage.getItem('gomoku.name') || '';
$('roomInput').value = new URLSearchParams(location.search).get('room')
                    || localStorage.getItem('gomoku.room') || '';

// 带 ?room= 参数直接进
if (new URLSearchParams(location.search).get('room') && $('nameInput').value) {
  enter();
}

window.addEventListener('resize', resize);
// 手机从后台切回来: 立即校验连接, 不干等重连退避
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomId) {
    if (!ws || ws.readyState === WebSocket.CLOSED) { reconnectAttempt = 0; connect(); }
    resize();
  }
});
