import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import * as proto from '../src/lazy-smp-protocol.cjs';

const source = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');
const sandbox = {
  module: { exports: {} }, exports: {}, console,
  performance: { now: () => Date.now() },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const engine = sandbox.module.exports;

function makeBoard() {
  const board = new Array(225).fill(0);
  for (const [x, y, color] of [[7,7,1], [8,7,2], [7,8,1], [8,8,2], [6,7,1], [9,8,2]]) {
    board[y * 15 + x] = color;
  }
  return board;
}

test('v12 computeBest 接受 workerId 并返回可谈合元数据', () => {
  const result = engine.computeBest(makeBoard(), 1, {
    deep: true,
    workerId: 2,
    jitterSeed: 0xDEADBEEF,
    __testConfig: { depth: 4, maxNodes: 150_000, maxMs: 400 },
  });
  assert.equal(result.engine, 'deep-v12');
  assert.equal(typeof result.value, 'number');
  assert.ok(Array.isArray(result.path));
  assert.equal(typeof result.verified, 'boolean');
});

test('v12 单路搜索 worker 启动并返回完整结果形状', async () => {
  const worker = new Worker(new URL('../src/hint-worker-search.cjs', import.meta.url), {
    workerData: { publicDir: path.resolve('public'), workerId: 1, jitterSeed: 0x12345 },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('单路搜索超时')), 8000);
      worker.once('error', reject);
      worker.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.postMessage({ id: 'v12-worker-shape', board: makeBoard(), color: 1, deep: true });
    });
    assert.equal(result.workerId, 1);
    assert.equal(result.engine, 'deep-v12');
    assert.equal(typeof result.x, 'number');
    assert.equal(typeof result.value, 'number');
    assert.ok(Array.isArray(result.iterations));
  } finally {
    await worker.terminate();
  }
});

test('普通引擎仍使用的旧谈合协议按已验证性与分值选择', () => {
  const results = [
    { workerId: 0, value: 9_000_000, verified: false, path: [], x: 1, y: 1 },
    { workerId: 1, value: 1000, verified: true, path: [], x: 2, y: 2 },
    { workerId: 2, error: 'crashed' },
  ];
  assert.equal(proto.pickBest(results).workerId, 1);
});

test('普通谈合协议同分选择更短胜路并以 workerId 稳定兜底', () => {
  const shorter = proto.pickBest([
    { workerId: 0, value: 100, path: [[1,1], [2,2]], x: 1, y: 1 },
    { workerId: 2, value: 100, path: [[3,3]], x: 3, y: 3 },
  ]);
  assert.equal(shorter.workerId, 2);
  const stable = proto.pickBest([
    { workerId: 3, value: 100, path: [[1,1]], x: 1, y: 1 },
    { workerId: 1, value: 100, path: [[2,2]], x: 2, y: 2 },
  ]);
  assert.equal(stable.workerId, 1);
});

test('普通谈合协议过滤错误结果且全错时返回 null', () => {
  assert.equal(proto.pickBest([
    { workerId: 0, error: 'a' },
    { workerId: 1, value: 10, path: [], x: 1, y: 1 },
  ]).workerId, 1);
  assert.equal(proto.pickBest([{ error: 'a' }, { error: 'b' }]), null);
});
