// 复现脚本 v2: 只研究深度档 (deep)
//   症状1: 对方先手 → 引擎(白)防守不住, 7-8 手被绝杀
//   症状2: 自己先手 → 引擎(黑)进攻无力, 赢不了
// 方法: 深度档自对弈 + 战术题验证 (深档预算降为 1200ms 加速自对弈)
import fs from 'node:fs';
import vm from 'node:vm';

const SIZE = 15, E = 0, BLACK = 1, WHITE = 2;
const idx = (x, y) => y * SIZE + x;
const other = (c) => (c === BLACK ? WHITE : BLACK);

function loadEngine(src) {
  const sb = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, sb);
  return sb.self.GomokuHint;
}

// 自对弈版: 深档预算 3500 → 1200ms (搜索逻辑完全一致, 只缩短墙钟)
const fastSrc = fs.readFileSync('C:/Users/王巢三/gomoku/public/hint.js', 'utf8')
  .replace('const DEEP_BUDGET_MS = 3500;', 'const DEEP_BUDGET_MS = 1200;');
const fastEngine = loadEngine(fastSrc);

// 战术题版: 用真实 3.5s 预算
const src = fs.readFileSync('C:/Users/王巢三/gomoku/public/hint.js', 'utf8');
const engine = loadEngine(src);

function fresh() { return new Array(225).fill(E); }

function winsAt(b, x, y, c) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const nx = x + dx*i, ny = y + dy*i;
      if (nx<0||nx>=15||ny<0||ny>=15) break;
      if (b[idx(nx, ny)] === c) n++; else break;
    }
    for (let i = 1; i < 5; i++) {
      const nx = x - dx*i, ny = y - dy*i;
      if (nx<0||nx>=15||ny<0||ny>=15) break;
      if (b[idx(nx, ny)] === c) n++; else break;
    }
    if (n >= 5) return true;
  }
  return false;
}

function playGame(blackOpts, whiteOpts, maxPly, verbose, eng) {
  const b = fresh();
  const moves = [];
  for (let n = 0; n < maxPly; n++) {
    const color = (n % 2 === 0) ? BLACK : WHITE;
    const opts = color === BLACK ? blackOpts : whiteOpts;
    const r = eng.computeBest(b.slice(), color, opts);
    const x = r.x, y = r.y;
    if (x === undefined || b[idx(x, y)] !== E) {
      console.log(`!! 非法落点 第${n+1}手 ${color===BLACK?'黑':'白'}: ${JSON.stringify(r)}`);
      return { winner: other(color), reason: '引擎非法落点', moves };
    }
    b[idx(x, y)] = color;
    moves.push([x, y, color]);
    if (winsAt(b, x, y, color)) {
      return { winner: color, reason: '五连', moves };
    }
    if (verbose && (n % 2 === 1)) {
      console.log(`  第${(n+1)/2}手: 黑(${moves[n-1][0]},${moves[n-1][1]}) 白(${moves[n][0]},${moves[n][1]})`);
    }
  }
  return { winner: 0, reason: '和棋', moves };
}

// ===== 自对弈: 深度档 (1.2s 预算) =====
console.log('=== 自对弈深度档 (deep, 1.2s 预算/手) ===');
const deepOpts = { deep: true, workerId: 0 };
for (let g = 0; g < 3; g++) {
  const r = playGame(deepOpts, deepOpts, 120, false, fastEngine);
  const winName = r.winner === BLACK ? '黑(先手)' : r.winner === WHITE ? '白(后手)' : '和棋';
  console.log(`第${g+1}局: 胜者=${winName} (${r.reason}, ${r.moves.length}手)`);
  if (g === 0) {
    // 打印第一局全谱
    for (let i = 0; i < r.moves.length; i += 2) {
      const b = r.moves[i], w = r.moves[i+1];
      console.log(`  ${i/2+1}. 黑(${b[0]},${b[1]}) ${w ? `白(${w[0]},${w[1]})` : ''}`);
    }
  }
}

// ===== 战术题 (真实 3.5s 深度预算) =====
console.log('\n=== 战术题 (deep 3.5s) ===');
function tact(name, setup, color, check) {
  const b = fresh();
  for (const [x, y, c] of setup) b[idx(x, y)] = c;
  const t0 = Date.now();
  const r = engine.computeBest(b.slice(), color, { deep: true, workerId: 0 });
  const ms = Date.now() - t0;
  const ok = check(r, b);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: 引擎走 (${r.x},${r.y}) [${ms}ms]${ok ? '' : ' ✗'}`);
  return ok;
}

// T1: 对手双活三, 黑必须堵交点 (7,7)
tact('对手双活三必堵交点', [
  [4,7,2],[5,7,2],[6,7,2],   // 白横活三 (3,7)/(7,7) 两端
  [6,6,2],[5,5,2],[4,4,2],   // 白斜活三 (7,7)/(3,3) 两端 → 交点 (7,7)
  [0,0,1],[14,14,1],
], BLACK, (r) => (r.x === 7 && r.y === 7));

// T2: 对手活四, 黑必须堵 (自己的活三可以放弃)
tact('对手活四必堵', [
  [3,5,2],[4,5,2],[5,5,2],[6,5,2],
  [0,0,1],[1,0,1],[2,0,1],
], BLACK, (r) => (r.y === 5 && (r.x === 2 || r.x === 7)));

// T3: 先手进攻 —— 黑双活二中心, 应落 (7,7) 做双活三
tact('先手做双活三(进攻)', [
  [6,7,1],[8,7,1],
  [7,6,1],[7,8,1],
  [0,0,2],[14,14,2],
], BLACK, (r) => (r.x === 7 && r.y === 7));

// T4: 对手冲四+活三复合威胁, 黑必须堵住能一步成杀的组合
tact('对手冲四+活三组合必堵', [
  [3,7,2],[4,7,2],[5,7,2],[6,7,2],  // 白冲四 (2,7)堵 → (7,7)开放
  [8,3,2],[8,4,2],[8,5,2],           // 白活三 (8,2)/(8,6)
  [2,7,1],
], BLACK, (r) => (r.x === 7 && r.y === 7));

// T5: 防守后手局面: 白已形成双活三威胁, 黑要先堵一端再做自己的杀
// 构造: 白横活三 (3,8)(4,8)(5,8); 黑自己有活三 (3,3)(4,3)(5,3)
tact('对手活三+己方活三: 先堵对手', [
  [3,8,2],[4,8,2],[5,8,2],
  [3,3,1],[4,3,1],[5,3,1],
  [0,0,2],[14,14,1],
], BLACK, (r) => (r.y === 8));
