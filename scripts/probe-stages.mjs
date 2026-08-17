// 阶段预算探针: 量化 15s 预算在三个阶段的实际分配, 以及阶段 2 迭代加深完成到几层
// 对比变体:
//   V0 当前:   阶段预算 35/40/25, LMR 只在窗口内重搜 (fail-high 直接截断)
//   V1 重排:   阶段预算 20/55/25, LMR 不变
//   V2 重排+LMR修复: 20/55/25, LMR fail-high 也重搜全深度
// 用法: node scripts/probe-stages.mjs [总预算ms] [变体列表]
import fs from 'node:fs';
import vm from 'node:vm';

const SIZE = 15, E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;

const baseSrc = fs.readFileSync('C:/Users/王巢三/gomoku/public/hint.js', 'utf8').replace(/\r\n/g, '\n');

function build(repls, budgetMs) {
  let src = baseSrc
    // runWithBudget 钩子内部有独立预算 (maxMs: isDeep ? MAX_BUDGET, 2^28ms 无上限),
    // 与测试 fastCode 一样必须替换, 否则探针失控
    .replace('const DEEP_BUDGET_MS = 15000;', `const DEEP_BUDGET_MS = ${budgetMs};`)
    .replace('maxNodes: isDeep ? MAX_BUDGET : (1 << 22),', `maxNodes: isDeep ? ${Math.max(budgetMs * 2000, 2000000)} : (1 << 22),`)
    .replace('maxMs: isDeep ? MAX_BUDGET : 5000,', `maxMs: isDeep ? ${budgetMs} : 5000,`);
  for (const [from, to] of repls) {
    if (!src.includes(from)) throw new Error(`替换目标不存在: ${from}`);
    src = src.replace(from, to);
  }
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint.__test__;
}

const REBALANCE = [
  ['maxNodes: Math.floor(budget.maxNodes * 0.35),', 'maxNodes: Math.floor(budget.maxNodes * 0.2),'],
  ['maxMs: budget.maxMs * 0.35,', 'maxMs: budget.maxMs * 0.2,'],
  ['maxNodes: Math.floor(budget.maxNodes * 0.4),', 'maxNodes: Math.floor(budget.maxNodes * 0.55),'],
  ['maxMs: budget.maxMs * 0.4,', 'maxMs: budget.maxMs * 0.55,'],
];
const LMR_FIX = [['if (lmrReduced && cv > -MAX && cv < beta && cv > alpha) {',
  'if (lmrReduced && cv > -MAX && cv > alpha) {']];

const VARIANTS = {
  V0: [],
  V1: REBALANCE,
  V2: [...REBALANCE, ...LMR_FIX],
};

function boardOf(stones) {
  const b = new Array(225).fill(E);
  for (const [x, y, c] of stones) b[idx(x, y)] = c;
  return b;
}

const positions = [
  {
    name: 'P1 攻防中盘(白走)', color: WHITE,
    stones: [
      [7,7,BLACK],[7,8,BLACK],[8,8,BLACK],[9,6,BLACK],[6,5,BLACK],[6,7,BLACK],[5,6,BLACK],[5,5,BLACK],[7,10,BLACK],[4,7,BLACK],
      [7,6,WHITE],[8,7,WHITE],[6,6,WHITE],[9,8,WHITE],[8,5,WHITE],[6,8,WHITE],[8,9,WHITE],[4,5,WHITE],
    ],
  },
  {
    name: 'P2 平淡局面(黑走)', color: BLACK,
    stones: [
      [7,7,BLACK],[8,7,BLACK],[6,6,BLACK],[9,9,BLACK],[5,8,BLACK],[9,6,BLACK],
      [7,6,WHITE],[8,8,WHITE],[6,7,WHITE],[5,5,WHITE],[8,5,WHITE],[10,8,WHITE],
    ],
  },
  {
    name: 'P3 防守(白走, 黑活三)', color: WHITE,
    stones: [
      [4,7,BLACK],[5,7,BLACK],[6,7,BLACK],[8,8,BLACK],[3,5,BLACK],
      [4,5,WHITE],[6,5,WHITE],[5,4,WHITE],[5,6,WHITE],
    ],
  },
];

const BUDGET_MS = parseInt(process.argv[2]) || 15000;
const names = process.argv[3] ? process.argv[3].split(',').map(s => s.trim()) : ['V0', 'V1', 'V2'];

console.log(`预算 ${BUDGET_MS}ms, 变体: ${names.join(',')}`);
for (const p of positions) {
  for (const name of names) {
    const t = build(VARIANTS[name], BUDGET_MS);
    const b = boardOf(p.stones);
    const t0 = Date.now();
    const r = t.runWithBudget(b, p.color, { deep: true });
    const ms = Date.now() - t0;
    const best = r.best;
    console.log(`${p.name} [${name}] ${ms}ms` +
      ` s1=${r.stageNodes.s1} s2=${r.stageNodes.s2} s3=${r.stageNodes.s3}` +
      ` best.depth=${best ? best.depth : '-'} value=${best ? best.value : '-'}` +
      ` move=${best && best.move ? `(${best.move[0]},${best.move[1]})` : '-'}`);
  }
}
