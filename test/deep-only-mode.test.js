import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const dispatcher = fs.readFileSync(new URL('../src/hint-worker.cjs', import.meta.url), 'utf8');
const engine = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');

test('提示按钮单击直接启动唯一的深度模式', () => {
  assert.match(app, /btn\.addEventListener\('click'/);
  assert.match(app, /JSON\.stringify\(\{ board, color, token: TOKEN \}\)/);
  assert.doesNotMatch(app, /pointerdown|pointerup|longPressFired|hintDeep/);
  assert.doesNotMatch(app, /普通提示|🤖 普通|computeHintLocal|hintWorker/);
});

test('服务端忽略客户端档位并固定返回深度结果', () => {
  assert.match(server, /requestHint\(board, color\)/);
  assert.match(server, /deep: true/);
  assert.doesNotMatch(server, /body\.deep/);
});

test('dispatcher 只保留 Lazy SMP 深度路径', () => {
  assert.match(dispatcher, /w\.postMessage\(\{ id: msg\.id, board: msg\.board, color: msg\.color, deep: true \}\)/);
  assert.doesNotMatch(dispatcher, /msg\.deep|loadEngine|computeBest\(msg\.board/);
});

test('深度模式固定为 10 层、3000 万节点并受 10 秒端到端窗口约束', () => {
  assert.match(engine, /v11\.7/);
  assert.match(engine, /const depth = 10;/);
  assert.match(engine, /const nodeBudget = 30000000;/);
  assert.match(engine, /const timeBudgetMs = 9000;/);
  assert.match(dispatcher, /const WORKER_TIMEOUT_MS = 9500;/);
  assert.match(app, /const timeoutMs = 10000;/);
});

test('dispatcher 收到不带 deep 的请求仍执行深度搜索', async () => {
  const worker = new Worker(new URL('../src/hint-worker.cjs', import.meta.url), {
    workerData: { publicDir: path.resolve('public') },
  });
  const board = new Array(225).fill(0);
  for (let x = 3; x < 7; x++) board[7 * 15 + x] = 1;
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dispatcher 测试超时')), 20000);
      worker.once('error', reject);
      worker.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.postMessage({ id: 'deep-only-test', board, color: 1 });
    });
    assert.equal(result.deep, true);
    assert.ok((result.x === 2 || result.x === 7) && result.y === 7);
  } finally {
    await worker.terminate();
  }
});

test('四路深度 dispatcher 对三连必须深搜，反击时必须证明必胜', async () => {
  const worker = new Worker(new URL('../src/hint-worker.cjs', import.meta.url), {
    workerData: { publicDir: path.resolve('public') },
  });
  const board = new Array(225).fill(0);
  const idx = (x, y) => y * 15 + x;
  board[idx(3, 7)] = 1;
  for (const x of [4,5,6]) board[idx(x, 7)] = 2;
  for (const [x, y] of [[9,5],[11,5],[10,4],[10,6]]) board[idx(x, y)] = 1;
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('三连 dispatcher 测试超时')), 20000);
      worker.once('error', reject);
      worker.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.postMessage({ id: 'three-defense-test', board, color: 1 });
    });
    const blocked = result.x === 7 && result.y === 7;
    const provenCounterattack = result.x === 10 && result.y === 5 && result.value >= 10_000_000;
    assert.ok(blocked || provenCounterattack, `三连局面返回未经证明的走法: ${JSON.stringify(result)}`);
    assert.ok(result.nodes > 0 && result.depth >= 2, `三连局面没有进入深搜: ${JSON.stringify(result)}`);
    assert.equal(result.deep, true);
  } finally {
    await worker.terminate();
  }
});
