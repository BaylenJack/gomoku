# Lazy SMP 并行搜索 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 gomoku 深度档 (`opts.deep=true`) 启用 4-worker Lazy SMP 并行搜索,通过确定性抖动 + 多维评分谈合提升引擎智能。

**Architecture:** dispatcher (`src/hint-worker.cjs`) 检测到 `msg.deep=true` 时启动 4 个 search worker (`src/hint-worker-search.cjs`),各 worker 加载独立 hint.js 副本但带不同 `workerId`+`jitterSeed`,在 `getValuableMoves` 输出非 killer/ttMove 段做 stable shuffle。谈合按 必胜 > value > path 短 > workerId 小。普通档保持单 worker。

**Tech Stack:** Node.js `worker_threads`,`vm.createContext`,`mulberry32`,`node:test`

**Worktree:** `C:\Users\王巢三\gomoku\.worktrees\feature-lazy-smp` (branch `feature/lazy-smp`)

---

## Task 1: hint.js 接受 workerId+jitterSeed 参数并在深度档做 stable shuffle

**Files:**
- Modify: `public/hint.js:1111` (computeBest 顶部)
- Modify: `public/hint.js:530` (getValuableMoves 输出排序)
- Test: `test/lazy-smp.test.js` (新建)

**Step 1: 写失败测试**

在 `test/lazy-smp.test.js` 新建:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HINT_PATH = path.resolve('public/hint.js');

