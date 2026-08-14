'use strict';

// v46 Lazy SMP 谈合协议 —— 4 个 search worker 返回结果后, dispatcher 用 pickBest
//   选全局最优。多维评分: 必胜 > value > path 短 > workerId 小。

const FIVE = 100000;

function pickBest(results) {
  if (!results || !results.length) return null;
  const filtered = results.filter((r) => !r.error && typeof r.x === 'number');
  if (!filtered.length) return null;
  return filtered.slice().sort(cmpResult)[0];
}

function cmpResult(a, b) {
  // v46: 必胜 = 己方 value >= FIVE(正数, 我方能赢); 异方必胜(value <= -FIVE)
  //   是"我方输"的最差解, 不应优选。逻辑: 正向必胜 > 一般 value > path 短 > workerId 小。
  const aWin = a.value >= FIVE;
  const bWin = b.value >= FIVE;
  if (aWin !== bWin) return aWin ? -1 : 1;
  if (a.value !== b.value) return b.value - a.value;
  const al = (a.path || []).length;
  const bl = (b.path || []).length;
  if (al !== bl) return al - bl;
  return a.workerId - b.workerId;
}

module.exports = { pickBest, cmpResult, FIVE };