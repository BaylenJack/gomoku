// 对局复盘: 读 data/games/<roomId>.jsonl (服务端落子日志), 逐手跑引擎,
// 对比"实际走法 vs 引擎建议", 输出偏离点 + 终局分析。
// 用法: node scripts/review-game.js <roomId> [局序号]  (局序号从 1 开始, 默认最后一局)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const roomId = process.argv[2];
if (!roomId) { console.error('用法: node scripts/review-game.js <roomId> [局序号]'); process.exit(1); }
const wantIdx = process.argv[3] ? parseInt(process.argv[3], 10) : null;

const logPath = path.join(ROOT, 'data', 'games', roomId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
if (!fs.existsSync(logPath)) { console.error('没有落子日志: ' + logPath); process.exit(1); }

// ---- 读日志, 按 new-game 分段 ----
const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const games = []; // 每局: { moves: [{n,color,x,y}], end: {...} }
let cur = null;
for (const ev of lines) {
  if (ev.type === 'new-game') { cur = { moves: [], end: null }; games.push(cur); continue; }
  if (!cur) { cur = { moves: [], end: null }; games.push(cur); }
  if (ev.type === 'move') cur.moves.push(ev);
  else if (ev.type === 'undo') {
    // 撤销: 移除 by 方的最后一手
    for (let i = cur.moves.length - 1; i >= 0; i--) {
      if (cur.moves[i].color === ev.by) { cur.moves.splice(i, 1); break; }
    }
  } else if (ev.type === 'end') cur.end = ev;
}
if (games.length === 0) { console.error('日志里没有对局'); process.exit(1); }
const idx = wantIdx || games.length;
const game = games[idx - 1];
if (!game) { console.error(`只有 ${games.length} 局, 没有第 ${idx} 局`); process.exit(1); }
const moves = game.moves;
console.log(`==== 房间 ${roomId} 第 ${idx} 局复盘 ====`);
console.log(`共 ${moves.length} 手` + (game.end ? `, 胜者=${game.end.winner === 1 ? '黑' : '白'}${game.end.winLine ? ', 五连=' + JSON.stringify(game.end.winLine) : ''}` : ', 未终局'));

// ---- 加载引擎 (小预算: 每手 ~400ms, 140 手 ≈ 1 分钟) ----
const src = fs.readFileSync(path.join(ROOT, 'public', 'hint.js'), 'utf8')
  .replace('maxNodes: 400000', 'maxNodes: 30000')
  .replace('maxMs: 1500', 'maxMs: 400');
const sandbox = {
  module: { exports: {} }, exports: {}, global: {}, self: undefined,
  performance: { now: () => Date.now() },
  console: { log: () => {}, error: () => {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const computeBest = sandbox.module.exports.computeBest;

// ---- 逐手对比 ----
// 第 n 手落完后轮到对方, 引擎的建议对比"对方实际走的下一手" (n+1)。
const board = new Array(225).fill(0);
const NAMES = { 1: '黑', 2: '白' };
let blackOff = 0, whiteOff = 0;
const diffs = []; // { n, color, x, y, sx, sy }
for (let i = 0; i < moves.length - 1; i++) {
  const m = moves[i];
  board[m.y * 15 + m.x] = m.color;
  const next = moves[i + 1];
  let r = null;
  try { r = computeBest(board, m.color === 1 ? 2 : 1); } catch (e) { r = null; }
  if (!r) continue;
  const same = r.x === next.x && r.y === next.y;
  if (!same) diffs.push({ n: next.n, color: next.color, x: next.x, y: next.y, sx: r.x, sy: r.y });
  if (next.color === 1) blackOff += same ? 0 : 1; else whiteOff += same ? 0 : 1;
}
const movesOf = (c) => moves.filter((m) => m.color === c).length;
console.log(`偏离引擎: 黑 ${blackOff}/${movesOf(1)} 手, 白 ${whiteOff}/${movesOf(2)} 手`);

// ---- 关键偏离(挑偏离幅度大的前 8 个: 建议点离实际点远) ----
const dist = (d) => Math.max(Math.abs(d.x - d.sx), Math.abs(d.y - d.sy));
diffs.sort((a, b) => dist(b) - dist(a));
console.log('\n[最大偏离]');
for (const d of diffs.slice(0, 8)) {
  console.log(`第 ${d.n} 手 ${NAMES[d.color]} 实际(${d.x},${d.y}) vs 引擎建议(${d.sx},${d.sy}) 距${dist(d)}格`);
}
if (diffs.length === 0) console.log('  (无 —— 全部与引擎建议一致)');

// ---- 终局 6 手 ----
const endMoves = moves.slice(-6);
console.log('\n[终局 6 手]');
for (const m of endMoves) {
  const d = diffs.find((x) => x.n === m.n);
  console.log(`第 ${m.n} 手 ${NAMES[m.color]} (${m.x},${m.y})` + (d ? ` ✗ 引擎建议(${d.sx},${d.sy})` : ' ✓'));
}

// ---- 写报告文件 ----
const report = [
  `# 房间 ${roomId} 第 ${idx} 局复盘`,
  `- 共 ${moves.length} 手` + (game.end ? `, 胜者 ${game.end.winner === 1 ? '黑' : '白'}` : ''),
  `- 偏离引擎: 黑 ${blackOff}/${movesOf(1)}, 白 ${whiteOff}/${movesOf(2)}`,
];
fs.writeFileSync(path.join(ROOT, 'data', 'games', roomId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.review.md'), report.join('\n'));
