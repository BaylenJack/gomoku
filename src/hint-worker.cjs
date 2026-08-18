'use strict';

// v12 深度提示 Dispatcher：四路独立根搜索，完成后按已验证性/必胜值/路径谈合。
const { parentPort, workerData, Worker } = require('node:worker_threads');
const path = require('node:path');

const SEARCH_WORKER_PATH = path.join(__dirname, 'hint-worker-search.cjs');
const NUM_WORKERS = 4;
const WORKER_TIMEOUT_MS = 7500;
const BASE_SEED = 0x7F4A7C15;
const WIN = 10_000_000;

let pool = null;

function compareResults(a, b) {
  const aVerified = a.verified !== false;
  const bVerified = b.verified !== false;
  if (aVerified !== bVerified) return aVerified ? -1 : 1;

  const aWin = a.value >= WIN;
  const bWin = b.value >= WIN;
  if (aWin !== bWin) return aWin ? -1 : 1;
  if (aWin && bWin) {
    const aLength = Array.isArray(a.path) ? a.path.length : Infinity;
    const bLength = Array.isArray(b.path) ? b.path.length : Infinity;
    if (aLength !== bLength) return aLength - bLength;
  }

  const aDepth = Number.isInteger(a.depth) ? a.depth : 0;
  const bDepth = Number.isInteger(b.depth) ? b.depth : 0;
  if (aDepth !== bDepth) return bDepth - aDepth;
  if (a.value !== b.value) return b.value - a.value;
  if (a.nodes !== b.nodes) return b.nodes - a.nodes;
  return a.workerId - b.workerId;
}

function selectBest(results) {
  const valid = results.filter((result) => !result.error && Number.isInteger(result.x) && Number.isInteger(result.y));
  if (!valid.length) return null;
  valid.sort(compareResults);
  return valid[0];
}

function spawnSearchWorker(workerId) {
  const worker = new Worker(SEARCH_WORKER_PATH, {
    workerData: {
      publicDir: workerData.publicDir,
      workerId,
      jitterSeed: Math.imul(BASE_SEED, workerId + 1) >>> 0,
    },
  });
  worker._workerId = workerId;
  worker._dead = false;
  const markDead = (reason) => {
    if (worker._dead) return;
    worker._dead = true;
    console.error(`[hint-v12] search-worker#${workerId} ${reason}`);
  };
  worker.on('error', (error) => markDead(`错误: ${error.message}`));
  worker.on('exit', (code) => markDead(`退出: ${code}`));
  return worker;
}

function ensurePool() {
  if (!pool) pool = Array.from({ length: NUM_WORKERS }, (_, id) => spawnSearchWorker(id));
  for (let id = 0; id < NUM_WORKERS; id++) {
    if (!pool[id] || pool[id]._dead) pool[id] = spawnSearchWorker(id);
  }
  return pool;
}

function runWorker(worker, message) {
  return new Promise((resolve) => {
    if (worker._dead) {
      resolve({ id: message.id, workerId: worker._workerId, error: 'worker 不可用' });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onMessage = (result) => {
      if (result && result.id === message.id) finish(result);
    };
    const onError = (error) => finish({
      id: message.id,
      workerId: worker._workerId,
      error: error.message,
    });
    const onExit = (code) => finish({
      id: message.id,
      workerId: worker._workerId,
      error: `worker 退出: ${code}`,
    });
    const cleanup = () => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    try {
      worker.postMessage(message);
    } catch (error) {
      finish({ id: message.id, workerId: worker._workerId, error: error.message });
    }
  });
}

parentPort.on('message', async (msg) => {
  const startedAt = Date.now();
  const workers = ensurePool();
  const stones = Array.isArray(msg.board) ? msg.board.reduce((n, value) => n + (value ? 1 : 0), 0) : -1;
  console.log(`[hint-v12] 四路搜索开始 id=${msg.id} stones=${stones}`);

  const tasks = workers.map((w) => runWorker(w, {
    id: msg.id,
    board: msg.board,
    color: msg.color,
    deep: true,
  }));
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), WORKER_TIMEOUT_MS).unref();
  });
  const completed = Promise.all(tasks);
  let results = await Promise.race([completed, timeout]);
  if (!results) {
    results = [];
    // 线程内部有 7 秒硬预算，正常不会进入这里；保留明确错误而不是返回旧请求。
    for (let id = 0; id < NUM_WORKERS; id++) {
      results.push({ id: msg.id, workerId: id, error: 'dispatcher 超时' });
    }
  }

  const best = selectBest(results);
  const winners = results.filter((result) => !result.error).length;
  if (!best) {
    parentPort.postMessage({ id: msg.id, error: '深度引擎四路均未返回有效结果' });
    return;
  }

  const summary = results.filter((result) => !result.error).map((result) =>
    `w${result.workerId}=(${result.x},${result.y})/v${result.value}/d${result.depth}/n${result.nodes}`
  ).join(' ');
  console.log(`[hint-v12] 完成 id=${msg.id} ms=${Date.now() - startedAt} ${summary}`);
  parentPort.postMessage({
    id: msg.id,
    x: best.x,
    y: best.y,
    ms: Date.now() - startedAt,
    deep: true,
    engine: best.engine || 'deep-v12',
    votes: winners,
    incomplete: winners < NUM_WORKERS,
    depth: best.depth || 0,
    nodes: best.nodes || 0,
    value: Number.isFinite(best.value) ? best.value : 0,
    verified: best.verified !== false,
    predictedStop: !!best.predictedStop,
    iterations: best.iterations || [],
  });
});
