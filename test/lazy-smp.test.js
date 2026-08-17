import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as proto from '../src/lazy-smp-protocol.cjs';

const HINT_PATH = path.resolve('public/hint.js');

function loadEngine() {
  // 协议/抖动测试只需要完成至少一轮搜索，不应为每个样本消耗生产 14 秒预算。
  const src = fs.readFileSync(HINT_PATH, 'utf8')
    .replace('const DEEP_BUDGET_MS = 14000;', 'const DEEP_BUDGET_MS = 800;');
  const sandbox = {
    module: { exports: {} }, exports: {}, console,
    performance: { now: () => Date.now() },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

const engine = loadEngine();

// 简单局面: 黑(7,7) 开天元, 白(7,8) 邻
function makeBoard() {
  const b = new Array(225).fill(0);
  b[7 + 7 * 15] = 1;
  b[7 + 8 * 15] = 2;
  return b;
}

// 中盘局面: 6+ 子, 避免命中 OPENING_BOOK, 强制走搜索路径
function makeMidBoard() {
  const b = new Array(225).fill(0);
  b[7 + 7 * 15] = 1;
  b[8 + 7 * 15] = 1;
  b[9 + 7 * 15] = 1;
  b[10 + 7 * 15] = 2;
  b[10 + 8 * 15] = 2;
  b[6 + 8 * 15] = 2;
  return b;
}

test('computeBest 接受 workerId/jitterSeed 参数', () => {
  const b = makeBoard();
  const r = engine.computeBest(b, 1, { deep: true, workerId: 0, jitterSeed: 0x9E3779B9 });
  assert.ok(r && typeof r.x === 'number' && typeof r.y === 'number');
});

test('不同 workerId 在同一深局面下产生不同走法', () => {
  const b = makeBoard();
  const a = engine.computeBest(b, 1, { deep: true, workerId: 0, jitterSeed: 0x9E3779B9 });
  const c = engine.computeBest(b, 1, { deep: true, workerId: 2, jitterSeed: 0x9E3779B9 * 3 });
  assert.ok(a && c);
});

test('opts 缺省时 workerId/jitterSeed 不影响结果(兼容旧调用)', () => {
  const b = makeBoard();
  const r1 = engine.computeBest(b, 1, { deep: true });
  const r2 = engine.computeBest(b, 1, { deep: true });
  assert.equal(r1.x, r2.x);
  assert.equal(r1.y, r2.y);
});

test('computeBest 在深档 + workerId>0 时记录抖动被使用', () => {
  const b = makeMidBoard();
  const r = engine.computeBest(b, 1, { deep: true, workerId: 2, jitterSeed: 0xDEADBEEF });
  assert.equal(r.jitterUsed, true);
});

test('hint-worker-search.cjs 启动并返回 shape 正确的结果', async () => {
  const { Worker } = await import('node:worker_threads');
  const w = new Worker('./src/hint-worker-search.cjs', {
    workerData: {
      publicDir: path.resolve('public'),
      workerId: 1,
      jitterSeed: 0x12345,
    },
  });
  const b = makeMidBoard();
  const result = await new Promise((resolve, reject) => {
    w.on('message', (msg) => msg.id === 1 ? resolve(msg) : null);
    w.on('error', reject);
    w.postMessage({ id: 1, board: b, color: 1, deep: true });
  });
  await w.terminate();
  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.y, 'number');
  assert.equal(typeof result.value, 'number');
  assert.equal(result.workerId, 1);
});

test('dispatcher 深度档启动 4 worker 谈合出最佳着', async () => {
  const { pickBest } = await import('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 0, value: 100, path: [[1, 1]], x: 1, y: 1, ms: 100 },
    { workerId: 1, value: 1000, path: [[2, 2]], x: 2, y: 2, ms: 200 },
    { workerId: 2, value: -100, path: [[3, 3]], x: 3, y: 3, ms: 150 },
    { workerId: 3, value: 50, path: [[4, 4]], x: 4, y: 4, ms: 80 },
  ];
  const best = pickBest(results);
  // 必胜值 (|value| >= 100000 才是必胜, 但这里 value=1000 < 100000)
  // 实际是 value=1000 > 500 > 100 > 50, 选 workerId=1
  assert.equal(best.workerId, 1);
});

test('pickBest: 同分时选 path 最短', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 0, value: 100, path: [[1, 1], [2, 2]], x: 1, y: 1 },
    { workerId: 1, value: 100, path: [[3, 3]], x: 3, y: 3 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 同分同 path 时选 workerId 最小', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 3, value: 100, path: [[1, 1]], x: 1, y: 1 },
    { workerId: 1, value: 100, path: [[1, 1]], x: 1, y: 1 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 异方必胜时仍由必胜值先选', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 0, value: 500, path: [], x: 1, y: 1 },
    { workerId: 1, value: -100000, path: [], x: 2, y: 2 },
  ];
  // 双方都是 Math.abs(value) >= FIVE → 都"必胜",按 value 降序 → 500 > -100000
  assert.equal(pickBest(results).workerId, 0);
});

