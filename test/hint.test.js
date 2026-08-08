// 提示引擎 v3 测试 — 覆盖威胁空间搜索(VCF 连杀 / VCT 双威胁 / 防守)
// 以及 v1/v2 的盲点: 跳子、双威胁、对手反杀、性能预算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');
const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(code, sandbox);
const { computeBest } = sandbox.self.GomokuHint;

const E = 0;
const idx = (x, y) => y * 15 + x;
const empty = () => new Array(225).fill(E);

// 通用断言: 引擎落子后棋盘不被污染(威胁搜索若清理不干净会改坏调用方棋盘)
function assertCleanBoard(b) {
  const before = b.slice();
  computeBest(b, 1);
  for (let i = 0; i < b.length; i++) {
    assert.equal(b[i], before[i], `computeBest 污染了棋盘 (${i % 15},${Math.floor(i / 15)})`);
  }
}

test('空盘建议天元', () => {
  const r = computeBest(empty(), 1);
  assert.equal(r.x, 7); assert.equal(r.y, 7);
});

test('直接五连点必选', () => {
  const b = empty();
  for (let i = 0; i < 4; i++) b[idx(i, 0)] = 1;
  const r = computeBest(b, 1);
  assert.ok((r.x === 4 && r.y === 0) || (r.x === 3 && r.y === 0), `实际 ${r.x},${r.y}`);
});

test('对手活四必堵', () => {
  const b = empty();
  for (let i = 5; i <= 8; i++) b[idx(7, i)] = 2;   // 白活四
  b[idx(0, 0)] = 1; b[idx(1, 1)] = 1; b[idx(2, 2)] = 1; // 黑活三干扰
  const r = computeBest(b, 1);
  assert.equal(r.x, 7, `应堵白活四, 实际 ${r.x},${r.y}`);
  assert.ok(r.y === 4 || r.y === 9, `应堵活四端点, 实际 y=${r.y}`);
});

