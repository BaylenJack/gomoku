// 五子棋 AI 提示 worker — 在独立线程跑引擎, 不阻塞主进程事件循环
// 主进程把棋盘发进来, 算完把落点发回。支持普通(3s) / 深度(15s) 两档预算。

'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HINT_PATH = path.join(workerData.publicDir, 'hint.js');

// 两个档位的引擎模块缓存 (vm 编译一次, 之后复用)
const engineCache = { normal: null, deep: null };

function loadEngine(deep) {
  const key = deep ? 'deep' : 'normal';
  if (engineCache[key]) return engineCache[key];
  let src;
  try {
    src = fs.readFileSync(HINT_PATH, 'utf8');
  } catch (e) {
    return { error: '引擎文件读取失败: ' + e.message };
  }
  // 预算替换: 普通 3s/100万节点, 深度 15s/1000万节点
  // v11: 深度版深度 6 → 10 (配合深层威胁过滤 ONLY_THREE_THRESHOLD)
  const [fromNodes, toNodes, fromMs, toMs, fromDepth, toDepth] = deep
    ? ['maxNodes: 400000', 'maxNodes: 10000000', 'maxMs: 1500', 'maxMs: 15000',
       'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6);',
       'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 10);']
    : ['maxNodes: 400000', 'maxNodes: 1000000', 'maxMs: 1500', 'maxMs: 3000', null, null];
  src = src.replace(fromNodes, toNodes).replace(fromMs, toMs);
  if (fromDepth) src = src.replace(fromDepth, toDepth);

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
    vm.runInContext(src, sandbox, { timeout: deep ? 30000 : 10000 });
    const mod = sandbox.module.exports;
    if (!mod || typeof mod.computeBest !== 'function') {
      return { error: '引擎加载异常' };
    }
    engineCache[key] = mod;
    return mod;
  } catch (e) {
    return { error: '引擎编译失败: ' + e.message };
  }
}

parentPort.on('message', (msg) => {
  const engine = loadEngine(msg.deep === true);
  if (engine.error) {
    parentPort.postMessage({ id: msg.id, error: engine.error });
    return;
  }
  const t0 = Date.now();
  let r;
  try {
    // v11.1: 深度版跳过硬性规则, 用满预算深算威胁后续
    r = engine.computeBest(msg.board, msg.color,
      msg.deep === true ? { skipHardRules: true } : undefined);
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: '计算失败: ' + e.message });
    return;
  }
  parentPort.postMessage({
    id: msg.id,
    x: r.x,
    y: r.y,
    ms: Date.now() - t0,
    deep: msg.deep === true,
  });
});
