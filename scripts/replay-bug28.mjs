// 复盘 15s 自对弈: 白第 28 手 (8,4) 声称必胜却走出败着
// 重建局面, 独立验证: 白是否有真杀, 黑活三是否被漏
import fs from 'node:fs';
import vm from 'node:vm';

const SIZE = 15, E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;
const B = BLACK, W = WHITE;

// 15s 自对弈棋谱 (白第 28 手前的全部落子, 含最后三步)
const moves = [  [7,7,B],[8,8,W],[7,6,B],[7,5,W],[7,8,B],[7,9,W],[6,4,B],[9,7,W],
  [10,6,B],[6,3,W],[6,10,B],[8,6,W],[10,8,B],[10,9,W],[8,10,B],[8,9,W],
  [11,9,B],[8,5,W],[8,7,B],[9,9,W],[6,9,B],[5,10,W],[6,5,B],[9,8,W],
  [9,10,B],[7,10,W],[5,4,B],[4,3,W],[9,6,B],[10,5,W],[10,7,B],[3,3,W],
  [5,3,B],[5,5,W],[3,4,B],[4,4,W],[2,2,B],[9,5,W],[11,5,B],[4,5,W],
  [4,2,B],[3,1,W],[6,11,B],[6,12,W],[1,2,B],[3,2,W],[5,8,B],[2,5,W],
  [6,7,B],[6,8,W],[3,5,B],[11,6,W],[7,4,B],[5,7,W],[5,6,B], // 黑 28 后, 白 28 该走
];

function load(path, budget) {
  let src = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    .replace(/const DEEP_BUDGET_MS = \d+;/, `const DEEP_BUDGET_MS = ${budget};`);
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint;
}

const newEng = load('C:/Users/王巢三/gomoku/public/hint.js', 15000);
const oldEng = load('C:/Users/王巢三/gomoku/scripts/old-v4712-hint.js', 15000);

const b = new Array(225).fill(E);
for (const [x, y, c] of moves) b[idx(x, y)] = c;

console.log('局面: 白第 28 手 (黑 28=(5,6) 后)');
console.log('黑斜线: (5,6)(6,5)(7,4) = 活三, 端点 (8,3)/(4,7)');

// 1. 白在当前局面是否有 VCT 杀 (独立深度检查)
for (const [name, eng] of [['新引擎', newEng], ['旧引擎', oldEng]]) {
  const t0 = Date.now();
  const r = eng.computeBest(b.slice(), WHITE, { deep: true, workerId: 0 });
  console.log(`${name} 建议: (${r.x},${r.y}) value=${r.value} path=${JSON.stringify(r.path)} [${Date.now() - t0}ms]`);
}
console.log('---');
// 2. 黑 VCT 杀检查 (这个局面黑走到 (8,3) 即活三→冲四→五)
for (const [name, eng] of [['新引擎', newEng], ['旧引擎', oldEng]]) {
  const k = eng.__test__.hasVCTKill(b.slice(), BLACK, { maxMs: 3000 });
  console.log(`${name}: 黑有 VCT 杀 = ${k}`);
}
// 3. 白落 (8,4) 后黑是否一步杀
const b2 = b.slice();
b2[idx(8, 4)] = WHITE;
for (const [name, eng] of [['新引擎', newEng], ['旧引擎', oldEng]]) {
  const k = eng.__test__.hasVCTKill(b2.slice(), BLACK, { maxMs: 3000 });
  console.log(`${name}: 白 (8,4) 后黑有 VCT 杀 = ${k}`);
}
// 4. 黑活三端点检查: (8,3) 落黑后黑是否冲四
const b3 = b.slice();
b3[idx(8, 3)] = BLACK;
let four = false;
for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
  let n = 1;
  for (let i = 1; i < 5; i++) {
    const nx = 8 + dx*i, ny = 3 + dy*i;
    if (nx<0||nx>=15||ny<0||ny>=15) break;
    if (b3[idx(nx,ny)] === BLACK) n++; else break;
  }
  for (let i = 1; i < 5; i++) {
    const nx = 8 - dx*i, ny = 3 - dy*i;
    if (nx<0||nx>=15||ny<0||ny>=15) break;
    if (b3[idx(nx,ny)] === BLACK) n++; else break;
  }
  if (n >= 4) { four = true; console.log(`(8,3) 落黑: 方向(${dx},${dy}) n=${n} → ${n>=5?'成五':'冲四'}`); }
}
console.log('(8,3) 是否成四:', four);
