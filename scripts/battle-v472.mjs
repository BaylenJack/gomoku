// v47.2 battle: 新引擎 vs 旧引擎 (be16505) — 同预算对比评估+搜索改动
// 用法: node scripts/battle-v472.mjs [每手预算ms] [局数]
import fs from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

const BUDGET_MS = parseInt(process.argv[2]) || 2500;
const GAMES = parseInt(process.argv[3]) || 4;

const SIZE = 15, E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;

function load(src) {
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint.computeBest;
}

// 旧引擎: be16505 的 hint.js, 同样注入预算
const oldSrc = execSync('git show be16505:public/hint.js', { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 })
  .toString('utf8').replace(/\r\n/g, '\n')
  .replace('const DEEP_BUDGET_MS = 3500;', `const DEEP_BUDGET_MS = ${BUDGET_MS};`);
const newSrc = fs.readFileSync('public/hint.js', 'utf8').replace(/\r\n/g, '\n')
  .replace('const DEEP_BUDGET_MS = 10000;', `const DEEP_BUDGET_MS = ${BUDGET_MS};`);
const oldEng = load(oldSrc);
const newEng = load(newSrc);

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

function playGame(blackEng, whiteEng, labelB, labelW) {
  const b = new Array(225).fill(0);
  const moves = [];
  const times = [];
  for (let n = 0; n < 180; n++) {
    const color = n % 2 === 0 ? BLACK : WHITE;
    const eng = color === BLACK ? blackEng : whiteEng;
    const t0 = Date.now();
    const r = eng(b.slice(), color, { deep: true, workerId: 0 });
    times.push(Date.now() - t0);
    if (r.x === undefined || b[idx(r.x, r.y)] !== E) {
      console.log(`  !! 非法落点 ${labelB==='新'?'新':'旧'}${color===BLACK?'黑':'白'} 第${Math.floor(n/2)+1}手: ${JSON.stringify(r)}`);
      return { winner: color === BLACK ? WHITE : BLACK, moves: n };
    }
    b[idx(r.x, r.y)] = color;
    moves.push([r.x, r.y]);
    if (winsAt(b, r.x, r.y, color)) {
      return { winner: color, moves: n + 1 };
    }
  }
  return { winner: 0, moves: 180 };
}

const results = [];
for (let g = 0; g < GAMES; g++) {
  // 交替: 偶局新引擎黑先, 奇局旧引擎黑先
  const newFirst = g % 2 === 0;
  const blackEng = newFirst ? newEng : oldEng;
  const whiteEng = newFirst ? oldEng : newEng;
  const r = playGame(blackEng, whiteEng, newFirst ? '新' : '旧', newFirst ? '旧' : '新');
  const winnerName = r.winner === BLACK ? (newFirst ? '新(黑)' : '旧(黑)') : r.winner === WHITE ? (newFirst ? '旧(白)' : '新(白)') : '和棋';
  console.log(`第${g+1}局: 新引擎${newFirst ? '黑先' : '白后'} → 胜者=${winnerName} (${r.moves}手)`);
  results.push({ g, newFirst, winner: r.winner, moves: r.moves });
}

const newWins = results.filter(r => (r.winner === BLACK && r.newFirst) || (r.winner === WHITE && !r.newFirst)).length;
const oldWins = results.filter(r => (r.winner === WHITE && r.newFirst) || (r.winner === BLACK && !r.newFirst)).length;
const draws = results.filter(r => r.winner === 0).length;
console.log(`\n=== 新引擎 ${newWins} 胜 / 旧引擎 ${oldWins} 胜 / 和棋 ${draws} (预算 ${BUDGET_MS}ms/手, ${GAMES} 局) ===`);
