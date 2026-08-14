// 五子棋 AI 提示 worker — 在独立线程跑引擎, 不阻塞主进程事件循环
// 主进程把棋盘发进来, 算完把落点发回。支持普通(3s) / 深度(15s) 两档预算。

'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HINT_PATH = path.join(workerData.publicDir, 'hint.js');

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

parentPort.on('message', (msg) => {
  const stones = msg.board ? msg.board.filter((c) => c !== 0).length : -1;
  // v45: deep 模式由引擎原生 opts.deep 控制 —— 不再需要字符串替换升预算
  const deep = msg.deep === true;
  console.log(`[hint] 开始: id=${msg.id} deep=${deep} 棋子=${stones}`);
  const engine = loadEngine();
  if (engine.error) {
    console.log(`[hint] 失败: id=${msg.id} ${engine.error}`);
    parentPort.postMessage({ id: msg.id, error: engine.error });
    return;
  }
  const t0 = Date.now();
  let r;
  try {
    r = engine.computeBest(msg.board, msg.color,
      deep ? { deep: true } : undefined);
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
