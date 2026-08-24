'use strict';

// v13 超深度单路执行器：每个线程只搜索自己负责的根候选分片。
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENGINE_PATH = path.join(workerData.publicDir, 'hint-ultra.js');

function compileEngine() {
  const source = fs.readFileSync(ENGINE_PATH, 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    global: {},
    console,
    performance: { now: () => Date.now() },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: ENGINE_PATH, timeout: 30_000 });
  if (!sandbox.module.exports || typeof sandbox.module.exports.computeBest !== 'function') {
    throw new Error('超深度引擎没有导出 computeBest');
  }
  return sandbox.module.exports;
}

let engine;
let compileError = null;
try {
  engine = compileEngine();
} catch (error) {
  compileError = error;
}

parentPort.on('message', (message) => {
  if (compileError) {
    parentPort.postMessage({
      id: message.id,
      workerId: workerData.workerId,
      error: `超深度引擎编译失败: ${compileError.message}`,
    });
    return;
  }
  const startedAt = Date.now();
  try {
    const options = {
      shardIndex: workerData.workerId,
      shardCount: workerData.workerCount,
      proof: workerData.workerId === 0,
    };
    if (message.__testConfig) options.__testConfig = message.__testConfig;
    const result = engine.computeBest(message.board, message.color, options);
    parentPort.postMessage({
      id: message.id,
      workerId: workerData.workerId,
      x: result.x,
      y: result.y,
      value: Number.isFinite(result.value) ? result.value : 0,
      path: Array.isArray(result.path) ? result.path : [],
      depth: Number.isInteger(result.depth) ? result.depth : 0,
      nodes: Number.isFinite(result.nodes) ? result.nodes : 0,
      verified: result.verified !== false,
      predictedStop: !!result.predictedStop,
      iterations: Array.isArray(result.iterations) ? result.iterations : [],
      engine: result.engine || 'ultra-v13',
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      workerId: workerData.workerId,
      error: `超深度搜索失败: ${error.message}`,
      ms: Date.now() - startedAt,
    });
  }
});
