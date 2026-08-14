# Lazy SMP 并行搜索 — 设计文档

**项目**：gomoku（https://htyiybb.top/）
**目标版本**：v46
**作者**：Claude + 用户 brainstorming
**日期**：2026-08-14

---

## 1. 背景与动机

v45 系列（深档 15s/3000 万预算、历史启发、TT 排序、cross-bonus、阶段 DEF_RATIO、扩展开局库）已上线 4f618d6，但 battle-ai.mjs 实战对照旧引擎（v11.7+patch）结果 1:2，深度档平均延迟 565ms vs 569ms — **几乎没差**。

根因诊断：
- 中位延迟 9ms（多数走子被启发式 gate 直接 return）
- 深度档真正进搜索树的局面 < 20%
- 引擎强度被「启发式质量」而非「搜索深度」卡住
- 单线程 ID + AB 已是搜索深度上限

**Lazy SMP** 是并行搜索的经典解：用同一份静态数据 + 不同抖动并行跑同一棵树不同分支，谈合出最佳着。在深度档收益最大（耗时够长），且实现风险可控。

---

## 2. 设计目标

| 项 | 数值 |
|---|---|
| 并行 worker 数 | 4（深度档专用） |
| 谈合策略 | 多维评分（value / path 长度 / 必胜标志） |
| 共享状态 | Zobrist 表 / 开局库 / 棋形正则 / HISTORY — 每个 worker 启动时独立加载一份只读副本 |
| TT 共享 | ❌ **不做**（v45 引擎 TT 是 JS Map，SharedArrayBuffer 不可用，且 1397 行深度耦合） |
| 抖动源 | `mulberry32(workerId * 0x9E3779B9)` 确定性种子 |
| 普通档 | 不动（保持单 worker，单次延迟 < 100ms） |
| 延迟预算 | 深度档 15s 不变，谈合后 ≥ min(单 worker 延迟, 谈合延迟) |
| 验收 | battle-ai.mjs 5 局深度档胜率 + 平均/中位延迟 |

---

## 3. 架构

### 3.1 现状（v45.2）

```
server.js hint request
    ↓
hint-worker.cjs (单 worker)
    ↓
vm.createContext + runInContext(hint.js)
    ↓
engine.computeBest(board, color, opts)
    ├── opts.deep=true → MAX_BUDGET 搜索
    └── opts 缺省 → 1.5s/4M 启发式优先
```

### 3.2 目标（v46）

```
server.js hint request (deep=true)
    ↓
hint-worker.cjs (dispatcher, 当前 worker)
    ├── spawn search worker #0 (seed=0x9E3779B9 * 0)
    ├── spawn search worker #1 (seed=0x9E3779B9 * 1)
    ├── spawn search worker #2 (seed=0x9E3779B9 * 2)
    └── spawn search worker #3 (seed=0x9E3779B9 * 3)
        每个 worker:
          ├── 加载 hint.js 到独立 vm 上下文（只读副本）
          ├── 注入 workerId + jitterSeed
          └── computeBest(board, color, { deep, jitter, workerId })
    ↓
dispatcher 收 4 个结果, 多维评分谈合
    ↓
返回 { x, y, ms, deep, votes }
```

### 3.3 普通档

保持单 worker，不变。Dispatcher 检测 `msg.deep === false` 时直接走原路径。

---

## 4. 关键组件

### 4.1 `src/hint-worker.cjs`（dispatcher）

新增 API：
- `runSingle(msg)` — 原路径，普通档用
- `runLazySMP(msg)` — 新路径，深度档用
  - 启动 4 个 `worker_threads.Worker`，每个跑 `hint-worker-search.cjs`
  - 共享 `publicDir` + 给每个 worker `workerId: 0..3`
  - `Promise.race` 等待首个结果不退出，等全部完成（Lazy SMP 要 4 路谈合）
  - 超时控制：单个 worker 4s 上限（4 worker 并行后单 worker 不需要跑满 15s）
  - 多维评分谈合

### 4.2 `src/hint-worker-search.cjs`（新文件，搜索 worker）

复刻当前 `hint-worker.cjs` 的 `loadEngine()` 逻辑，但：
- `workerData.workerId` 注入到 vm sandbox 的 `globalThis.__WORKER_ID__`
- `workerData.jitterSeed` 注入到 `globalThis.__JITTER_SEED__`
- 计算完后 `parentPort.postMessage({ id, x, y, value, ms, workerId, path })`

### 4.3 `public/hint.js` 改动（最小化）

**只加抖动源**：

```js
// 在 computeBest 顶部
const isDeep = !!(opts && opts.deep === true);
const workerId = (opts && typeof opts.workerId === 'number') ? opts.workerId : 0;
const jitterSeed = (opts && typeof opts.jitterSeed === 'number')
  ? opts.jitterSeed
  : 0x9E3779B9 * (workerId + 1);

// 在 getValuableMoves 调用前,如果 isDeep && workerId > 0：
if (isDeep) {
  // 拿一个抖动函数,只在 getValuableMoves 输出排序时用
  const jitter = mulberry32(jitterSeed);
  points = stableShuffle(points, jitter); // 不破坏 killer/ttMove 顺序,只对后段随机
}
```

