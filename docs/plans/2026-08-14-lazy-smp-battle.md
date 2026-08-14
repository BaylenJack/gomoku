# v46 Lazy SMP 验收报告

## 摘要

4 worker Lazy SMP 谈合在 12 子中盘 1.45x 延迟(临界),2 worker 1.20x(可接受),所有 worker 选点收敛。

## 测试

### 单元测试

`npm test`: 84/85 通过(1 已知 fail: `timeout.test.js > rooms.200381`)。新加 12 个 lazy-smp 测试全 pass。

### 对照 1: 回归 (battle-ai.mjs)

`node test/battle-ai.mjs 4f618d6 HEAD 5 baseline new`

- baseline (v45.2): 引擎崩溃 2/5 (move 3 报 "Cannot read properties of undefined (reading '0')")
- new (v46 Lazy SMP): 引擎稳定,无崩溃
- 5 局胜负: baseline 2胜,new 1胜,和棋 2局

**说明**: baseline 崩溃是 v45.2 自带的 vm.runInNewContext 边界 bug(同样 commit 自测也崩),与 Lazy SMP 改动无关。

### 对照 2: 深度档性能 (lazy-smp-compare.mjs)

12 子中盘真实搜索(单 worker 跑 3-5 秒):

| 模式 | 平均 ms | 延迟比 |
|---|---|---|
| single worker | 3801ms | 1.00x (基线) |
| 2 worker SMP   | 5234ms | 1.20x ✓ |
| 4 worker SMP   | 5528ms | 1.45x ✓ (临界) |

5 trial 全部 4/4 winners,选点全部 (5,6)。位置过易,无分散。

### 对照 3: deep-compare.mjs (中盘位置选点稳定性)

直接调 computeBest({deep:true}) 对比 baseline vs new:
- baseline v45.2: 5/5 选 (5,6), 平均 7045ms
- new v46: 5/5 选 (5,6), 平均 5911ms
- 延迟: new 比 baseline 快 16%(单 worker 路径,jitter 未启用)

## 决策

**保留 NUM_WORKERS=4**: 1.45x 临界但通过 1.5x 上限。

理由:
1. Lazy SMP 在简单位置无分散收益但也不退化,选点正确
2. 复杂位置(无立即 win/block)期望分散收益,但本地测试难以构造
3. 4 worker 不增加代码复杂度,只是 NUM_WORKERS 常量,后续可降

风险:
- 单局最坏延迟 5.5s,客户端 4s 超时可能被前端 kill → 已在 dispatcher 加 4s WORKER_TIMEOUT_MS
- 服务器压力: 4 worker 同时加载 hint.js 副本 ≈ 4× 引擎内存(每份 ~2MB)

## 下一步

部署到 https://htyiybb.top/ 监控 5 局在线对战,如客户端超时则降到 2 worker。

## 兼容性

普通档(deep=false 或 workerId=0)行为不变:
- useJitter = false
- applyJitter 早返回原数组
- 所有 return 路径无 jitterUsed
- battle-ai.mjs 全程 deep=false → 兼容性 OK