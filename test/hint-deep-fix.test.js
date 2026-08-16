// 深度档修复测试 — v47.1
// 覆盖三个已复现的根因:
//   1. 防守局面阶段 1 (己方 VCT) 白烧 35% 预算 (实测 1226ms/8177 节点空转)
//   2. 阶段 3 防守校验只检查阶段 2 选中的单一着法
//   3. 2c 反推防守劫持己方进攻建议
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(code, sandbox);
const { computeBest, __test__ } = sandbox.self.GomokuHint;

const E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * 15 + x;
const empty = () => new Array(225).fill(E);

// 快速深档: 预算 800ms/20万节点版 (逻辑完全一致, 只缩预算 —— runWithBudget
// 深档默认 2^28 无上限, 防守 VCT 在无杀局面会跑很久, 测试必须限预算)
const fastCode = code
  .replace(/maxNodes: isDeep \? MAX_BUDGET : \(1 << 22\),/g, 'maxNodes: isDeep ? 200000 : (1 << 22),')
  .replace(/maxMs: isDeep \? MAX_BUDGET : 5000,/g, 'maxMs: isDeep ? 800 : 5000,')
  .replace('const DEEP_BUDGET_MS = 15000;', 'const DEEP_BUDGET_MS = 800;')
  .replace(/\? 10/g, '? 8'); // fast 变体深度 10→8 (800ms 跑不动 10 层)
const fsb = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(fastCode, fsb);
const fastTest = fsb.self.GomokuHint.__test__;

test('FIX1: 防守局面阶段1跳过 (stage1.nodes===0), 预算转给阶段3', () => {
  // 局面: 黑有双活二结构 (无活三), 白无任何活三+/冲四+ → 白方无杀, 阶段1应跳过
  const b = empty();
  // 黑横活二 (5,7)(6,7) + 黑斜活二 (5,5)(6,6)
  b[idx(5, 7)] = 2; b[idx(6, 7)] = 2;
  b[idx(5, 5)] = 2; b[idx(6, 6)] = 2;
  // 白干扰子: 无任何三连结构
  b[idx(0, 0)] = 1; b[idx(1, 1)] = 1;
  const r = fastTest.runWithBudget(b, 1, { deep: true });
  assert.ok(r.stageNodes, 'runWithBudget 应返回 stageNodes');
  assert.equal(r.stageNodes.s1, 0, `防守局面阶段1应跳过, 实际 nodes=${r.stageNodes.s1}`);
  assert.ok(r.stageNodes.s3 > 0, `阶段3应获得预算, 实际 nodes=${r.stageNodes.s3}`);
});

test('FIX1: 进攻局面 (己方有活三) 阶段1仍执行', () => {
  const b = empty();
  // 白活三 (4,7)(5,7)(6,7) — 白有杀可找
  b[idx(4, 7)] = 2; b[idx(5, 7)] = 2; b[idx(6, 7)] = 2;
  b[idx(0, 0)] = 1;
  const r = fastTest.runWithBudget(b, 2, { deep: true });
  assert.ok(r.stageNodes.s1 > 0, `进攻局面阶段1应执行, 实际 nodes=${r.stageNodes.s1}`);
});

test('FIX2: 阶段2选点会被杀时, 改选安全防守点 (真实对局局面)', () => {
  // 真实对局复现: 黑(后手棋, 实际是先手方)第 9 手 (7,10) 后, 白第 9 手。
  // 黑已有斜活二 (5,6)(6,5) + 竖活二 (5,5)(5,6) —— 白若走 (7,9) 类闲棋,
  // 黑 (4,7) → 斜活三 → (5,7) 冲四+活三 → (5,4) 活四 → 7 手内强制杀。
  // 正确防守: 抢 (4,7) 堵斜活二延伸。断言: 引擎建议落子后黑无 VCT 强制杀。
  const b = empty();
  for (const [x, y] of [[7,7],[7,8],[8,8],[9,6],[6,5],[6,7],[5,6],[5,5],[7,10]]) b[idx(x, y)] = 2; // 黑
  for (const [x, y] of [[7,6],[8,7],[6,6],[9,8],[8,5],[6,8],[8,9],[4,5]]) b[idx(x, y)] = 1;      // 白
  const r = computeBest(b.slice(), 1, { deep: true, workerId: 0 });
  const b2 = b.slice();
  b2[idx(r.x, r.y)] = 1;
  const kill = __test__.hasVCTKill(b2, 2, { maxMs: 3000 });
  assert.equal(kill, false, `建议 (${r.x},${r.y}) 后黑可 VCT 强制杀 —— 防守失败`);
});

