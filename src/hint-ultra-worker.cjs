'use strict';

// v13 超深度 Dispatcher：四路根分片，在共同完成的最深层上统一比较。
const { parentPort, workerData, Worker } = require('node:worker_threads');
const path = require('node:path');

const SEARCH_WORKER_PATH = path.join(__dirname, 'hint-ultra-worker-search.cjs');
const NUM_WORKERS = 4;
const WORKER_TIMEOUT_MS = 7500;
const WIN = 10_000_000;

let pool = null;

function spawnSearchWorker(workerId) {
  const worker = new Worker(SEARCH_WORKER_PATH, {
    workerData: { publicDir: workerData.publicDir, workerId, workerCount: NUM_WORKERS },
  });
  worker._workerId = workerId;
  worker._dead = false;
  const markDead = (reason) => {
    if (worker._dead) return;
    worker._dead = true;
    console.error(`[hint-ultra] search-worker#${workerId} ${reason}`);
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
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      resolve(result);
    };
    const onMessage = (result) => {
      if (result && result.id === message.id) finish(result);
    };
    const onError = (error) => finish({ id: message.id, workerId: worker._workerId, error: error.message });
    const onExit = (code) => finish({ id: message.id, workerId: worker._workerId, error: `worker 退出: ${code}` });
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

function shortestWin(results) {
  const wins = results.filter((result) => result.verified !== false && result.value >= WIN);
  wins.sort((a, b) => (a.path || []).length - (b.path || []).length || a.workerId - b.workerId);
  return wins[0] || null;
}

function commonDepthChoice(results) {
  const commonDepth = Math.min(...results.map((result) => result.depth || 0));
  const candidates = results.map((result) => {
    const snapshot = (result.iterations || []).find((iteration) => iteration.depth === commonDepth);
    if (snapshot) {
      return {
        ...result,
        x: snapshot.x,
        y: snapshot.y,
        value: snapshot.value,
        depth: commonDepth,
        verified: result.depth === commonDepth ? result.verified : false,
      };
    }
    return { ...result, depth: commonDepth };
  });
  candidates.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    const aVerified = a.verified !== false;
    const bVerified = b.verified !== false;
    if (aVerified !== bVerified) return aVerified ? -1 : 1;
    if (a.nodes !== b.nodes) return b.nodes - a.nodes;
    return a.workerId - b.workerId;
  });
  return candidates[0];
}

parentPort.on('message', async (message) => {
  const startedAt = Date.now();
  const workers = ensurePool();
  const completed = [];
  const task = {
    id: message.id,
    board: message.board,
    color: message.color,
  };
  if (message.__testConfig) task.__testConfig = message.__testConfig;
  const tasks = workers.map((worker) => runWorker(worker, task).then((result) => {
    completed.push(result);
    return result;
  }));
  const timeout = new Promise((resolve) => setTimeout(resolve, WORKER_TIMEOUT_MS).unref());
  await Promise.race([Promise.all(tasks), timeout]);

  if (completed.length < NUM_WORKERS) {
    const returned = new Set(completed.map((result) => result.workerId));
    for (let id = 0; id < NUM_WORKERS; id++) {
      if (returned.has(id)) continue;
      const stale = pool[id];
      stale._dead = true;
      stale.terminate().catch(() => {});
      pool[id] = spawnSearchWorker(id);
    }
  }

  const valid = completed.filter((result) => !result.error && Number.isInteger(result.x) && Number.isInteger(result.y));
  if (!valid.length) {
    parentPort.postMessage({ id: message.id, error: '超深度引擎四个根分片均未返回有效结果' });
    return;
  }
  const best = shortestWin(valid) || commonDepthChoice(valid);
  const totalNodes = valid.reduce((sum, result) => sum + (result.nodes || 0), 0);
  const summary = valid.map((result) =>
    `s${result.workerId}=(${result.x},${result.y})/v${result.value}/d${result.depth}/n${result.nodes}`
  ).join(' ');
  console.log(`[hint-ultra] 完成 id=${message.id} ms=${Date.now() - startedAt} ${summary}`);
  parentPort.postMessage({
    id: message.id,
    x: best.x,
    y: best.y,
    ms: Date.now() - startedAt,
    ultra: true,
    engine: 'ultra-v13',
    votes: valid.length,
    incomplete: valid.length < NUM_WORKERS,
    depth: best.depth || 0,
    nodes: totalNodes,
    value: Number.isFinite(best.value) ? best.value : 0,
    verified: best.verified !== false,
    predictedStop: valid.some((result) => result.predictedStop),
    iterations: best.iterations || [],
  });
});
