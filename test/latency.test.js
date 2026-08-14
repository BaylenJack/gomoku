// v12.0 延迟实测: v11.7(当前 HEAD) vs v11.5(a16ca22), 用深度档预算
// 期望: v12.0 在浅档下优势(10:0 之类), 深档下棋力相当或更好, **延迟 < 7s**

import fs from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

function loadEngineAt(commit, opts = {}) {
  let src = execSync(`git show ${commit}:public/hint.js`, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
  // 服务器端深度档替换: 1000万节点 / 15s
  if (opts.maxNodes) src = src.replace('maxNodes: 400000', `maxNodes: ${opts.maxNodes}`);
  if (opts.maxMs) src = src.replace('maxMs: 1500', `maxMs: ${opts.maxMs}`);
  if (opts.replaceDepth) {
    src = src.replace(
      'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6);',
      'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 10);'
    );
  }
  const sandbox = { module: { exports: {} }, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sandbox);
  return sandbox.module.exports.computeBest;
}

const SIZE = 15, EMPTY = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;

// 用 data/rooms.json 里真实游戏中盘局 (避开早期有威胁的局面)
// 选 ~25-30 子的中段, 此时双方都成型, 搜索会深入
const testPosition = (() => {
  let pos = null;
  try {
    const rooms = JSON.parse(fs.readFileSync('data/rooms.json', 'utf8'));
    for (const id of Object.keys(rooms.rooms)) {
      const room = rooms.rooms[id];
      if (room.moves && room.moves.length >= 25 && room.moves.length <= 35) {
        pos = new Array(225).fill(0);
        for (const m of room.moves) pos[idx(m.x, m.y)] = m.color;
        console.log(`  用房间 ${id} 的 ${room.moves.length} 手局`);
        return pos;
      }
    }
  } catch (e) { /* data/rooms.json 缺, 走 fallback */ }
  // fallback: 离散 5x5 网格, 25 子, 不会形成任何 3+ 连
  const b = new Array(225).fill(0);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    b[idx(i*3, j*3)] = (i+j) % 2 === 0 ? 1 : 2;
  }
  return b;
})();

console.log('=== 延迟实测 (深度档 1000万节点 / 15s) ===\n');
console.log('加载 3 个引擎...');

const v115 = loadEngineAt('a16ca22', { maxNodes: 10000000, maxMs: 15000, replaceDepth: true });
const v117 = loadEngineAt('69defd1', { maxNodes: 10000000, maxMs: 15000, replaceDepth: true });
// 当前本地代码 (v12.0)
const v120Src = (() => {
  let src = fs.readFileSync('public/hint.js', 'utf8');
  // 同样应用深度档替换
  src = src.replace('maxNodes: 400000', 'maxNodes: 10000000').replace('maxMs: 1500', 'maxMs: 15000');
  src = src.replace(
    'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6);',
    'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 10);'
  );
  return src;
})();
const v120 = (() => {
  const sandbox = { module: { exports: {} }, performance: { now: () => Date.now() } };
  vm.runInNewContext(v120Src, sandbox);
  return sandbox.module.exports.computeBest;
})();

// 同时给 v120 模块暴露内部函数(用于调试)
const v120Debug = (() => {
  const debugSrc = v120Src.replace(
    'return { computeBest };',
    'return { computeBest, _winPoints: winPoints, _killInOne: killInOne, _oppOpenFourPoints: oppOpenFourPoints, _oppLineBlocks: oppLineBlocks };'
  );
  const sandbox = { module: { exports: {} }, performance: { now: () => Date.now() } };
  vm.runInNewContext(debugSrc, sandbox);
  return sandbox.module.exports;
})();

function winPoints(board, c) {
  return v120Debug._winPoints(board, c);
}
function killInOne(board, c) {
  return v120Debug._killInOne(board, c);
}
function oppOpenFourPoints(board, c) {
  return v120Debug._oppOpenFourPoints(board, c);
}
function oppLineBlocks(board, c, minN) {
  return v120Debug._oppLineBlocks(board, c, minN);
}

async function bench(name, fn, n = 3) {
  const times = [];
  const moves = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = fn();
    const ms = Date.now() - t0;
    times.push(ms);
    moves.push(r);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`${name}:`);
  console.log(`  走法:   ${moves.map(m => `(${m.x},${m.y})`).join(', ')}`);
  console.log(`  中位:   ${median}ms`);
  console.log(`  P95:    ${p95}ms`);
  console.log(`  范围:   ${times[0]}-${times[times.length-1]}ms`);
  return { median, p95, moves };
}

// 调试: 看哪条 early-exit 路径被触发
async function tracePath(computeBest, board) {
  // 直接调 hint.js 暴露的内部函数做不到, 但可以检测哪些条件成立
  // 检查: 直接 5-in-row / opp 5-in-row / killInOne
  const wins = winPoints(board, 1);
  const oppWins = winPoints(board, 2);
  const kill = killInOne(board, 1);
  const liveFours = oppOpenFourPoints(board, 2);
  const rushFours = oppLineBlocks(board, 2, 4);
  const liveThrees = oppLineBlocks(board, 3).filter(p => !rushFours.includes(p));
  console.log(`  调试: 直接5=${wins.length}, opp5=${oppWins.length}, kill=${kill?'是':'否'}, opp活四=${liveFours.length}, opp冲四=${rushFours.length}`);
}

console.log('\n--- 相同局面, 3 次取样 ---\n');
await tracePath(v120, testPosition);
console.log();
const r115 = await bench('v11.5 (a16ca22)', () => v115(testPosition.slice(), 1, { skipHardRules: true }));
const r117 = await bench('v11.7 (69defd1)', () => v117(testPosition.slice(), 1, { skipHardRules: true }));
const r120 = await bench('v12.0 (当前)', () => v120(testPosition.slice(), 1, { skipHardRules: true }));

console.log('\n--- 总结 ---');
console.log(`v11.5: ${r115.median}ms | 走法 ${r115.moves[0]?.x},${r115.moves[0]?.y}`);
console.log(`v11.7: ${r117.median}ms | 走法 ${r117.moves[0]?.x},${r117.moves[0]?.y}`);
console.log(`v12.0: ${r120.median}ms | 走法 ${r120.moves[0]?.x},${r120.moves[0]?.y}`);
const speedup = (r117.median / r120.median).toFixed(2);
console.log(`\nv12.0 vs v11.7 加速比: ${speedup}x`);
console.log(`v12.0 vs v11.5 加速比: ${(r115.median / r120.median).toFixed(2)}x`);

if (r120.moves[0] && r117.moves[0]) {
  const sameAsV117 = r120.moves[0].x === r117.moves[0].x && r120.moves[0].y === r117.moves[0].y;
  console.log(`\nv12.0 与 v11.7 走法一致: ${sameAsV117 ? '✓ (棋力不退)' : '✗ (走法变化, 需验证)'}`);
}