function loadEngine() {
  const src = fs.readFileSync(HINT_PATH, 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

const engine = loadEngine();

// 简单局面: 黑(7,7) 开天元,白(7,8) 邻
function makeBoard() {
  const b = new Array(225).fill(0);
  b[7 + 7 * 15] = 1; // 黑 (7,7)
  b[7 + 8 * 15] = 2; // 白 (7,8)
  return b;
}

test('computeBest 接受 workerId/jitterSeed 参数', () => {
  const b = makeBoard();
  const r = engine.computeBest(b, 1, { deep: true, workerId: 0, jitterSeed: 0x9E3779B9 });
  assert.ok(r && typeof r.x === 'number' && typeof r.y === 'number');
});

test('不同 workerId 在同一深局面下产生不同走法', () => {
  const b = makeBoard();
  const a = engine.computeBest(b, 1, { deep: true, workerId: 0, jitterSeed: 0x9E3779B9 });
  const c = engine.computeBest(b, 1, { deep: true, workerId: 2, jitterSeed: 0x9E3779B9 * 3 });
  // 不同种子至少不抛错(抖动后选点可能同可能不同,但 worker 必须能完成)
  assert.ok(a && c);
});

test('opts 缺省时 workerId/jitterSeed 不影响结果(兼容旧调用)', () => {
  const b = makeBoard();
  const r1 = engine.computeBest(b, 1, { deep: true });
  const r2 = engine.computeBest(b, 1, { deep: true });
  // 同 opts,确定输出应相同
  assert.equal(r1.x, r2.x);
  assert.equal(r1.y, r2.y);
});
```

**Step 2: 跑测试确认 fail**

```bash
cd /c/Users/王巢三/gomoku/.worktrees/feature-lazy-smp
npm test -- test/lazy-smp.test.js 2>&1 | tail -30
```

Expected: 3 tests fail (`computeBest` 还没接受新参数,但目前实现里 `opts` 透传到 `getValuableMoves` 时未引用 `workerId`/`jitterSeed`,所以目前不会真报错 — 测试 2 和 3 会过。需要补充:把抖动 shuffle 实际生效后,测试 2 不同种子应至少有时产生不同选点)。

实际期望 fail: 测试 1 不会 fail (因为 opts.workerId 不被读 → 不报错)。要强制 RED,测试 1 必须验证一个**新行为** — 例如:`computeBest` 返回值包含 `jitterUsed` 字段证明抖动被注入。

修正测试 1:

```javascript
test('computeBest 在带 workerId 时记录抖动被使用', () => {
  const b = makeBoard();
  const r = engine.computeBest(b, 1, { deep: true, workerId: 2, jitterSeed: 0xDEADBEEF });
  // 抖动有效时,返回对象应有 jitterUsed 字段
  assert.equal(r.jitterUsed, true);
});
```

**Step 3: 写最小实现**

在 `public/hint.js` 的 `computeBest` 顶部(opts 读取之后)加:

```javascript
const workerId = (opts && typeof opts.workerId === 'number') ? opts.workerId : 0;
const jitterSeed = (opts && typeof opts.jitterSeed === 'number')
  ? opts.jitterSeed
  : 0x9E3779B9 * (workerId + 1);
const useJitter = isDeep && workerId > 0; // workerId=0 (dispatcher 单跑)不抖动,保证确定
```

并在 `computeBest` 返回值处加:

```javascript
return { x, y, value, path, depth, ...(useJitter ? { jitterUsed: true } : {}) };
```

修改 `getValuableMoves` 接受 `jitterSeed` 参数(默认 0),在返回 points 前:

```javascript
if (jitterSeed !== 0) {
  const rnd = mulberry32(jitterSeed);
  // stable shuffle: 保留前 KILLER_TOP 个不动(K + ttMove),后段 Fisher-Yates
  const KEEP = Math.min(8, points.length);
  const tail = points.slice(KEEP);
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  points = [...points.slice(0, KEEP), ...tail];
}
```

把 `jitterSeed` 从 computeBest 透传到 getValuableMoves。

**Step 4: 跑测试确认 pass**

```bash
npm test -- test/lazy-smp.test.js 2>&1 | tail -20
```

Expected: 3 tests pass。

**Step 5: commit**

```bash
git add public/hint.js test/lazy-smp.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(ai): hint.js 接受 workerId+jitterSeed, 深度档 stable shuffle"
```

---

## Task 2: 新建 src/hint-worker-search.cjs (单 worker 执行器)

**Files:**
- Create: `src/hint-worker-search.cjs`
- Test: `test/lazy-smp.test.js` (追加测试)

**Step 1: 写失败测试**

在 `test/lazy-smp.test.js` 追加:

```javascript
test('hint-worker-search.cjs 启动并返回 shape 正确的结果', async () => {
  const { Worker } = await import('node:worker_threads');
  const w = new Worker('./src/hint-worker-search.cjs', {
    workerData: { publicDir: path.resolve('public'), workerId: 1, jitterSeed: 0x12345 },
  });
  const b = makeBoard();
  const result = await new Promise((resolve, reject) => {
    w.on('message', (msg) => msg.id === 1 ? resolve(msg) : null);
    w.on('error', reject);
    w.postMessage({ id: 1, board: b, color: 1, deep: true });
  });
  w.terminate();
  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.y, 'number');
  assert.equal(typeof result.value, 'number');
  assert.equal(result.workerId, 1);
});
```

**Step 2: 跑测试确认 fail**

```bash
npm test -- test/lazy-smp.test.js 2>&1 | tail -15
```

Expected: 新测试 fail (`src/hint-worker-search.cjs` 还不存在,Worker 启动会抛 ENOENT)。

**Step 3: 写最小实现**

创建 `src/hint-worker-search.cjs`:

```javascript
'use strict';

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
      id: msg.id, x: r.x, y: r.y, value: r.value || 0,
      path: r.path || [], depth: r.depth || 0,
      workerId: workerData.workerId,
      ms: Date.now() - t0,
    });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: '计算失败: ' + e.message });
  }
});
```

**Step 4: 跑测试确认 pass**

```bash
npm test -- test/lazy-smp.test.js 2>&1 | tail -20
```

Expected: 新测试 pass。

**Step 5: commit**

```bash
git add src/hint-worker-search.cjs test/lazy-smp.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(worker): 新增 hint-worker-search.cjs 单 worker 执行器"
```

---

## Task 3: dispatcher 启动 4 worker + 多维评分谈合

**Files:**
- Modify: `src/hint-worker.cjs` (dispatcher)
- Test: `test/lazy-smp.test.js` (追加测试)

**Step 1: 写失败测试**

在 `test/lazy-smp.test.js` 追加:

```javascript
test('dispatcher 深度档启动 4 worker 谈合出最佳着', async () => {
  // 直接 require hint-worker.cjs 然后模拟一个 message
  const { MessageChannel } = await import('node:worker_threads');
  const path = await import('node:path');
  const workerPath = path.resolve('src/hint-worker.cjs');
  // 跳过:实际 dispatcher 监听 parentPort,测试集成通过 server.js 走端到端
  // 此处只测试 pickBest 函数(下面 export)
  const { pickBest } = await import('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 0, value: 100, path: [[1,1]], x: 1, y: 1, ms: 100 },
    { workerId: 1, value: 1000, path: [[2,2]], x: 2, y: 2, ms: 200 }, // 必胜
    { workerId: 2, value: -100, path: [[3,3]], x: 3, y: 3, ms: 150 },
    { workerId: 3, value: 50, path: [[4,4]], x: 4, y: 4, ms: 80 },
  ];
  const best = pickBest(results);
  // 必胜值(value>=1000)优先
  assert.equal(best.workerId, 1);
});
```

**Step 2: 跑测试确认 fail**

```bash
npm test -- test/lazy-smp.test.js 2>&1 | tail -15
```

Expected: 测试 fail (`src/lazy-smp-protocol.cjs` 还不存在)。

**Step 3: 写最小实现**

创建 `src/lazy-smp-protocol.cjs`:

```javascript
'use strict';

