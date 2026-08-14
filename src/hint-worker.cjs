// 五子棋 AI 提示 worker — 在独立线程跑引擎, 不阻塞主进程事件循环
// 主进程把棋盘发进来, 算完把落点发回。支持普通(3s) / 深度(15s) 两档预算。
// v46: 深度档 (msg.deep=true) 启动 4 个 search worker 做 Lazy SMP, 谈合出最佳着;
//   普通档保持单 worker 路径不变。

'use strict';

const { parentPort, workerData, Worker } = require('node:worker_threads');
const { pickBest } = require('./lazy-smp-protocol.cjs');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HINT_PATH = path.join(workerData.publicDir, 'hint.js');
const SEARCH_WORKER_PATH = path.join(__dirname, 'hint-worker-search.cjs');
const NUM_WORKERS = 4;
const WORKER_TIMEOUT_MS = 4000;
const BASE_SEED = 0x9E3779B9;

// v45: 引擎模块缓存(单实例) —— 编译一次, 后续请求复用。
// 原"两档分别缓存"是因为深度档通过字符串替换升级预算才需要两套实例;
// 现在 opts.deep 在引擎内部原生支持, 一份引擎模块就够, 减少 VM 内存占用。
let cachedEngine = null;
function loadEngine() {
  if (cachedEngine) return cachedEngine;
  let src;
  try {
    src = fs.readFileSync(HINT_PATH, 'utf8');
  } catch (e) {
    return { error: '引擎文件读取失败: ' + e.message };
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    global: {},
    self: undefined,
    performance: { now: () => Date.now() },
    console,
  };
  sandbox.globalThis = sandbox;
  try {
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { timeout: 30000 });
    const mod = sandbox.module.exports;
    if (!mod || typeof mod.computeBest !== 'function') {
      return { error: '引擎加载异常' };
    }
    cachedEngine = mod;
    return mod;
  } catch (e) {
    return { error: '引擎编译失败: ' + e.message };
  }
}

parentPort.on('message', async (msg) => {
  const stones = msg.board ? msg.board.filter((c) => c !== 0).length : -1;
  // v45: deep 模式由引擎原生 opts.deep 控制 —— 不再需要字符串替换升预算
  const deep = msg.deep === true;
  console.log(`[hint] 开始: id=${msg.id} deep=${deep} 棋子=${stones}`);

  // v46 Lazy SMP: 深度档启动 4 worker 并行, 不同 jitterSeed 让走法顺序分散,
  //   谈合后选全局最优 (必胜 > value > path 短 > workerId 小)。
  if (deep) {
    console.log(`[hint] Lazy SMP 开始: id=${msg.id} 棋子=${stones} workers=${NUM_WORKERS}`);
    const workers = [];
    const results = [];

    for (let i = 0; i < NUM_WORKERS; i++) {
      const w = new Worker(SEARCH_WORKER_PATH, {
        workerData: {
          publicDir: workerData.publicDir,
          workerId: i,
          jitterSeed: BASE_SEED * (i + 1),
        },
      });
      workers.push(w);
      w.on('message', (r) => {
        if (r.id === msg.id) results.push(r);
      });
      w.on('error', (e) => {
        console.log(`[hint] worker#${i} 错误: ${e.message}`);
      });
      w.postMessage({ id: msg.id, board: msg.board, color: msg.color, deep: true });
    }

    const t0 = Date.now();
    const deadline = t0 + WORKER_TIMEOUT_MS;
    while (results.length < NUM_WORKERS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const w of workers) {
      try { await w.terminate(); } catch (_) { /* ignore */ }
    }

    const best = pickBest(results);
    if (!best) {
      console.log(`[hint] 失败: id=${msg.id} 所有 worker 失败`);
      parentPort.postMessage({ id: msg.id, error: '所有 worker 失败' });
      return;
    }
    console.log(`[hint] Lazy SMP 结束: id=${msg.id} ms=${Date.now() - t0} winners=${results.length}/${NUM_WORKERS} → (${best.x},${best.y}) value=${best.value}`);
    parentPort.postMessage({
      id: msg.id,
      x: best.x,
      y: best.y,
      ms: Date.now() - t0,
      deep: true,
      votes: results.length,
    });
    return;
  }

  const engine = loadEngine();
  if (engine.error) {
    console.log(`[hint] 失败: id=${msg.id} ${engine.error}`);
    parentPort.postMessage({ id: msg.id, error: engine.error });
    return;
  }
  const t0 = Date.now();
  let r;
  try {
    r = engine.computeBest(msg.board, msg.color, undefined);
  } catch (e) {
    console.log(`[hint] 失败: id=${msg.id} 计算失败: ${e.message}`);
    parentPort.postMessage({ id: msg.id, error: '计算失败: ' + e.message });
    return;
  }
  console.log(`[hint] 结束: id=${msg.id} ms=${Date.now() - t0} → (${r.x},${r.y})`);
  parentPort.postMessage({
    id: msg.id,
    x: r.x,
    y: r.y,
    ms: Date.now() - t0,
    deep,
  });
});
