'use strict';

// v46 Lazy SMP 单 worker 执行器 —— dispatcher (hint-worker.cjs) 启动 4 个本 worker,
//   各加载独立 hint.js 副本但带不同 workerId + jitterSeed, 走法顺序分散 → 谈合时
//   选全局最优。workerData 由 dispatcher 注入 (publicDir / workerId / jitterSeed),
//   主线程 postMessage 派发 { id, board, color, deep }, worker 回 { id, x, y, value,
//   path, depth, workerId, ms }。错误以 { id, error } 形式回传, 不抛崩 worker。

const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HINT_PATH = path.join(workerData.publicDir, 'hint.js');

function loadEngine() {
  let src;
  try { src = fs.readFileSync(HINT_PATH, 'utf8'); }
  catch (e) { return { error: '引擎文件读取失败: ' + e.message }; }
  const sandbox = {
    module: { exports: {} }, exports: {}, global: {},
    performance: { now: () => Date.now() }, console,
  };
  sandbox.globalThis = sandbox;
  try {
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { timeout: 30000 });
    return sandbox.module.exports;
  } catch (e) { return { error: '引擎编译失败: ' + e.message }; }
}

const engine = loadEngine();

parentPort.on('message', (msg) => {
  if (engine.error) {
    parentPort.postMessage({ id: msg.id, error: engine.error });
    return;
  }
  const t0 = Date.now();
  try {
    const r = engine.computeBest(msg.board, msg.color, {
      deep: msg.deep === true,
      workerId: workerData.workerId,
      jitterSeed: workerData.jitterSeed,
    });
    parentPort.postMessage({
      id: msg.id,
      x: r.x, y: r.y,
      value: r.value || 0,
      path: r.path || [],
      depth: r.depth || 0,
      workerId: workerData.workerId,
      ms: Date.now() - t0,
    });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: '计算失败: ' + e.message });
  }
});