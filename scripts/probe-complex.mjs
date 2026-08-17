// 复杂僵持局面探针: 短预算自对弈 22 子, 筛"双方无 VCT 杀"的复杂中盘,
// 再对 V0/V1/V2 变体跑 15s, 量化阶段 2 迭代加深完成度
import fs from 'node:fs';
import vm from 'node:vm';

const SIZE = 15, E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;

const baseSrc = fs.readFileSync('C:/Users/王巢三/gomoku/public/hint.js', 'utf8').replace(/\r\n/g, '\n');

function build(repls, budgetMs) {
  let src = baseSrc
    .replace('const DEEP_BUDGET_MS = 15000;', `const DEEP_BUDGET_MS = ${budgetMs};`)
    .replace('maxNodes: isDeep ? MAX_BUDGET : (1 << 22),', `maxNodes: isDeep ? ${Math.max(budgetMs * 2000, 2000000)} : (1 << 22),`)
    .replace('maxMs: isDeep ? MAX_BUDGET : 5000,', `maxMs: isDeep ? ${budgetMs} : 5000,`);
  for (const [from, to] of repls) {
    if (!src.includes(from)) throw new Error(`替换目标不存在: ${from}`);
    src = src.replace(from, to);
  }
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint;
}

const REBALANCE = [
  ['maxNodes: Math.floor(budget.maxNodes * 0.35),', 'maxNodes: Math.floor(budget.maxNodes * 0.2),'],
  ['maxMs: budget.maxMs * 0.35,', 'maxMs: budget.maxMs * 0.2,'],
  ['maxNodes: Math.floor(budget.maxNodes * 0.4),', 'maxNodes: Math.floor(budget.maxNodes * 0.55),'],
  ['maxMs: budget.maxMs * 0.4,', 'maxMs: budget.maxMs * 0.55,'],
];
const LMR_FIX = [['if (lmrReduced && cv > -MAX && cv < beta && cv > alpha) {',
  'if (lmrReduced && cv > -MAX && cv > alpha) {']];

const VARIANTS = { V0: [], V1: REBALANCE, V2: [...REBALANCE, ...LMR_FIX] };

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

// 短预算自对弈, 返回第 move 手的盘面 (双方无杀 + 子数 >= 20)
function selfPlay(eng, targetStones) {
  const b = new Array(225).fill(E);
  const moves = [];
  for (let n = 0; n < 180; n++) {
    const color = n % 2 === 0 ? BLACK : WHITE;
    const r = eng.computeBest(b.slice(), color, { deep: true, workerId: 0 });
    if (r.x === undefined || b[idx(r.x, r.y)] !== E) return null;
    b[idx(r.x, r.y)] = color;
    moves.push([r.x, r.y]);
    if (winsAt(b, r.x, r.y, color)) return null; // 分出胜负, 放弃该局
    if (n + 1 >= targetStones) return { b, moves };
  }
  return null;
}

const SP_BUDGET = parseInt(process.argv[2]) || 1000;
const PROBE_BUDGET = parseInt(process.argv[3]) || 15000;
const names = process.argv[4] ? process.argv[4].split(',').map(s => s.trim()) : ['V0', 'V1', 'V2'];

// 自对弈用原始引擎, 预算 SP_BUDGET
const spEng = build([], SP_BUDGET);

let game = null;
// 引擎自对弈 18 子时白方(后手)常有杀 —— 从更早的子数往回试, 找到双方无杀的
// 早期中盘 (16/14/12 子), 这才是"复杂但未定局"的代表局面
for (const target of [16, 14, 12]) {
  for (let attempt = 0; attempt < 3 && !game; attempt++) {
    game = selfPlay(spEng, target);
    if (game) {
      const t = spEng.__test__;
      const k1 = t.hasVCTKill(game.b.slice(), BLACK, { maxMs: 1500 });
      const k2 = t.hasVCTKill(game.b.slice(), WHITE, { maxMs: 1500 });
      if (k1 || k2) {
        console.log(`${target}子自对弈: 黑杀=${k1} 白杀=${k2}, 重新生成`);
        game = null;
      } else {
        console.log(`采用 ${target} 子局面`);
      }
    }
  }
}
if (!game) {
  console.log('未获得双方无杀的僵持局面');
  process.exit(1);
}
console.log(`僵持局面 (${game.moves.length} 手): ${JSON.stringify(game.moves)}`);
console.log(`局面数组: ${JSON.stringify(game.b)}`);

for (const name of names) {
  const hint = build(VARIANTS[name], PROBE_BUDGET);
  const t0 = Date.now();
  const r = hint.__test__.runWithBudget(game.b.slice(), BLACK, { deep: true });
  const ms = Date.now() - t0;
  const best = r.best;
  console.log(`[${name}] ${ms}ms` +
    ` s1=${r.stageNodes.s1} s2=${r.stageNodes.s2} s3=${r.stageNodes.s3}` +
    ` best.depth=${best ? best.depth : '-'} value=${best ? best.value : '-'}` +
    ` move=${best && best.move ? `(${best.move[0]},${best.move[1]})` : '-'}`);
}