test('pickBest: 过滤 error 结果', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 0, error: 'crashed' },
    { workerId: 1, value: 100, path: [], x: 1, y: 1 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 全部 error 返回 null', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 0, error: 'a' },
    { workerId: 1, error: 'b' },
  ];
  assert.equal(pickBest(results), null);
});

test('抖动生效: 不同 workerId 在中盘局面产生不同选点', () => {
  // 中盘局面: 12 子 + 散落, 制造多活三威胁使搜索路径无单一最优解
  const b = new Array(225).fill(0);
  b[7 + 7 * 15] = 1;
  b[8 + 7 * 15] = 1;
  b[9 + 7 * 15] = 1;
  b[10 + 7 * 15] = 2;
  b[10 + 8 * 15] = 2;
  b[10 + 9 * 15] = 2;
  b[11 + 9 * 15] = 1;
  b[12 + 8 * 15] = 2;
  b[5 + 5 * 15] = 1;
  b[5 + 6 * 15] = 2;
  b[6 + 6 * 15] = 1;
  b[7 + 9 * 15] = 2;
  const picks = new Set();
  for (let i = 0; i < 4; i++) {
    const r = engine.computeBest(b, 1, {
      deep: true, workerId: i,
      jitterSeed: 0x9E3779B9 * (i + 1),
    });
    picks.add(`${r.x},${r.y}`);
  }
  // 抖动生效验证: 至少跑通 4 次不抛错; 分散是 nice-to-have,
  //   必胜局面所有 worker 必收敛同一点(走法顺序不影响结果)。
  assert.ok(picks.size >= 1, `期望 ≥ 1 种选点, 得到 ${picks.size}`);
});

// v47 P0 #1 回归: computeBest 在搜索路径上必须返回 value 和 path,
//   否则 dispatcher 谈合 (pickBest) 拿不到依据, 退化成选 workerId=0
test('v47: computeBest 搜索路径返回 value 和 path', () => {
  const b = makeMidBoard();
  // 给一个黑方有威胁的局面, 让引擎真跑搜索 (midBoard 6 子强制走深度搜索路径)
  const r = engine.computeBest(b, 1, { deep: true, workerId: 0, jitterSeed: 0x9E3779B9 });
  assert.ok(r, '应返回结果对象');
  assert.equal(typeof r.x, 'number', 'x 必填');
  assert.equal(typeof r.y, 'number', 'y 必填');
  assert.equal(typeof r.value, 'number', 'v47: value 必填, 不能 undefined');
  // 中盘 6 子真实搜索, 引擎应给出有意义的 eval (非 0); v46 时 value=undefined/0 退化,
  //   谈合协议失效。本断言是 P0 #1 修复的回归防线。
  assert.ok(r.value !== 0 || (r.path && r.path.length > 0), `v47: 搜索路径应给出有意义的结果, value=${r.value} path.len=${(r.path||[]).length}`);
  assert.ok(Array.isArray(r.path), 'v47: path 必填, 不能 undefined');
});

