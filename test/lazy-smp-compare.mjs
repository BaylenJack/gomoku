// v46 Lazy SMP 性能对照: 单 worker vs N worker 谈合 (dispatcher 路径)
//   在中盘 12 子局面下跑 5 次, 比较 wall time + 选点稳定性
//   用法: node test/lazy-smp-compare.mjs [commit] [workers]
import { Worker } from 'node:worker_threads';
import { execSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';

const NUM_WORKERS = parseInt(process.argv[3] || '4', 10);
const BASE_SEED = 0x9E3779B9;

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

// 中盘 12 子: 多条活二交错, 强制走深度搜索
function makeBoard() {
  const b = new Array(225).fill(0);
  b[7 + 5 * 15] = 1; b[9 + 5 * 15] = 1;
  b[7 + 9 * 15] = 1; b[8 + 9 * 15] = 1;
  b[4 + 7 * 15] = 1; b[6 + 7 * 15] = 1;
  b[8 + 5 * 15] = 2; b[10 + 5 * 15] = 2;
  b[9 + 9 * 15] = 2; b[10 + 9 * 15] = 2;
  b[5 + 7 * 15] = 2; b[7 + 7 * 15] = 2;
  b[11 + 8 * 15] = 2; b[3 + 6 * 15] = 2;
  b[5 + 5 * 15] = 2; b[5 + 9 * 15] = 2;
  return b;
}

const commit = process.argv[2] || 'HEAD';
const computeBest = loadEngineAt(commit);
const board = makeBoard();
const TRIALS = 5;

// 单 worker 路径
async function singleWorker() {
  const t0 = Date.now();
  const r = computeBest(board.slice(), 1, { deep: true });
  return { pick: `${r.x},${r.y}`, value: r.value || 0, ms: Date.now() - t0 };
}

// 4 worker Lazy SMP 路径 (模拟 dispatcher)
function pickBest(results) {
  const filtered = results.filter((r) => !r.error && typeof r.x === 'number');
  if (!filtered.length) return null;
  return filtered.sort((a, b) => {
    const aWin = a.value >= 100000, bWin = b.value >= 100000;
    if (aWin !== bWin) return aWin ? -1 : 1;
    if (a.value !== b.value) return b.value - a.value;
    const al = (a.path || []).length, bl = (b.path || []).length;
    if (al !== bl) return al - bl;
    return a.workerId - b.workerId;
  })[0];
}

async function lazySmp() {
  const SEARCH_WORKER = path.resolve('src/hint-worker-search.cjs');
  const workers = [];
  const results = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    const w = new Worker(SEARCH_WORKER, {
      workerData: {
        publicDir: path.resolve('public'),
        workerId: i,
        jitterSeed: BASE_SEED * (i + 1),
      },
    });
    workers.push(w);
    w.on('message', (r) => results.push(r));
    w.on('error', () => {});
    w.postMessage({ id: 1, board: board.slice(), color: 1, deep: true });
  }
  const t0 = Date.now();
  const deadline = t0 + 30000;
  while (results.length < NUM_WORKERS && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const w of workers) try { await w.terminate(); } catch (_) {}
  const ms = Date.now() - t0;
  const best = pickBest(results);
  return { pick: best ? `${best.x},${best.y}` : 'NONE', workers: results.length, ms };
}

console.log(`=== Lazy SMP 性能对照 (commit=${commit}, workers=${NUM_WORKERS}, 12 子中盘, trials=${TRIALS}) ===\n`);
const singlePicks = [], singleMs = [];
const smpPicks = [], smpMs = [], smpWorkers = [];
for (let i = 0; i < TRIALS; i++) {
  const s = await singleWorker();
  singlePicks.push(s.pick); singleMs.push(s.ms);
  const m = await lazySmp();
  smpPicks.push(m.pick); smpMs.push(m.ms); smpWorkers.push(m.workers);
  console.log(`trial ${i+1}: single=${s.pick} ${s.ms}ms | 4-worker=${m.pick} (${m.workers}/4 winners) ${m.ms}ms`);
}
const sAvg = singleMs.reduce((a, b) => a + b, 0) / TRIALS;
const mAvg = smpMs.reduce((a, b) => a + b, 0) / TRIALS;
console.log(`\n单 worker 选点: ${[...new Set(singlePicks)].join(' / ')} | 平均 ${sAvg.toFixed(0)}ms`);
console.log(`4 worker 选点: ${[...new Set(smpPicks)].join(' / ')} | 平均 ${mAvg.toFixed(0)}ms | 平均 winners: ${(smpWorkers.reduce((a,b)=>a+b,0)/TRIALS).toFixed(1)}/4`);
console.log(`\n=== 对比 ===`);
console.log(`延迟比: ${(mAvg/sAvg).toFixed(2)}x ${mAvg <= sAvg * 1.5 ? 'OK ≤1.5x ✓' : 'FAIL >1.5x ✗'}`);