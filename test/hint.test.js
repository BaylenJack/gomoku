// 提示引擎 v2 测试 — 覆盖 v1 的盲点: 跳子、双威胁、对手反杀
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
  // 黑已有两方向活二: (0,0)(1,1) 和 (0,0)(0,1) —— 在 (0,0) 附近制造双三
  b[idx(1, 1)] = 1;   // 斜向
  b[idx(0, 1)] = 1;   // 纵向
  b[idx(4, 4)] = 2; b[idx(4, 5)] = 2; // 白干扰
  const r = computeBest(b, 1);
  // 引擎应选 (0,0) 或附近形成双威胁的点
  const nearOrigin = r.x <= 2 && r.y <= 2;
  assert.ok(nearOrigin, `应靠近 (0,0) 制造双威胁, 实际 ${r.x},${r.y}`);
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
