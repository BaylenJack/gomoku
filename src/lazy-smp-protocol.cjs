'use strict';

// v47 Lazy SMP 谈合协议 —— 4 个 search worker 返回结果后, dispatcher 用 pickBest
//   选全局最优。
//
// 优先级 (从高到低):
//   1. 己方必胜 (value >= FIVE, 正数): 比对方非必胜优先
//   2. value 大 (降序): 一般局面下 value 越大越好; 双方都输时, -50000 优于 -100000
//      (输得晚比输得快好, 这是 v46 修复的"异方必胜误判"语义)
//   3. path 短: 必胜路径越短越早赢; 非必胜路径越短越"近胜"
//   4. workerId 小: 同分时确定性强 worker (workerId=0 无抖动) 兜底
//
// v47 配合 public/hint.js 的 value/path 透传才真正生效 —— 此前 (v46) engine 只
//   返回 {x, y}, pickBest 拿到的 value/path 全是 0/[], 谈合退化成确定性选
//   workerId=0。

const FIVE = 100000;

function pickBest(results) {
  if (!results || !results.length) return null;
  const filtered = results.filter((r) => !r.error && typeof r.x === 'number');
  if (!filtered.length) return null;
  // 单次遍历取 max (N=4 影响不大, 但比 slice+sort 语义清晰)
  let best = filtered[0];
  for (let i = 1; i < filtered.length; i++) {
    if (cmpResult(filtered[i], best) < 0) best = filtered[i];
  }
  return best;
}

function cmpResult(a, b) {
  // 1. 己方必胜 (value >= FIVE) 优先; 双方都必胜 / 都不必胜时, 进入 value 比较
  const aWin = a.value >= FIVE;
  const bWin = b.value >= FIVE;
  if (aWin !== bWin) return aWin ? -1 : 1;
  // 2. value 降序: 大 value 优先 (包括双方都输时 -50000 优于 -100000)
  if (a.value !== b.value) return b.value - a.value;
  // 3. path 短优先: 必胜路径越短越好
  const al = (a.path || []).length;
  const bl = (b.path || []).length;
  if (al !== bl) return al - bl;
  // 4. workerId 小优先: 稳定兜底 (workerId=0 无抖动, 始终确定性)
  return a.workerId - b.workerId;
}

module.exports = { pickBest, cmpResult, FIVE };