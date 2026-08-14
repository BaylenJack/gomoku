// deep 档对照: baseline (v45.2) vs new (v46 Lazy SMP), 在固定中盘局面上
//   比较选点 + value + ms。battle-ai.mjs 不传 deep, 跑不出 Lazy SMP;
//   本脚本直接调 computeBest({deep:true}) 让新引擎真正走多 worker 谈合路径。
import fs from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

const SIZE = 15;
const EMPTY = 0;

function loadEngineAt(commit) {
  const src = execSync(`git show ${commit}:public/hint.js`, {
    cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024,
  }).toString('utf8');
  const sandbox = {
    module: { exports: {} }, exports: {}, console,
    performance: { now: () => Date.now() },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports.computeBest;
}

// 中盘 12 子: 多条活二/活三, 但无立即成五/活四 — 强制走深度搜索
function makeBoard() {
  const b = new Array(225).fill(0);
  // 黑: 三条活二交错
  b[7 + 5 * 15] = 1; b[9 + 5 * 15] = 1;          // (7,5)(9,5) 横活二
  b[7 + 9 * 15] = 1; b[8 + 9 * 15] = 1;          // (7,9)(8,9) 横活二
  b[4 + 7 * 15] = 1; b[6 + 7 * 15] = 1;          // (4,7)(6,7) 横活二
  // 白: 散落堵点, 无立即威胁
  b[8 + 5 * 15] = 2; b[10 + 5 * 15] = 2;        // 堵黑横活二
  b[9 + 9 * 15] = 2; b[10 + 9 * 15] = 2;        // 堵黑横活二
  b[5 + 7 * 15] = 2; b[7 + 7 * 15] = 2;          // 堵黑横活二
  b[11 + 8 * 15] = 2; b[3 + 6 * 15] = 2;          // 散点
  b[5 + 5 * 15] = 2; b[5 + 9 * 15] = 2;
  return b;
}

const baseline = loadEngineAt(process.argv[2] || '4f618d6');
const neo = loadEngineAt(process.argv[3] || 'HEAD');
const board = makeBoard();
const TRIALS = 5;

console.log(`=== Deep 档选点对照 (中盘 8 子, trials=${TRIALS}) ===\n`);

const basePicks = [], baseVals = [], baseMs = [];
const neoPicks = [], neoVals = [], neoMs = [];
for (let i = 0; i < TRIALS; i++) {
  const tb0 = Date.now();
  const rb = baseline(board.slice(), 1, { deep: true });
  const tb = Date.now() - tb0;
  basePicks.push(`${rb.x},${rb.y}`);
  baseVals.push(rb.value || 0);
  baseMs.push(tb);

  const tn0 = Date.now();
  const rn = neo(board.slice(), 1, { deep: true });
  const tn = Date.now() - tn0;
  neoPicks.push(`${rn.x},${rn.y}`);
  neoVals.push(rn.value || 0);
  neoMs.push(tn);
}

console.log('baseline (v45.2):');
basePicks.forEach((p, i) => console.log(`  trial ${i+1}: (${p}) value=${baseVals[i]} ms=${baseMs[i]}`));
const baseAvgMs = baseMs.reduce((a, b) => a + b, 0) / TRIALS;
const baseMaxVal = Math.max(...baseVals);
console.log(`  选点去重: ${[...new Set(basePicks)].join(' / ')} | 最高 value: ${baseMaxVal} | 平均 ms: ${baseAvgMs.toFixed(0)}`);

console.log('\nnew (v46 Lazy SMP):');
neoPicks.forEach((p, i) => console.log(`  trial ${i+1}: (${p}) value=${neoVals[i]} ms=${neoMs[i]}`));
const neoAvgMs = neoMs.reduce((a, b) => a + b, 0) / TRIALS;
const neoMaxVal = Math.max(...neoVals);
console.log(`  选点去重: ${[...new Set(neoPicks)].join(' / ')} | 最高 value: ${neoMaxVal} | 平均 ms: ${neoAvgMs.toFixed(0)}`);

console.log('\n=== 对比 ===');
console.log(`  最高 value: baseline=${baseMaxVal}, new=${neoMaxVal}, ${neoMaxVal >= baseMaxVal ? 'OK ✓' : 'FAIL ✗'}`);
console.log(`  平均延迟: baseline=${baseAvgMs.toFixed(0)}ms, new=${neoAvgMs.toFixed(0)}ms, ${neoAvgMs <= baseAvgMs * 1.5 ? 'OK ≤1.5x ✓' : 'FAIL >1.5x ✗'}`);