**关键约束**：
- 不动搜索核心、不动 TT 写入、不动 BUDGET 异常
- 不动非深度档路径
- `stableShuffle` 保留前 N 个杀手 + ttMove 顺序（这些是已被验证的强走法）

### 4.4 共享 vs 复制

| 数据 | 共享方式 | 理由 |
|---|---|---|
| Zobrist 表（`ZB` / `ZB2`） | 每个 worker 复制一份 Uint32Array | 只读，副本成本 2KB × 4 = 8KB，可忽略 |
| 棋形正则（`PAT`） | vm sandbox 重新编译 | regex 对象不可跨 vm 边界，编译 1ms |
| 开局库（`OPENING_BOOK`） | 每个 worker 复制一份 plain object | 只读，3KB × 4 = 12KB |
| HISTORY（搜索中累积） | **不复用**（每 worker 独立） | 抖动就要让搜索树走不同分支 |
| TT（JS Map） | **不复用**（每 worker 独立） | JS Map 不可 SharedArrayBuffer 化 |

---

## 5. 谈合协议（多维评分）

```js
function pickBest(results) {
  // 1. 必胜优先
  const winners = results.filter(r => Math.abs(r.value) >= FIVE);
  if (winners.length) {
    // 同方必胜取最短 path,异方必胜选最长 path(让对方赢最少)
    return winners.reduce((best, r) => isBetterWin(best, r), winners[0]);
  }
  // 2. 高分优先（value 降序）
  // 3. 同分选 path 短（更快赢/更慢输）
  // 4. 同 path 选 workerId 最小（确定性）
  return results.sort(cmpResult)[0];
}
```

`cmpResult`:
1. `Math.abs(b.value) >= FIVE` 优先
2. `b.value - a.value`（高分胜）
3. `a.path.length - b.path.length`（短 path 胜）
4. `a.workerId - b.workerId`（确定性 tiebreak）

---

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 单 worker 崩溃 | 忽略该结果，≥1 个成功即返回；0 个成功则回退单 worker 重试 |
| 单 worker 超时（4s）| 终止该 worker，其他 worker 继续 |
| 全部 worker 失败 | dispatcher 跑单 worker 重试 |
| 引擎编译失败 | 直接报错，不进入 SMP |

---

## 7. 测试计划

### 7.1 单元测试（test/）

`test/lazy-smp.test.js`：
- 4 worker 都返回同 shape `{ x, y, ms, workerId }`
- 谈合函数在必胜 vs 非必胜混输入时选必胜
- 同分时选最短 path
- 单 worker 崩溃不污染其他 worker
- 抖动种子不同 → 至少 N% 局面选点不同（验证抖动真的生效）

### 7.2 回归

`test/hint.test.js` 56 个测试全跑，预期通过率与 v45.2 一致。

### 7.3 Battle 对照

`battle-ai.mjs`：
- A：`v45.2`（baseline）
- B：`v46` Lazy SMP
- 5 局深度档，每局双方各执一色交替
- 输出：每局胜方 + 双方平均/中位延迟 + 总耗时
- 验收：B 胜率 ≥ A，且 B 平均延迟 ≤ A × 1.2

---

## 8. 部署

- 本地测试通过 + battle 胜率达标后
- 推送 gomoku 仓库：`GIT_SSH_COMMAND="ssh -i ~/.ssh/github_push -o IdentitiesOnly=yes" git push origin master`
- 部署到 114.132.229.58：`ssh -i ~/.ssh/gomoku_deploy` → `git fetch && /usr/bin/sudo git reset --hard origin/master` → systemctl restart gomoku
- 监控 https://htyiybb.top/ 200 + hint 接口稳定

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 4 worker 内存压力 | TT 不共享 → 每 worker 独立 Map → 总内存 4×。预估峰值 200MB → 服务器 1GB 充裕 |
| 谈合逻辑 bug 导致选点比单 worker 更差 | 多维评分必胜值优先 + 测试覆盖；若 battle 5 局 < 3 胜，回滚 |
| 启动时间延长 | 4 worker 并行启动 ~50ms，比单 worker 多 ~30ms，可接受 |
| Node SharedArrayBuffer 兼容性 | 不使用，仅 vm.createContext（已在 v45 用过） |

---

## 10. YAGNI 排除项

- ❌ TT 共享（JS Map 不可 SharedArrayBuffer，重写 TT 收益/风险不成正比）
- ❌ 胜值传播（Atomics 同步成本高 + 抖动已经够分散搜索）
- ❌ 普通档 Lazy SMP（中位 9ms，谈合协议成本可能 > 节省）
- ❌ 8 worker（同步开销上升、加速比递减，4 worker 是经验最优起步）
- ❌ Worker 数动态调整（先固定 4，后续观察再优化）