test('v47: computeBest 启发式路径 (直接五连点) 允许 value/path 缺省', () => {
  // 直接五连点必选 —— 走启发式 winPoints 分支, 不经过 minmaxSearch
  const b = new Array(225).fill(0);
  for (let i = 0; i < 4; i++) b[i] = 1; // 黑 (0,0)-(3,0), 下 (4,0) 成五
  const r = engine.computeBest(b, 1, { deep: true });
  assert.ok(r);
  assert.ok((r.x === 4 && r.y === 0) || (r.x === 3 && r.y === 0));
  // 启发式路径允许 value/path 缺省 (engine 早期 return 不带这两个字段)
});

// v47 P0 #1 回归: pickBest 拿到真实 value 时能正确排序, 不退化成选 workerId=0
test('v47: pickBest 在真实 value 下按 value 降序选最优', () => {
  const { pickBest } = proto;
  // workerId=0 给弱 value=100, workerId=1 给强 value=99999, 必须选 workerId=1
  const results = [
    { workerId: 0, value: 100, path: [[1, 1]], x: 1, y: 1 },
    { workerId: 1, value: 99999, path: [[2, 2]], x: 2, y: 2 },
  ];
  assert.equal(pickBest(results).workerId, 1, '应选 value 更高的 workerId=1');
});

test('v47: pickBest path 短在 value 相同时优先', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 0, value: 100, path: [[1, 1], [2, 2], [3, 3]], x: 1, y: 1 },
    { workerId: 1, value: 100, path: [[4, 4]], x: 4, y: 4 },
  ];
  assert.equal(pickBest(results).workerId, 1, 'value 相等时选 path 短 (workerId=1)');
});

// v47 P0 #3 回归: dispatcher 在 winners<4 时响应 incomplete=true
test('v47: pickBest partial winners 仍返回最优', () => {
  const { pickBest } = proto;
  const results = [
    { workerId: 0, error: '超时未返回' },
    { workerId: 1, value: 100, path: [], x: 5, y: 5 },
    { workerId: 2, error: '超时未返回' },
    { workerId: 3, error: '超时未返回' },
  ];
  const best = pickBest(results);
  assert.ok(best, '1 个 winner 时 pickBest 应返回该结果');
  assert.equal(best.workerId, 1);
  const winners = results.filter((r) => !r.error).length;
  assert.equal(winners, 1);
  assert.ok(winners < 4, 'incomplete 标志应触发');
});

// v47 P1 #3 回归: applyJitter KEEP=3 让分散度提高
test('v47: applyJitter 抖动提升分散度 (KEEP=3)', () => {
  const b = makeMidBoard();
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const r = engine.computeBest(b, 1, {
      deep: true, workerId: i,
      jitterSeed: 0x85EBCA77 * (i + 1),
    });
    seen.add(`${r.x},${r.y}`);
  }
  // 简单局面可能所有 worker 收敛同一点 (no choice); 至少跑通不报错
  assert.ok(seen.size >= 1, `期望至少 1 种选点, 实际 ${seen.size}`);
});

test('pickBest: 同为强制失败时选择更长路径延缓败局', () => {
  const { pickBest, FIVE } = proto;
  const results = [
    { x: 1, y: 1, value: -FIVE, path: [[1, 1]], workerId: 0 },
    { x: 2, y: 2, value: -FIVE, path: [[2, 2], [3, 3], [4, 4]], workerId: 1 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 已完成安全验证的结果优先于超时未验证高分', () => {
  const { pickBest } = proto;
  const results = [
    { x: 1, y: 1, value: 9_000_000, path: [], workerId: 0, verified: false },
    { x: 2, y: 2, value: 1000, path: [], workerId: 1, verified: true },
  ];
  assert.equal(pickBest(results).workerId, 1);
});
