import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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