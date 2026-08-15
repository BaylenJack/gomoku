# gomoku v46 Lazy SMP 部署总结

**部署时间**：2026-08-14
**生产地址**：https://htyiybb.top/
**提交**：d733e13 (master)

---

## 一、目标

在深度档 (`opts.deep=true`) 启用 4-worker Lazy SMP 并行搜索，通过确定性抖动 + 多维评分谈合提升引擎智能，且延迟不超过基线 1.5 倍。

## 二、设计要点

| 项 | 方案 |
|---|---|
| 并行度 | 4 worker（深度档专用） |
| 抖动源 | `mulberry32(0x9E3779B9 × (workerId+1))` 确定性种子 |
| 抖动作用点 | `getValuableMoves` 输出的非 killer/ttMove 段（保留前 KEEP=8）做 Fisher-Yates |
| 谈合协议 | 必胜 > value 降序 > path 短 > workerId 小 |
| TT 共享 | ❌ 不做（v45 引擎 TT 是 JS Map，SharedArrayBuffer 不可用） |
| 普通档 | 不动（保持单 worker） |
| 单 worker 超时 | 4s 后 terminate |

## 三、实施

6 个 Task 全部 TDD 完成：

| Task | 内容 | Commit |
|---|---|---|
| 1 | hint.js 接 workerId+jitterSeed，深度档 stable shuffle（4 处 useJitter 守卫） | 5681482 |
| 2 | src/hint-worker-search.cjs 单 worker 执行器 | 7744541 |
| 3 | dispatcher 启动 4 worker + pickBest 多维评分谈合 | 2be7d22 |
| 4 | 谈合函数深度测试 + 抖动生效验证（修复异方必胜误判 bug） | ce156a8 |
| 5 | 全量回归 84/85 + battle 5 局对照 | 09eb6ed |
| 6 | merge → push → 生产部署 → 监控 | 0a64879 / d733e13 |

## 四、验收结果

| 指标 | baseline (v45.2) | v46 | 阈值 | 通过 |
|---|---|---|---|---|
| 回归测试 | 72/73 | 84/85 | 不退化 | ✅ |
| 深度档延迟倍数 | 1.00x | 1.45x | ≤1.50x | ✅ |
| 简单局面 | 收敛 | 4 worker 全部收敛到 (5,6) | 无分散 | ✅（不期待分散） |
| 生产监控 | — | 10/10 HTTP 200 | 全 200 | ✅ |

**已知不变项**：test 27 (rooms.200381) 失败，与本工作无关，沿用 v45.2 基线。

## 五、生产状态

- 服务：gomoku.service active
- PID：2239967
- 内存：47.7M
- 已恢复房间：66
- 日志：建议关注 `[hint] Lazy SMP 结束: ... winners=N/4 → ... value=...`
  - `winners=4/4` 健康
  - `winners=1` 频现 → 谈合协议需调整或 NUM_WORKERS 调小

## 六、回滚路径

| 场景 | 操作 |
|---|---|
| 抖动收益不明显 | hint.js 注释掉 `useJitter` 判断 → 仅留接口不动搜索 |
| 4 worker 太慢 | `NUM_WORKERS` 改 2 → 1.20x |
| 完全回退 v45.2 | server 端 `git reset --hard 4f618d6` |

## 七、相关文件

- 设计文档：`docs/plans/2026-08-14-lazy-smp-design.md`
- 实施计划：`docs/plans/2026-08-14-lazy-smp-impl.md`
- Battle 报告：`docs/plans/2026-08-14-lazy-smp-battle.md`
- 源代码：
  - `public/hint.js`（接 workerId+jitterSeed + stable shuffle）
  - `src/hint-worker-search.cjs`（单 worker 执行器）
  - `src/lazy-smp-protocol.cjs`（pickBest 谈合）
  - `src/hint-worker.cjs`（dispatcher 启动 4 worker）
- 测试：`test/lazy-smp.test.js`（12 个测试）