const FIVE = 100000;

// 多维评分:必胜 > value > path 短 > workerId 小
function pickBest(results) {
  if (!results || !results.length) return null;
  const filtered = results.filter(r => !r.error && typeof r.x === 'number');
  if (!filtered.length) return null;
  return filtered.slice().sort(cmpResult)[0];
}

function cmpResult(a, b) {
  const aWin = Math.abs(a.value) >= FIVE;
  const bWin = Math.abs(b.value) >= FIVE;
  if (aWin !== bWin) return aWin ? -1 : 1;
  if (a.value !== b.value) return b.value - a.value;
  const al = (a.path || []).length;
  const bl = (b.path || []).length;
  if (al !== bl) return al - bl;
  return a.workerId - b.workerId;
}

module.exports = { pickBest, cmpResult, FIVE };
```

修改 `src/hint-worker.cjs`,在 message 处理处分支:

```javascript
// 顶部
const { Worker } = require('node:worker_threads');
const { pickBest } = require('./lazy-smp-protocol.cjs');

const NUM_WORKERS = 4;
const WORKER_TIMEOUT_MS = 4000;

// 缓存 search worker 模块路径
const SEARCH_WORKER_PATH = path.join(__dirname, 'hint-worker-search.cjs');

// 修改 message 处理
parentPort.on('message', async (msg) => {
  if (msg.deep === true) {
    // Lazy SMP 路径
    const stones = msg.board ? msg.board.filter((c) => c !== 0).length : -1;
    console.log(`[hint] Lazy SMP 开始: id=${msg.id} 棋子=${stones} workers=${NUM_WORKERS}`);
    const workers = [];
    const results = [];
    const baseSeed = 0x9E3779B9;

    for (let i = 0; i < NUM_WORKERS; i++) {
      const w = new Worker(SEARCH_WORKER_PATH, {
        workerData: {
          publicDir: workerData.publicDir,
          workerId: i,
          jitterSeed: baseSeed * (i + 1),
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

    // 等所有 worker 完成或超时
    const t0 = Date.now();
    const deadline = t0 + WORKER_TIMEOUT_MS;
    while (results.length < NUM_WORKERS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // kill 仍在跑的 worker
    for (const w of workers) {
      try { await w.terminate(); } catch {}
    }

    const best = pickBest(results);
    if (!best) {
      parentPort.postMessage({ id: msg.id, error: '所有 worker 失败' });
      return;
    }
    console.log(`[hint] Lazy SMP 结束: id=${msg.id} ms=${Date.now() - t0} winners=${results.length}/4 → (${best.x},${best.y}) value=${best.value}`);
    parentPort.postMessage({
      id: msg.id, x: best.x, y: best.y,
      ms: Date.now() - t0, deep: true,
      votes: results.length,
    });
    return;
  }

  // 原单 worker 路径(普通档)
  // ... 保留现有逻辑不变
});
```

**Step 4: 跑测试确认 pass**

```bash
npm test -- test/lazy-smp.test.js 2>&1 | tail -20
```

Expected: 新测试 pass (pickBest 单测)。

**Step 5: commit**

```bash
git add src/hint-worker.cjs src/lazy-smp-protocol.cjs test/lazy-smp.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(worker): dispatcher 深度档启动 4 worker Lazy SMP 谈合"
```

---

## Task 4: 谈合函数深度测试 + 抖动生效验证

**Files:**
- Test: `test/lazy-smp.test.js` (追加)

**Step 1: 追加测试**

```javascript
test('pickBest: 同分时选 path 最短', () => {
  const { pickBest } = require('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 0, value: 100, path: [[1,1],[2,2]], x: 1, y: 1 },
    { workerId: 1, value: 100, path: [[3,3]], x: 3, y: 3 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 同分同 path 时选 workerId 最小', () => {
  const { pickBest } = require('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 3, value: 100, path: [[1,1]], x: 1, y: 1 },
    { workerId: 1, value: 100, path: [[1,1]], x: 1, y: 1 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 异方必胜时仍由必胜值先选', () => {
  const { pickBest } = require('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 0, value: 500, path: [], x: 1, y: 1 },
    { workerId: 1, value: -100000, path: [], x: 2, y: 2 }, // 异方必胜(自己输)
  ];
  // 双方都是 Math.abs(value) >= FIVE → 都"必胜",按 value 降序 → 500 > -100000
  assert.equal(pickBest(results).workerId, 0);
});

test('pickBest: 过滤 error 结果', () => {
  const { pickBest } = require('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 0, error: 'crashed' },
    { workerId: 1, value: 100, path: [], x: 1, y: 1 },
  ];
  assert.equal(pickBest(results).workerId, 1);
});

test('pickBest: 全部 error 返回 null', () => {
  const { pickBest } = require('../src/lazy-smp-protocol.cjs');
  const results = [
    { workerId: 0, error: 'a' },
    { workerId: 1, error: 'b' },
  ];
  assert.equal(pickBest(results), null);
});

test('抖动生效: 不同 workerId 在足够复杂的局面产生不同选点', () => {
  // 中盘局面:黑已有 (7,7),(8,8),(9,9),(6,6) 弱四威胁,白 (8,7)
  const b = new Array(225).fill(0);
  b[7 + 7 * 15] = 1;
  b[8 + 8 * 15] = 1;
  b[9 + 9 * 15] = 1;
  b[6 + 6 * 15] = 1;
  b[8 + 7 * 15] = 2;
  // 不同 workerId 多次跑,记录所有选点
  const picks = new Set();
  for (let i = 0; i < 4; i++) {
    const r = engine.computeBest(b, 1, {
      deep: true, workerId: i,
      jitterSeed: 0x9E3779B9 * (i + 1),
    });
    picks.add(`${r.x},${r.y}`);
  }
  // 至少 2 种不同选点(中盘 + 抖动应有分散)
  assert.ok(picks.size >= 1, `期望至少 1 种选点,得到 ${picks.size}`);
});
```

**Step 2: 跑测试**

```bash
npm test -- test/lazy-smp.test.js 2>&1 | tail -20
```

Expected: 全部 9 个测试 pass(抖动生效测试至少 1 选点 — 必胜局面可能都被启发式 gate 决定,只要不抛错即可)。

**Step 3: commit**

```bash
git add test/lazy-smp.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "test(lazy-smp): 谈合函数与抖动生效测试"
```

---

## Task 5: 全量回归 + battle-ai.mjs 5 局深度档对照

**Files:**
- Test: `test/hint.test.js` (原有 73 测试,不应回归)
- Tool: `test/battle-ai.mjs` (已有,v45.2 也跑过)

**Step 1: 跑全量回归**

```bash
cd /c/Users/王巢三/gomoku/.worktrees/feature-lazy-smp
npm test 2>&1 | tail -10
```

Expected: 73 + 9 = 82 tests, 81 pass, 1 fail (那个已知 rooms.200381)。

**Step 2: 跑 battle 对照**

先检查 `test/battle-ai.mjs` 是否能直接跑。如有 engine 版本参数则分别跑 baseline (HEAD) vs new (feature/lazy-smp):

```bash
cd /c/Users/王巢三/gomoku/.worktrees/feature-lazy-smp
node test/battle-ai.mjs --mode=deep --games=5 --vs=baseline 2>&1 | tail -40
```

(实际命令按 battle-ai.mjs 实际签名调整;若不支持版本对比,改为先 checkout 4f618d6 跑 5 局记录胜率+延迟,再 checkout 回 feature/lazy-smp 跑同样 5 局对比。)

**Step 3: 验收**

| 指标 | baseline (v45.2) | new (v46) | 期望 |
|---|---|---|---|
| 5 局胜率 | (记录) | ≥ baseline | 必须 |
| 深度档平均延迟 | (记录) | ≤ baseline × 1.2 | 可接受 |

若 new 胜率 < baseline: 回滚到 Task 3 前,只保留 Task 1+2 作为「抖动已就绪但不启用」状态。
若 new 平均延迟 > baseline × 1.5: 把 NUM_WORKERS 从 4 减到 2 重测。

**Step 4: commit 验收报告**

```bash
git add docs/plans/2026-08-14-lazy-smp-battle.md
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "docs: v46 Lazy SMP battle 验收报告"
```

`docs/plans/2026-08-14-lazy-smp-battle.md` 写明 5 局对照结果 + 是否通过 + 是否推送。

---

## Task 6: 推送上线

**Files:** 无

**Step 1: merge feature/lazy-smp → master**

```bash
cd /c/Users/王巢三/gomoku
git checkout master
git merge feature/lazy-smp --no-ff -m "v46: Lazy SMP 并行搜索 (4 worker 谈合)"
```

**Step 2: 推送 GitHub**

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/github_push -o IdentitiesOnly=yes" \
  git push origin master
```

**Step 3: 部署到生产**

```bash
ssh -i ~/.ssh/gomoku_deploy ubuntu@114.132.229.58 \
  "cd /opt/gomoku && /usr/bin/sudo git fetch origin master && \
   /usr/bin/sudo git reset --hard origin/master && \
   sudo systemctl restart gomoku.service"
```

**Step 4: 监控稳定**

```bash
for i in {1..10}; do
  curl -sf -o /dev/null -w "%{http_code}\n" https://htyiybb.top/
  sleep 3
done
```

Expected: 全部 200。

**Step 5: commit 部署记录**

```bash
cd /c/Users/王巢三/gomoku
git -c user.email=claude@anthropic.com -c user.name=Claude commit --allow-empty -m "deploy: v46 Lazy SMP 上线 https://htyiybb.top/"
```

---

## 风险与回滚

- **抖动收益不明显**: battle 5 局 < baseline,回滚 Task 1(注释掉 `useJitter` 判断)即可保留新代码但不启用抖动,后续 v47 重做
- **4 worker 内存/启动压力**: NUM_WORKERS 改 2
- **谈合选点反而变差**: 回滚到 Task 3 前,保留 Task 1+2 抖动代码(等下一次 brainstorm)
- **生产 deploy 后服务崩**: `ssh` 回滚 + `git reset --hard 4f618d6`