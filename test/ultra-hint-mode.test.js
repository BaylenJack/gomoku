import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const ultraSource = read('../public/hint-ultra.js');
const dispatcher = read('../src/hint-ultra-worker.cjs');
const searchWorker = read('../src/hint-ultra-worker-search.cjs');
const app = read('../public/app.js');
const style = read('../public/style.css');
const server = read('../src/server.js');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(ultraSource, sandbox);
const engine = sandbox.self.GomokuUltraHint;
const at = (x, y) => y * 15 + x;
const empty = () => new Array(225).fill(0);
const quick = { __testConfig: { depth: 6, maxNodes: 400_000, maxMs: 600 } };

test('新增超深度引擎没有修改普通与 v12 六个核心文件', () => {
  assert.equal(sha256(read('../public/hint.js')), 'f1694b1d9dcd4de43fd87d25b6b28e6ea7e6ff2b245b180eb7823c48c358f416');
  assert.equal(sha256(read('../src/hint-worker.cjs')), 'a10b22460220c704e822316ad73a29c2e4a2cbc4a1bf2fa9bbeac4f731b3b6a9');
  assert.equal(sha256(read('../src/hint-worker-search.cjs')), '0161d8e008705f55d71f23b3283ebef9e1a22947fbf92939142abb28ea08044b');
  assert.equal(sha256(read('../public/hint-normal.js')), 'a8d8e6d9170131b23cc1cc2b0207e4fb314e9879c74eb4b35d7e11bf6e81527f');
  assert.equal(sha256(read('../src/hint-normal-worker.cjs')), '808e3296d25a553929b44ef82b1460e24a5bd77a5488e4abc5ee8cc4486f951b');
  assert.equal(sha256(read('../src/hint-normal-worker-search.cjs')), '547756d500a947e0f15dbd994a5644e4f6aa8a0dc9945e4735218be2c0154d52');
});

test('超深度生产预算固定为14层、6000万节点和6.8秒', () => {
  assert.match(ultraSource, /v13\.0/);
  assert.match(ultraSource, /const depth = 14;/);
  assert.match(ultraSource, /const nodeBudget = 60000000;/);
  assert.match(ultraSource, /const timeBudgetMs = 6800;/);
  assert.match(dispatcher, /const NUM_WORKERS = 4;/);
  assert.match(dispatcher, /const WORKER_TIMEOUT_MS = 7500;/);
  assert.match(app, /const timeoutMs = 8000;/);
});

test('超深度拥有独立文件、根分片 Worker 池、接口和可见按钮', () => {
  assert.match(searchWorker, /hint-ultra\.js/);
  assert.match(dispatcher, /hint-ultra-worker-search\.cjs/);
  assert.match(dispatcher, /commonDepthChoice/);
  assert.match(server, /const ultraHintWorkers = \[\]/);
  assert.match(server, /hint-ultra-worker\.cjs/);
  assert.match(server, /pathname === '\/hint-ultra'/);
  assert.match(app, /buttonId: 'ultraHintBtn'.*endpoint: '\/hint-ultra'/);
  assert.match(app, /\['ultra', 'deep', 'normal'\]/);
  assert.match(style, /\.btn-hint\.ultra/);
  assert.doesNotMatch(dispatcher, /hint-normal|hint-worker-search\.cjs/);
});

test('直接胜点和对手直接胜点拥有最高优先级', () => {
  for (const role of [1, 2]) {
    const own = empty();
    for (let x = 3; x <= 6; x++) own[at(x, 7)] = role;
    const win = engine.computeBest(own, role, quick);
    assert.ok(win.y === 7 && (win.x === 2 || win.x === 7), JSON.stringify(win));
    assert.equal(win.value, 10_000_000);

    const defend = empty();
    for (let x = 3; x <= 6; x++) defend[at(x, 7)] = role;
    defend[at(0, 0)] = role === 1 ? 2 : 1;
    const block = engine.computeBest(defend, role === 1 ? 2 : 1, quick);
    assert.ok(block.y === 7 && (block.x === 2 || block.x === 7), JSON.stringify(block));
  }
});

test('对手活三与跳三必须搜索后封堵，并且不污染输入', () => {
  const cases = [
    { stones: [[4,7], [5,7], [6,7]], allowed: [[3,7], [7,7]] },
    { stones: [[5,7], [6,7], [8,7]], allowed: [[4,7], [7,7], [9,7]] },
  ];
  for (const { stones, allowed } of cases) {
    const board = empty();
    for (const [x, y] of stones) board[at(x, y)] = 2;
    board[at(1, 1)] = 1;
    board[at(11, 11)] = 1;
    const before = board.slice();
    const result = engine.computeBest(board, 1, quick);
    assert.ok(allowed.some(([x, y]) => result.x === x && result.y === y), JSON.stringify(result));
    assert.ok(result.nodes > 0 && result.depth >= 2, JSON.stringify(result));
    assert.deepEqual(board, before);
  }
});

test('增量线评分、点位棋形和双哈希在 move/undo 后完全一致', () => {
  const board = empty();
  for (const [x, y, color] of [[7,7,1], [8,8,2], [6,7,1], [8,7,2], [5,6,1], [9,8,2]]) {
    board[at(x, y)] = color;
  }
  assert.equal(engine.__test__.incrementalConsistency(board), true);
});

test('四路根分片在缩减预算下共同返回合法结果', async () => {
  const worker = new Worker(new URL('../src/hint-ultra-worker.cjs', import.meta.url), {
    workerData: { publicDir: path.resolve('public') },
  });
  const board = empty();
  for (const [x, y, color] of [
    [2,2,1], [12,2,1], [2,12,1], [12,12,1], [5,5,1], [9,9,1],
    [7,2,2], [2,7,2], [12,7,2], [7,12,2], [5,9,2], [9,5,2],
  ]) board[at(x, y)] = color;
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超深度分片测试超时')), 4000);
      worker.once('error', reject);
      worker.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.postMessage({
        id: 'ultra-shards', board, color: 1,
        __testConfig: { depth: 6, maxNodes: 500_000, maxMs: 700 },
      });
    });
    assert.equal(result.ultra, true);
    assert.equal(result.engine, 'ultra-v13');
    assert.equal(result.votes, 4, JSON.stringify(result));
    assert.equal(result.incomplete, false, JSON.stringify(result));
    assert.ok(result.depth >= 2 && result.nodes > 0, JSON.stringify(result));
    assert.equal(board[at(result.x, result.y)], 0);
  } finally {
    await worker.terminate();
  }
});