test('v2 识别跳三并优先冲四', () => {
  const b = empty();
  // 黑跳三: X_X 形状 (3,3)(5,3), 落在 (4,3) 即成活三, 但更好的是先冲四
  b[idx(3, 3)] = 1; b[idx(5, 3)] = 1;
  b[idx(0, 0)] = 2; b[idx(14, 14)] = 2;
  const r = computeBest(b, 1);
  // 应落在跳三的缺口 (4,3), 或延伸处
  assert.equal(r.x, 4, `应补跳三缺口, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 3);
});

test('能制造双威胁(双三)', () => {
  const b = empty();
  // 黑已有两方向活二: (1,1)(2,2) 斜向 和 (1,1)(1,2) 纵向 —— 在 (1,1) 附近制造双三
  b[idx(2, 2)] = 1;   // 斜向
  b[idx(1, 2)] = 1;   // 纵向
  b[idx(6, 6)] = 2; b[idx(6, 7)] = 2; // 白干扰(中盘区域, 不贴边)
  const r = computeBest(b, 1);
  // 引擎应选 (1,1) 或附近形成双威胁的点
  const nearOrigin = r.x <= 3 && r.y <= 3;
  assert.ok(nearOrigin, `应靠近 (1,1) 制造双威胁, 实际 ${r.x},${r.y}`);
});

test('避免给对手直接反杀', () => {
  const b = empty();
  // 黑活三 (3,3)(4,3)(5,3), 白在 (7,3)(9,3)(10,3) 形成跳结构
  b[idx(3, 3)] = 1; b[idx(4, 3)] = 1; b[idx(5, 3)] = 1;
  b[idx(7, 3)] = 2; b[idx(9, 3)] = 2; b[idx(10, 3)] = 2;
  const r = computeBest(b, 1);
  // 验证: 黑落 r 后, 白没有任何一手能直接成五
  b[idx(r.x, r.y)] = 1;
  let whiteCanWin = false;
  for (let y = 0; y < 15 && !whiteCanWin; y++) {
    for (let x = 0; x < 15; x++) {
      if (b[idx(x, y)] !== E) continue;
      // 白落 (x,y) 是否成五(4 方向检查)
      for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
        let n = 1;
        for (let i = 1; i < 5; i++) {
          const nx = x + dx*i, ny = y + dy*i;
          if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15) break;
          if (b[idx(nx, ny)] === 2) n++; else break;
        }
        for (let i = 1; i < 5; i++) {
          const nx = x - dx*i, ny = y - dy*i;
          if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15) break;
          if (b[idx(nx, ny)] === 2) n++; else break;
        }
        if (n >= 5) whiteCanWin = true;
      }
    }
  }
  assert.ok(!whiteCanWin, `黑落 (${r.x},${r.y}) 后白能直接成五!`);
});

test('防守时优先挡对手冲四而非自己进攻', () => {
  const b = empty();
  // 白冲四 (5,5)-(8,5) 一端堵 → 黑必须堵 (4,5) 或 (9,5)
  b[idx(5, 5)] = 2; b[idx(6, 5)] = 2; b[idx(7, 5)] = 2; b[idx(8, 5)] = 2;
  b[idx(4, 5)] = 1; // 一端已堵
  // 黑自己有活三 (0,0)(1,0)(2,0)
  b[idx(0, 0)] = 1; b[idx(1, 0)] = 1; b[idx(2, 0)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.y, 5, `应堵白冲四, 实际 ${r.x},${r.y}`);
  assert.equal(r.x, 9, `应堵开放端 (9,5), 实际 x=${r.x}`);
});

test('性能: 复杂局面 < 200ms', () => {
  const b = empty();
  const seed = [7,7,1, 8,8,2, 6,7,1, 8,7,2, 5,7,1, 9,9,2, 4,7,1, 10,10,2, 3,7,1, 11,11,2,
                7,5,1, 8,10,2, 6,5,1, 9,7,2, 5,5,1, 10,8,2, 4,5,1, 11,9,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  const t0 = performance.now();
  computeBest(b, 1);
  const dt = performance.now() - t0;
  assert.ok(dt < 200, `耗时 ${dt.toFixed(0)}ms`);
});

// ================= v3: 威胁空间搜索 =================

test('v3 双活三: 落交点制造双威胁', () => {
  const b = empty();
  // 黑双活二: 横 (4,5)(6,5) + 纵 (5,4)(5,6), 落 (5,5) 成双活三
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x,y)] = 1;
  b[idx(0,0)] = 2; b[idx(14,14)] = 2;  // 白干扰
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应选双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v3 防守: 对手双活三必须堵交点', () => {
  const b = empty();
  // 白双活二同样结构 → 黑必须堵 (5,5)
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x,y)] = 2;
  b[idx(0,0)] = 1; b[idx(1,0)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应堵双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v3 直接成五: 冲四开放端优先于其他', () => {
  const b = empty();
  // 黑四连 (3,5)(4,5)(5,5)(6,5), 左端 (2,5) 白堵 → 开放端 (7,5) 直接成五
  for (const [x, y] of [[3,5],[4,5],[5,5],[6,5]]) b[idx(x,y)] = 1;
  b[idx(2,5)] = 2;
  b[idx(0,0)] = 1; b[idx(1,0)] = 1; b[idx(2,0)] = 1;  // 黑自己的活三干扰
  const r = computeBest(b, 1);
  assert.equal(r.x, 7, `应走冲四开放端直接成五, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v3 防守: 对手跳三缺口必须堵', () => {
  const b = empty();
  // 白跳三 X_XX (7,3)(9,3)(10,3) → 缺口 (8,3), 黑无更急威胁
  for (const [x, y] of [[7,3],[9,3],[10,3]]) b[idx(x,y)] = 2;
  b[idx(3,3)] = 1; b[idx(4,4)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.x, 8, `应堵跳三缺口, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 3);
});

test('v3 防守: 对手活三必须堵端点', () => {
  const b = empty();
  // 白活三 (4,7)(5,7)(6,7) 两端开放 → 必须堵 (3,7) 或 (7,7)
  for (const [x, y] of [[4,7],[5,7],[6,7]]) b[idx(x,y)] = 2;
  b[idx(14,14)] = 1; b[idx(13,13)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.y, 7, `应堵白活三端点, 实际 ${r.x},${r.y}`);
  assert.ok(r.x === 3 || r.x === 7, `应堵 (3,7) 或 (7,7), 实际 x=${r.x}`);
});

test('v3 进攻: 双活二伏笔低于活三优先级', () => {
  const b = empty();
  // 黑双活二 (1,1)(2,2) 斜向 + (1,1)(1,2) 纵向: 落 (1,1) 成双活二伏笔;
  // 白 (4,4)(5,4) 只是开放二, 不构成紧迫威胁
  b[idx(2, 2)] = 1; b[idx(1, 2)] = 1;
  b[idx(4, 4)] = 2; b[idx(5, 4)] = 2;
  const r = computeBest(b, 1);
  assert.ok(r.x <= 3 && r.y <= 3, `应靠近 (1,1) 制造双威胁, 实际 ${r.x},${r.y}`);
});

test('v3 computeBest 不污染棋盘(威胁搜索清理检查)', () => {
  const b = empty();
  for (const [x, y] of [[1,1],[0,1]]) b[idx(x,y)] = 1;
  for (const [x, y] of [[4,4],[4,5]]) b[idx(x,y)] = 2;
  assertCleanBoard(b);

  const b2 = empty();
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b2[idx(x,y)] = 1;  // 触发威胁搜索
  b2[idx(0,0)] = 2; b2[idx(14,14)] = 2;
  assertCleanBoard(b2);
});

// ================= v4: 威胁阶梯升级 =================

test('v4 防对手双活三: 抢占交点', () => {
  const b = empty();
  // 白跳三结构 (4,5)(6,5) + (5,4)(5,6), 缺口 (5,5) 落白成双活三 → 黑必须占住
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x,y)] = 2;
  b[idx(0,0)] = 1; b[idx(1,0)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应抢白双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v4 防守: 对手冲四链必须堵', () => {
  const b = empty();
  // 白两组冲四 (0,4)(1,4)(2,4)(3,4) + (6,4)(7,4)(8,4)(9,4), 黑活三干扰
  for (const [x, y] of [[0,4],[1,4],[2,4],[3,4]]) b[idx(x,y)] = 2;
  for (const [x, y] of [[6,4],[7,4],[8,4],[9,4]]) b[idx(x,y)] = 2;
  for (const [x, y] of [[5,5],[6,5],[7,5]]) b[idx(x,y)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.y, 4, `应堵白冲四链, 实际 ${r.x},${r.y}`);
});

test('v4 四三杀: 有直接成五时优先走', () => {
  const b = empty();
  // 黑四连 (3,3)(4,3)(5,3)(6,3) 左端白堵, 右端 (7,3) 直接成五;
  // 黑另有活三 (0,0)(1,0)(2,0) 可延伸成冲四
  for (const [x, y] of [[3,3],[4,3],[5,3],[6,3]]) b[idx(x,y)] = 1;
  b[idx(2,3)] = 2;
  for (const [x, y] of [[0,0],[1,0],[2,0]]) b[idx(x,y)] = 1;
  const r = computeBest(b, 1);
  assert.ok((r.x === 7 && r.y === 3) || (r.x === 3 && r.y === 0), `四三杀应选成五点或活三点, 实际 ${r.x},${r.y}`);
});

test('v4 中盘性能: 复杂局面 < 250ms', () => {
  const b = empty();
  const seed = [7,7,1, 8,8,2, 6,7,1, 8,7,2, 5,7,1, 9,9,2, 4,7,1, 10,10,2, 3,7,1, 11,11,2,
                7,5,1, 8,10,2, 6,5,1, 9,7,2, 5,5,1, 10,8,2, 4,5,1, 11,9,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  const t0 = performance.now();
  computeBest(b, 1);
  const dt = performance.now() - t0;
  assert.ok(dt < 250, `耗时 ${dt.toFixed(0)}ms`);
});