test('FIX2: 对手活三时立即硬堵端点 (v11.5 融合)', () => {
  // 黑活三 (4,7)(5,7)(6,7) 双开口; 白有双活二做棋机会 (交点 (5,5) 成双活三)。
  // v11.5 行为: 对手活三硬性必堵立即返回 (2b-SOFT), 不交给搜索选进攻点。
  // safeDefensePick 验证端点安全后返回。
  const b = empty();
  b[idx(4, 7)] = 2; b[idx(5, 7)] = 2; b[idx(6, 7)] = 2;   // 黑活三
  b[idx(4, 5)] = 1; b[idx(6, 5)] = 1;                      // 白横活二
  b[idx(5, 4)] = 1; b[idx(5, 6)] = 1;                      // 白竖活二
  const r = computeBest(b.slice(), 1, { deep: true, workerId: 0 });
  assert.equal(r.y, 7, `应硬堵对手活三 (y=7), 实际 (${r.x},${r.y})`);
  assert.ok(r.x === 3 || r.x === 7, `应堵活三端点 (3,7)/(7,7), 实际 x=${r.x}`);
});

test('v47.4 增量 hash/evaluate 与全盘重算一致', () => {
  // 验证性能优化的正确性: 增量维护的 Zobrist hash 与 evaluate 总和
  // 在 move/undo 后必须与全盘重算完全一致 (否则缓存/评估被污染)
  const b = empty();
  const seed = [7,7,1, 7,6,2, 6,8,1, 8,8,2, 5,6,1, 9,7,2, 5,5,1, 9,9,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  assert.equal(__test__.incrementalConsistency(b), true, '增量 hash/evaluate 与全盘重算不一致!');
  // 空盘也要一致
  assert.equal(__test__.incrementalConsistency(empty()), true);
});

test('FIX2: 防守校验通过时保持阶段2原着法', () => {
  // 白活三, 黑无近处威胁 → 阶段2建议继续延伸活三, 阶段3验证不杀 → 原着法
  const b = empty();
  b[idx(4, 7)] = 1; b[idx(5, 7)] = 1; b[idx(6, 7)] = 1;  // 黑活三
  b[idx(10, 10)] = 2; b[idx(10, 11)] = 2;                // 白远处弱二
  const r = computeBest(b.slice(), 1, { deep: true, workerId: 0 });
  assert.equal(r.y, 7, `应继续活三线, 实际 (${r.x},${r.y})`);
});

test('FIX3: 己方有活三+ 进攻优势时, 2c 不劫持成防守点', () => {
  // 黑有活三, 白有双活二(潜在威胁更大) — 2c 会因 oppBest.score 更高
  // 把建议劫持成白方点; 修复后应继续自己的活三进攻
  const b = empty();
  // 黑活三 (4,7)(5,7)(6,7) → 应延伸 (3,7)/(7,7) 或堵双活二交点
  b[idx(4, 7)] = 1; b[idx(5, 7)] = 1; b[idx(6, 7)] = 1;
  // 白双活二结构: 横 (8,5)(10,5) + 纵 (9,4)(9,6) → 交点 (9,5) 成双活三
  b[idx(8, 5)] = 2; b[idx(10, 5)] = 2;
  b[idx(9, 4)] = 2; b[idx(9, 6)] = 2;
  const r = computeBest(b.slice(), 1, { deep: true, workerId: 0 });
  // 允许: 延伸自己的活三 (y===7) 或抢占双活三交点 (9,5)
  const extendOwn = r.y === 7 && (r.x === 3 || r.x === 7);
  const takeIntersection = r.x === 9 && r.y === 5;
  assert.ok(extendOwn || takeIntersection, `应进攻 (延伸活三或抢交点), 实际 (${r.x},${r.y})`);
});
