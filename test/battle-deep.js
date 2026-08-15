// 老 vs 新 AI deep 模式对局测试
// 老 = v11.7 + 字符串替换 hack (原 hint-worker.cjs 模拟) → 深度 10
// 新 = 当前 v45 + opts.deep 原生 → 深度 10
// 老用预算上限 (模拟原来 15s/1000万), 新也用同样上限便于公平对比
//
// 跑 4 局 (2 先/2 后互换), 记录每手延迟 + 胜负

'use strict';
const fs = require('fs');
const vm = require('vm');

const oldSrc = fs.readFileSync('/tmp/hint-old.js', 'utf8');
const newSrc = fs.readFileSync('/c/Users/王巢三/gomoku/public/hint.js', 'utf8');

// 老引擎 + 字符串替换 (模拟 v45 之前的 hint-worker.cjs 行为)
const patchedOld = oldSrc
  .replace('maxNodes: 400000', 'maxNodes: 10000000')
  .replace('maxMs: 1500', 'maxMs: 15000')
  .replace(
    'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6);',
    'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 10);'
  );

function loadEngine(src) {
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint;
}

const oldEngine = loadEngine(patchedOld);
const newEngine = loadEngine(newSrc);

const SIZE = 15;
const idx = (x, y) => y * SIZE + x;
const BLACK = 1, WHITE = 2;
const E = 0;

function fresh() { return new Array(225).fill(E); }

function winsAt(b, x, y, c) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const nx = x + dx*i, ny = y + dy*i;
      if (nx<0||nx>=15||ny<0||ny>=15) break;
      if (b[idx(nx, ny)] === c) n++; else break;
    }
    for (let i = 1; i < 5; i++) {
      const nx = x - dx*i, ny = y - dy*i;
      if (nx<0||nx>=15||ny<0||ny>=15) break;
      if (b[idx(nx, ny)] === c) n++; else break;
    }
    if (n >= 5) return true;
  }
  return false;
}

function isFull(b) { return b.every(c => c !== E); }

function playGame(engineA, engineB, nameA, nameB, aColor) {
  const board = fresh();
  board[idx(7,7)] = BLACK;  // 标准开局: 黑天元
  let turn = WHITE;          // 白应第二步
  let moves = [{x:7, y:7, c:BLACK}];
  const timesA = [], timesB = [];
  const moveCount = { A: 0, B: 0 };

  while (true) {
    const isA = (turn === aColor);
    const engine = isA ? engineA : engineB;
    const name = isA ? nameA : nameB;
    const t0 = Date.now();
    const r = engine(board, turn);
    const dt = Date.now() - t0;
    if (isA) timesA.push(dt); else timesB.push(dt);
    if (isA) moveCount.A++; else moveCount.B++;
    if (!r || r.x < 0 || r.x >= 15 || r.y < 0 || r.y >= 15 || board[idx(r.x, r.y)] !== E) {
      return { winner: isA ? 'B' : 'A', reason: `${name} 出错 ${JSON.stringify(r)}`, moves, timesA, timesB, moveCount };
    }
    board[idx(r.x, r.y)] = turn;
    moves.push({ x: r.x, y: r.y, c: turn });
    if (winsAt(board, r.x, r.y, turn)) {
      return { winner: isA ? 'A' : 'B', reason: `${name} 五连`, moves, timesA, timesB, moveCount };
    }
    if (isFull(board)) {
      return { winner: 'draw', reason: '和棋', moves, timesA, timesB, moveCount };
    }
    turn = turn === BLACK ? WHITE : BLACK;
  }
}

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a,b)=>a-b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}

console.log('=== deep 模式对比: 旧 v11.7+字符串替换  vs  新 v45+opts.deep ===\n');
console.log('(双方都按原 deep 预算跑: 15s / 1000万节点, 深度 10)\n');

const N_GAMES = 4;
let stats = { A: 0, B: 0, draw: 0 };
let allTimesA = [], allTimesB = [];

for (let g = 1; g <= N_GAMES; g++) {
  // 奇数局: 旧 = 黑 (先手), 偶数局: 新 = 黑 (互换先手抵消先手优势)
  const aColor = (g % 2 === 1) ? BLACK : WHITE;
  const aName = '旧v11.7+patch', bName = '新v45+deep';

  console.log(`\n--- 第 ${g} 局 ---`);
  console.log(`先手: ${aColor === BLACK ? aName : bName}`);
  console.log(`旧 (v11.7+字符串替换) = ${aColor === BLACK ? '黑' : '白'}, 新 (v45+opts.deep) = ${aColor === BLACK ? '白' : '黑'}`);

  const t0 = Date.now();
  const result = playGame(
    aColor === BLACK ? oldEngine : newEngine,
    aColor === BLACK ? newEngine : oldEngine,
    aName, bName,
    aColor
  );
  const dt = (Date.now() - t0) / 1000;

  // winner 是 A 或 B, 映射回 旧/新
  const winnerName = result.winner === 'A' ? aName
                   : result.winner === 'B' ? bName
                   : '和棋';
  stats[result.winner]++;
  allTimesA.push(...result.timesA);
  allTimesB.push(...result.timesB);

  console.log(`  结果: ${winnerName} 胜 (${result.reason})`);
  console.log(`  总手数: ${result.moves.length}, 局时: ${dt.toFixed(1)}s`);
  console.log(`  旧 ${result.timesA.length} 手: 平均 ${avg(result.timesA).toFixed(0)}ms, 中位 ${median(result.timesA).toFixed(0)}ms, 最长 ${Math.max(...result.timesA, 0)}ms`);
  console.log(`  新 ${result.timesB.length} 手: 平均 ${avg(result.timesB).toFixed(0)}ms, 中位 ${median(result.timesB).toFixed(0)}ms, 最长 ${Math.max(...result.timesB, 0)}ms`);
}

console.log(`\n=== 汇总 (${N_GAMES} 局) ===`);
console.log(`旧 v11.7+patch: ${stats.A} 胜`);
console.log(`新 v45+opts.deep: ${stats.B} 胜`);
console.log(`和棋: ${stats.draw}`);
console.log(`\n旧 总延迟: 平均 ${avg(allTimesA).toFixed(0)}ms, 中位 ${median(allTimesA).toFixed(0)}ms, 最长 ${Math.max(...allTimesA, 0)}ms`);
console.log(`新 总延迟: 平均 ${avg(allTimesB).toFixed(0)}ms, 中位 ${median(allTimesB).toFixed(0)}ms, 最长 ${Math.max(...allTimesB, 0)}ms`);
console.log(`总手数: 旧 ${allTimesA.length}, 新 ${allTimesB.length}`);