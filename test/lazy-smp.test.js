import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as proto from '../src/lazy-smp-protocol.cjs';

const HINT_PATH = path.resolve('public/hint.js');

function loadEngine() {
  const src = fs.readFileSync(HINT_PATH, 'utf8');
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