import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

const read = (url) => fs.readFileSync(new URL(url, import.meta.url), 'utf8');
const deepEngine = read('../public/hint.js');
const deepDispatcher = read('../src/hint-worker.cjs');
const deepSearchWorker = read('../src/hint-worker-search.cjs');
const normalEngine = read('../public/hint-normal.js');
const normalDispatcher = read('../src/hint-normal-worker.cjs');
const normalSearchWorker = read('../src/hint-normal-worker-search.cjs');
const app = read('../public/app.js');
const server = read('../src/server.js');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function loadEngine(code) {
  const sandbox = {
    module: { exports: {} }, exports: {}, global: {},
    performance: { now: () => Date.now() }, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 30000 });
  return sandbox.module.exports;
}

function runDispatcher(url, message, timeoutMs = 10000) {
  const worker = new Worker(new URL(url, import.meta.url), {
    workerData: { publicDir: path.resolve('public') },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${url} 测试超时`));
    }, timeoutMs);
    worker.once('error', (error) => {
      clearTimeout(timer);
      worker.terminate();
      reject(error);
    });
    worker.once('message', async (result) => {
      clearTimeout(timer);
      await worker.terminate();
      resolve(result);
    });
    worker.postMessage(message);
  });
}

test('v11.8 深度引擎三个核心文件保持逐字节不变', () => {
  assert.equal(sha256(deepEngine), '4e52c2a4efb73db5de98c15aa50e4bd624f15ba905bf9444146950e1e1650511');
  assert.equal(sha256(deepDispatcher), '6b0763a7a86f090782fff276d97299f6e30e4599381f5ce3e154d5395f30dd5c');
  assert.equal(sha256(deepSearchWorker), 'e468ee982de2ef64f2ea5704a11ed964b879c1de8be71917f070feecd3039dc0');
});

test('普通引擎固定精确5层、500万节点和7秒计算预算', () => {
  assert.match(normalEngine, /const depth = 5;/);
  assert.match(normalEngine, /const nodeBudget = 5000000;/);
  assert.match(normalEngine, /const timeBudgetMs = 7000;/);
  assert.match(normalEngine, /const vctDepth = depth;/);
  assert.doesNotMatch(normalEngine, /if \(d % 2 !== 0\) continue/);
  assert.match(normalDispatcher, /const WORKER_TIMEOUT_MS = 7500;/);
  assert.match(app, /const timeoutMs = 8000;/);
});

test('普通与深度引擎拥有独立文件、Worker池、接口和请求状态', () => {
  assert.match(normalDispatcher, /hint-normal-worker-search\.cjs/);
  assert.match(normalSearchWorker, /hint-normal\.js/);
  assert.match(deepDispatcher, /hint-worker-search\.cjs/);
  assert.match(deepSearchWorker, /hint\.js/);
  assert.doesNotMatch(deepDispatcher, /hint-normal/);
  assert.match(server, /const normalHintWorkers = \[\]/);
  assert.match(server, /new URL\('\.\/hint-normal-worker\.cjs'/);
  assert.match(server, /pathname === '\/hint-normal'/);
  assert.match(app, /const hintRequestSeq = \{ deep: 0, normal: 0 \}/);
  assert.match(app, /const hintAbort = \{ deep: null, normal: null \}/);
});

test('普通按钮在深度按钮右侧且两个模式互斥', () => {
  assert.match(app, /for \(const mode of \['deep', 'normal'\]\)/);
  assert.match(app, /buttonId: 'hintBtn'.*endpoint: '\/hint'/);
  assert.match(app, /buttonId: 'normalHintBtn'.*endpoint: '\/hint-normal'/);
  assert.match(app, /if \(hintMode === mode\)[\s\S]*resetHint\(\)/);
  assert.match(app, /hintMode !== mode \|\| requestSeq !== hintRequestSeq\[mode\]/);
});

test('普通引擎实际完成第5层而不是退化为4层', () => {
  const engine = loadEngine(normalEngine);
  const board = new Array(225).fill(0);
  const at = (x, y) => y * 15 + x;
  for (const [x, y, color] of [
    [5, 7, 1], [6, 7, 2], [7, 7, 1], [8, 7, 2],
    [7, 6, 1], [6, 6, 2], [8, 8, 1], [7, 8, 2],
  ]) board[at(x, y)] = color;
  const result = engine.computeBest(board, 1, {
    deep: true, workerId: 0,
    __testConfig: { depth: 5, maxNodes: 5_000_000, maxMs: 7000 },
  });
  assert.ok(result && Number.isInteger(result.x) && Number.isInteger(result.y));
  assert.ok(result.iterations.some((iteration) => iteration.depth === 5), JSON.stringify(result));
  assert.equal(result.depth, 5);
});

test('两个 dispatcher 可同时运行且返回各自模式标记', async () => {
  const board = new Array(225).fill(0);
  for (let x = 3; x < 7; x++) board[7 * 15 + x] = 1;
  const [deep, normal] = await Promise.all([
    runDispatcher('../src/hint-worker.cjs', { id: 'deep-isolation', board, color: 1 }),
    runDispatcher('../src/hint-normal-worker.cjs', { id: 'normal-isolation', board, color: 1 }),
  ]);
  assert.equal(deep.deep, true);
  assert.equal(deep.normal, undefined);
  assert.equal(normal.normal, true);
  assert.equal(normal.deep, undefined);
  assert.ok((deep.x === 2 || deep.x === 7) && deep.y === 7);
  assert.ok((normal.x === 2 || normal.x === 7) && normal.y === 7);
});

test('普通引擎面对无反击的对手三连会完成5层后正确封堵', async () => {
  const board = new Array(225).fill(0);
  const at = (x, y) => y * 15 + x;
  board[at(3, 7)] = 1;
  for (const x of [4, 5, 6]) board[at(x, 7)] = 2;
  const result = await runDispatcher(
    '../src/hint-normal-worker.cjs',
    { id: 'normal-three-defense', board, color: 1 },
  );
  assert.deepEqual([result.x, result.y], [7, 7], JSON.stringify(result));
  assert.equal(result.depth, 5);
  assert.ok(result.nodes > 0);
});

test('普通引擎复杂中盘四路在8秒窗口内完成精确5层', async () => {
  const board = new Array(225).fill(0);
  const at = (x, y) => y * 15 + x;
  for (const [x, y, color] of [
    [2, 2, 1], [12, 2, 1], [2, 12, 1], [12, 12, 1], [5, 5, 1], [9, 9, 1],
    [7, 2, 2], [2, 7, 2], [12, 7, 2], [7, 12, 2], [5, 9, 2], [9, 5, 2],
  ]) board[at(x, y)] = color;
  const startedAt = Date.now();
  const result = await runDispatcher(
    '../src/hint-normal-worker.cjs',
    { id: 'normal-midgame-budget', board, color: 1 },
    9000,
  );
  const wallMs = Date.now() - startedAt;
  assert.ok(wallMs < 8000, `普通引擎端到端 ${wallMs}ms: ${JSON.stringify(result)}`);
  assert.equal(result.depth, 5, JSON.stringify(result));
  assert.equal(result.votes, 4);
  assert.equal(result.incomplete, false);
});
