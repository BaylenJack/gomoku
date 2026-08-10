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
  // 预算替换: 普通 3s/100万节点, 深度 30s/3000万节点
  // v11: 深度版深度 6 → 10 (配合深层威胁过滤 ONLY_THREE_THRESHOLD)
  const [fromNodes, toNodes, fromMs, toMs, fromDepth, toDepth] = deep
    ? ['maxNodes: 400000', 'maxNodes: 30000000', 'maxMs: 1500', 'maxMs: 30000',
       'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6);',
       'const depth = stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 10);']
    : ['maxNodes: 400000', 'maxNodes: 1000000', 'maxMs: 1500', 'maxMs: 3000', null, null];
  const origSrc = src; // 替换前原文 —— 命中检查必须对照它
  src = src.replace(fromNodes, toNodes).replace(fromMs, toMs);
  if (fromDepth) src = src.replace(fromDepth, toDepth);
  // 预算替换命中检查 —— 替换静默失效会让"深度档"悄悄退回普通档。
  // 注意不能查 !src.includes(fromMs): 'maxMs: 15000' 包含子串 'maxMs: 1500',
  // 用替换前的原文判断 from 存在、替换后 to 已出现。
  // actual 检查用词边界正则防止子串误判: 'maxMs: 3000' 是 'maxMs: 30000' 的子串。
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expected = [fromNodes, fromMs, ...(deep ? [fromDepth] : [])].filter(Boolean);
  const actual = deep ? [toNodes, toMs, toDepth] : [toNodes, toMs];
  const hit = expected.every((f) => origSrc.includes(f))
    && actual.every((t) => new RegExp('\\b' + escapeRe(t) + '\\b').test(src));
  if (!hit) {
    console.error(`[hint] 预算替换未命中: ${key} 档 —— 档位预算失效!`);
  } else {
    console.log(`[hint] 引擎加载: ${key} 档 (${deep ? '30s/3000万节点/深度10-12' : '3s/100万节点/深度6'})`);
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
    vm.runInContext(src, sandbox, { timeout: deep ? 60000 : 10000 });
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
  const stones = msg.board ? msg.board.filter((c) => c !== 0).length : -1;
  // v11.2: 请求/完成日志 —— 服务端日志只看到总耗时, worker 侧能定位档位分配
  console.log(`[hint] 开始: id=${msg.id} deep=${msg.deep === true} 棋子=${stones}`);
  const engine = loadEngine(msg.deep === true);
  if (engine.error) {
    console.log(`[hint] 失败: id=${msg.id} ${engine.error}`);
    parentPort.postMessage({ id: msg.id, error: engine.error });
    return;
  }
  const t0 = Date.now();
  let r;
  try {
    // v11.2: skipHardRules 只跳过可选反推(2c); 硬性防守(2b)在引擎内无条件执行
    r = engine.computeBest(msg.board, msg.color,
      msg.deep === true ? { skipHardRules: true } : undefined);
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
    deep: msg.deep === true,
  });
});
