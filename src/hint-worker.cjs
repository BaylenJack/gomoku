// 五子棋 AI 深度提示 dispatcher — 在独立线程跑引擎, 不阻塞主进程事件循环。
// 所有请求统一用 4 search worker 的 warm pool 并行
//   (跨请求复用, 避免每次 new Worker 的 VM 编译开销), 不同 jitterSeed 让走法
//   顺序分散, pickBest 选全局最优 (必胜 > value 降序 > path 短 > workerId 小)。

'use strict';

const { parentPort, workerData, Worker } = require('node:worker_threads');
const { pickBest } = require('./lazy-smp-protocol.cjs');
const path = require('node:path');

const SEARCH_WORKER_PATH = path.join(__dirname, 'hint-worker-search.cjs');
const NUM_WORKERS = 4;
// 引擎从 computeBest 入口最多 9s，dispatcher 留 0.5s 给 IPC 和谈合。
const WORKER_TIMEOUT_MS = 9500;
// v47: 独立常量, 避免与 ZB 种子 (0x9E3779B9/0x243F6A88) 撞 —— 同一颗 mulberry32
//   在不同上下文仍确定, 但分散度依赖种子的'独立性', 独立常量让 worker 抖动
//   序列不被 ZB 比特模式支配。
const BASE_SEED = 0x85EBCA77;

// v47: warm pool —— 4 个 search worker 跨请求复用。
//   旧实现每次 deep 请求都 new 4 个 worker (加载 + 编译 VM + 启动 ~50-200ms/个),
//   连续 deep 请求重复付这些开销。warm pool 让 worker 在 dispatcher 生命周期内
//   一直活着, postMessage 派发, 不再 terminate。
//
//   池维护策略:
//   - 首次 deep 请求 lazy 初始化
//   - worker.on('error' / 'exit') 标记 _dead=true
//   - 下次 deep 请求前重建缺失的 worker
//   - 当前 in-flight 请求中的 dead worker 不重新拉起, 推 error 占位让
//     pickBest 仍能从幸存 worker 选最优 (谈合协议设计要求 NUM_WORKERS 个结果)

let searchPool = null;

function spawnSearchWorker(i) {
  const w = new Worker(SEARCH_WORKER_PATH, {
    workerData: {
      publicDir: workerData.publicDir,
      workerId: i,
      jitterSeed: BASE_SEED * (i + 1),
    },
  });
  w._dead = false;
  w._workerId = i;
  const markDead = (reason) => {
    if (w._dead) return;
    w._dead = true;
    console.log(`[hint] search-worker#${i} ${reason}; 下次请求时重建`);
  };
  w.on('error', (e) => markDead(`错误: ${e.message}`));
  w.on('exit', (code) => markDead(code === 0 ? '退出' : `异常退出 code=${code}`));
  return w;
}

function getSearchWorkers() {
  if (searchPool) return searchPool;
  searchPool = [];
  for (let i = 0; i < NUM_WORKERS; i++) searchPool.push(spawnSearchWorker(i));
  return searchPool;
}

function rebuildDeadWorkers() {
  if (!searchPool) return;
  if (searchPool.every((w) => !w._dead)) return;
  // v48.1: 按 workerId 补洞。旧实现 filter 后用数组 length 作为新 id；若中间
  // 的 #1 死亡而 #2/#3 存活，会再创建一个 #3，造成重复 seed、缺失 #1。
  const alive = new Map(searchPool.filter((w) => !w._dead).map((w) => [w._workerId, w]));
  searchPool = Array.from({ length: NUM_WORKERS }, (_, i) => alive.get(i) || spawnSearchWorker(i));
}

