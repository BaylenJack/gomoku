// 真实对局: v11 (9850bd5) vs v11.2 (26de218) — 同规则、同预算、真实下满
import fs from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

const SIZE = 15;
const EMPTY = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;
const other = (c) => (c === BLACK ? WHITE : BLACK);

// 从 git 历史提取指定版本的 hint.js 源码
function loadEngineAt(commit, opts = {}) {
  let src = execSync(`git show ${commit}:public/hint.js`, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
  // 提高预算测试真实棋力(默认 1500ms/40万节点太低)
  if (opts.maxNodes) src = src.replace('maxNodes: 400000', `maxNodes: ${opts.maxNodes}`);
  if (opts.maxMs) src = src.replace('maxMs: 1500', `maxMs: ${opts.maxMs}`);
  const sandbox = { module: { exports: {} }, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sandbox);
  return sandbox.module.exports.computeBest;
}

function checkWin(board, x, y, color) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let c = 1;
    for (let s = 1; s < 5; s++) {
      const nx = x + dx*s, ny = y + dy*s;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || board[idx(nx,ny)] !== color) break;
      c++;
    }
    for (let s = 1; s < 5; s++) {
      const nx = x - dx*s, ny = y - dy*s;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || board[idx(nx,ny)] !== color) break;
      c++;
    }
    if (c >= 5) return true;
  }
  return false;
}

function playGame(black, white, first) {
  const board = new Array(225).fill(0);
  const moves = [];
  let last = null;
  let errInfo = null;
  let best = null;
  for (let n = 0; n < 225; n++) {
    const role = (n + (first === BLACK ? 0 : 1)) % 2 + 1;
    const engine = role === BLACK ? black : white;
    try {
      const r = engine(board.slice(), role, {});
      if (r && r.x !== undefined && board[idx(r.x, r.y)] === EMPTY) best = [r.x, r.y];
    } catch (e) {
      // engine 抛错 → 记下细节, 用启发式兜底继续下(真实对局中前端会回退启发式)
      errInfo = { n, role, msg: e.message, stack: e.stack || '' };
      best = null;
    }
    if (!best) {
      // 引擎返回非法点/崩溃 → 启发式兜底: 找第一个空位
      for (let i = 0; i < 225; i++) if (board[i] === EMPTY) { best = [i % 15, Math.floor(i / 15)]; break; }
    }
    board[idx(best[0], best[1])] = role;
    moves.push([best[0], best[1]]);
    if (checkWin(board, best[0], best[1], role)) {
      return { winner: role, reason: '五连', moves, err: errInfo };
    }
    last = [best[0], best[1]];
  }
  return { winner: 0, reason: '和棋', moves };
}

// 主程序
const [,, commitsA, commitsB, gamesStr, labelA, labelB, maxNodes, maxMs] = process.argv;
const GAMES = parseInt(gamesStr) || 3;
const A = loadEngineAt(commitsA, { maxNodes, maxMs });
const B = loadEngineAt(commitsB, { maxNodes, maxMs });

const stats = { aWin: 0, bWin: 0, draw: 0, aErr: 0, bErr: 0 };
const games = [];

for (let g = 0; g < GAMES; g++) {
  const first = g % 2 === 0 ? BLACK : WHITE; // 轮流先手
  const r = playGame(A, B, first);
  // 黑方引擎永远是 A, 白方永远是 B(first 只决定谁先走, 与引擎绑定无关)
  const winnerName = r.winner === BLACK ? labelA : (r.winner === WHITE ? labelB : '和棋');
  const errWho = r.err ? (r.err.role === BLACK ? labelA : labelB) : null;
  games.push({ g: g + 1, first: first === BLACK ? labelA : labelB, winner: winnerName, reason: r.reason, moves: r.moves.length, err: r.err ? `${r.err.n}手/${errWho}: ${r.err.msg}` : null });
  if (r.winner === 0) stats.draw++;
  else if (winnerName === labelA) stats.aWin++;
  else stats.bWin++;
  if (errWho === labelA) stats.aErr++;
  else if (errWho === labelB) stats.bErr++;
  console.log(`第${g+1}局: 先手=${first === BLACK ? labelA : labelB} 胜者=${winnerName} (${r.reason}, ${r.moves.length}手)${r.err ? ` [引擎崩溃 ${r.err.n}手 ${errWho}: ${r.err.msg}]` : ''}`);
}

console.log(`\n=== ${labelA}(v11) vs ${labelB}(v11.2), ${GAMES} 局 ===`);
console.log(`${labelA}: ${stats.aWin}胜 ${stats.aErr}引擎错 | ${labelB}: ${stats.bWin}胜 ${stats.bErr}引擎错 | 和棋 ${stats.draw}`);
