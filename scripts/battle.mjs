// 通用 battle: 两个 hint.js 源文件同预算对打, 交替先手
// 用法: node scripts/battle.mjs <旧引擎文件> <新引擎文件> [每手预算ms] [局数]
// 例: node scripts/battle.mjs /tmp/old-hint.js public/hint.js 15000 6
import fs from 'node:fs';
import vm from 'node:vm';

const BUDGET_MS = parseInt(process.argv[4]) || 15000;
const GAMES = parseInt(process.argv[5]) || 6;

const SIZE = 15, E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;

function load(path) {
  let src = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  // 预算注入: 替换 DEEP_BUDGET_MS 常量 (无论当前值是多少)
  src = src.replace(/const DEEP_BUDGET_MS = \d+;/, `const DEEP_BUDGET_MS = ${BUDGET_MS};`);
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint.computeBest;
}

const oldEng = load(process.argv[2]);
const newEng = load(process.argv[3]);

function winsAt(b, x, y, c) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const nx = x + dx*i, ny = y + dy*i;
      if (nx<0||nx>=15||ny<0||ny>=15) break;
      if (b[idx(nx, ny)] === c) n++; else break;
    }
    for (let i = 1; i < 5; i++) {
      const nx = x - dx*i, ny = y + dy*i;
      if (nx<0||nx>=15||ny<0||ny>=15) break;
      if (b[idx(nx, ny)] === c) n++; else break;
    }
    if (n >= 5) return true;
  }
  return false;
}

function playGame(blackEng, whiteEng, labelB, labelW) {
  const b = new Array(225).fill(E);
  const times = [];
  for (let n = 0; n < 180; n++) {
    const color = n % 2 === 0 ? BLACK : WHITE;
    const eng = color === BLACK ? blackEng : whiteEng;
    const t0 = Date.now();
    const r = eng(b.slice(), color, { deep: true, workerId: 0 });
    times.push(Date.now() - t0);
    if (r.x === undefined || b[idx(r.x, r.y)] !== E) {
      console.log(`  !! 非法落点: ${color === BLACK ? '黑' : '白'}第${Math.floor(n/2)+1}手: ${JSON.stringify(r)}`);
      return { winner: color === BLACK ? WHITE : BLACK, moves: n };
    }
    b[idx(r.x, r.y)] = color;
    if (winsAt(b, r.x, r.y, color)) {
      return { winner: color, moves: n + 1 };
    }
  }
  return { winner: 0, moves: 180 };
}

const results = [];
for (let g = 0; g < GAMES; g++) {
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