parentPort.on('message', async (msg) => {
  const stones = msg.board ? msg.board.filter((c) => c !== 0).length : -1;
  console.log(`[hint] 深度开始: id=${msg.id} 棋子=${stones}`);

    // warm pool 维护 —— 请求前重建缺失的 worker, 不重建当前 in-flight
    //   中已死亡的 worker (避免与已发的 postMessage 冲突, 反正结果由 error
    //   占位即可)。
    rebuildDeadWorkers();
    const workers = getSearchWorkers();
    if (workers.some((w) => w._dead)) {
      console.log(`[hint] Lazy SMP 池部分死亡 (${workers.filter((w) => w._dead).length}/${NUM_WORKERS}), 继续用幸存者`);
    }

    console.log(`[hint] Lazy SMP 开始: id=${msg.id} 棋子=${stones} workers=${NUM_WORKERS}`);
    const results = [];
    const listeners = [];
    const settledWorkers = new Set();
    // error 后通常还会紧接一个 exit；同一 worker 只能结算一次，否则重复占位
    // 会让 results.length 提前达到 4，dispatcher 在其他存活 worker 返回前结束。
    const pushResult = (workerId, result) => {
      if (settledWorkers.has(workerId)) return;
      settledWorkers.add(workerId);
      results.push(result);
    };

    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      if (w._dead) {
        // 已死 worker 直接占位 —— pickBest 仍能从幸存 worker 选最优
        pushResult(i, { id: msg.id, workerId: i, error: 'worker 已死亡' });
        continue;
      }
      // v47: 错误快速标记 —— error/exit 立即 push error 占位, 不再傻等满超时
      const onMsg = (r) => {
        if (r && r.id === msg.id) pushResult(i, r);
      };
      const onErr = (e) => {
        pushResult(i, { id: msg.id, workerId: i, error: '错误: ' + ((e && e.message) || '未知') });
      };
      const onExit = (code) => {
        if (code !== 0) {
          pushResult(i, { id: msg.id, workerId: i, error: '异常退出 code=' + code });
        }
      };
      listeners.push({ w, onMsg, onErr, onExit });
      w.on('message', onMsg);
      w.on('error', onErr);
      w.on('exit', onExit);
      try {
        w.postMessage({ id: msg.id, board: msg.board, color: msg.color, deep: true });
      } catch (e) {
        pushResult(i, { id: msg.id, workerId: i, error: 'postMessage 失败: ' + e.message });
      }
    }

    const t0 = Date.now();
    const deadline = t0 + WORKER_TIMEOUT_MS;
    // 完成条件: 收到 NUM_WORKERS 个响应 (含 error 占位), 或超时
    while (results.length < NUM_WORKERS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // 摘掉本次请求的临时 listener, worker 留着给下次复用
    for (const { w, onMsg, onErr, onExit } of listeners) {
      w.removeListener('message', onMsg);
      w.removeListener('error', onErr);
      w.removeListener('exit', onExit);
    }

    // 兜底: 超时后还没回来的 worker —— 把它们的结果标成 error
    const seenIds = new Set(results.map((r) => r.workerId));
    for (let i = 0; i < workers.length; i++) {
      if (!seenIds.has(i)) pushResult(i, { id: msg.id, workerId: i, error: '超时未返回' });
    }

    const best = pickBest(results);
    const winners = results.filter((r) => !r.error).length;
    const incomplete = winners < NUM_WORKERS;
    if (!best) {
      console.log(`[hint] 失败: id=${msg.id} 所有 worker 失败 (${winners}/${NUM_WORKERS})`);
      parentPort.postMessage({ id: msg.id, error: '所有 worker 失败' });
      return;
    }
    // v47: 日志打印全部 worker 的 value, 便于确认谈合依据真实到位
    const _values = results.filter((r) => !r.error).map((r) =>
      "w" + r.workerId + "=(" + r.x + "," + r.y + ")/v" + r.value + "/d" + r.depth + "/n" + r.nodes
    ).join(" ");
    console.log("[hint] Lazy SMP 结束: id=" + msg.id + " ms=" + (Date.now() - t0) + " winners=" + winners + "/" + 4 + " → (" + best.x + "," + best.y + ") best.value=" + best.value + " [" + _values + "]" + (incomplete ? " [超时]" : ""));
    parentPort.postMessage({
      id: msg.id,
      x: best.x,
      y: best.y,
      ms: Date.now() - t0,
      deep: true,
      votes: winners,
      incomplete,
      depth: best.depth || 0,
      nodes: best.nodes || 0,
    });
});
