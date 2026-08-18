import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');
const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(code, sandbox);
const { computeBest, __test__ } = sandbox.self.GomokuHint;
const idx = (x, y) => y * 15 + x;
const empty = () => new Array(225).fill(0);
const quick = { deep: true, workerId: 0, __testConfig: { depth: 5, maxNodes: 200_000, maxMs: 350 } };

test('空盘建议天元且携带 v12 引擎标记', () => {
  const result = computeBest(empty(), 1);
  assert.deepEqual([result.x, result.y], [7, 7]);
  assert.equal(result.engine, 'deep-v12');
});

test('己方直接成五绝对优先', () => {
  const board = empty();
  for (let x = 3; x <= 6; x++) board[idx(x, 7)] = 1;
  const result = computeBest(board, 1, quick);
  assert.ok(result.y === 7 && (result.x === 2 || result.x === 7), JSON.stringify(result));
  assert.equal(result.value, 10_000_000);
  assert.equal(result.verified, true);
});

test('四个方向的单缺口四连都会封住缺口', () => {
  for (const [dx, dy] of [[1,0], [0,1], [1,1], [1,-1]]) {
    for (let gap = 0; gap < 5; gap++) {
      const board = empty();
      const sx = 5;
      const sy = dy < 0 ? 9 : 5;
      for (let step = 0; step < 5; step++) {
        if (step !== gap) board[idx(sx + dx * step, sy + dy * step)] = 2;
      }
      if (gap === 0) board[idx(sx + dx * 5, sy + dy * 5)] = 1;
      if (gap === 4) board[idx(sx - dx, sy - dy)] = 1;
      const result = computeBest(board, 1, quick);
      assert.deepEqual([result.x, result.y], [sx + dx * gap, sy + dy * gap],
        `方向(${dx},${dy}) gap=${gap}: ${JSON.stringify(result)}`);
    }
  }
});

test('单开口三连与棋盘边界三连都封住唯一延伸点', () => {
  const cases = [
    { stones: [[0,7], [1,7], [2,7]], blocks: [[3,7], [4,7]] },
    { stones: [[7,0], [7,1], [7,2]], blocks: [[7,3], [7,4]] },
    { stones: [[0,0], [1,1], [2,2]], blocks: [[3,3], [4,4]] },
    { stones: [[0,14], [1,13], [2,12]], blocks: [[3,11], [4,10]] },
  ];
  for (const { stones, blocks } of cases) {
    const board = empty();
    for (const [x, y] of stones) board[idx(x, y)] = 2;
    const result = computeBest(board, 1, quick);
    assert.ok(blocks.some(([x, y]) => result.x === x && result.y === y), JSON.stringify(result));
  }
});

test('双活三交点能被识别并保留在根候选中', () => {
  const board = empty();
  for (const [x, y] of [[4,5], [6,5], [5,4], [5,6]]) board[idx(x, y)] = 1;
  board[idx(0, 0)] = 2;
  const shape = __test__.analyzePoint(board, 5, 5, 1);
  assert.ok(shape.openThreeDirs >= 2 && shape.forced, JSON.stringify(shape));
  assert.ok(__test__.valuableMoves(board, 1).some(([x, y]) => x === 5 && y === 5));
});

test('强制证明和主搜索的所有 move/undo 都不污染调用方棋盘', () => {
  const board = empty();
  for (const [x, y, color] of [
    [7,7,1], [8,8,2], [6,7,1], [8,7,2], [5,7,1], [9,9,2],
    [7,5,1], [8,10,2], [6,5,1], [9,7,2],
  ]) board[idx(x, y)] = color;
  const before = board.slice();
  const result = computeBest(board, 1, quick);
  assert.equal(board[idx(result.x, result.y)], 0);
  assert.deepEqual(board, before);
});

test('极小预算会返回合法的最后完整结果或安全回退', () => {
  const board = empty();
  for (const [x, y, color] of [[7,7,1], [8,8,2], [6,7,1], [8,7,2], [5,7,1], [9,9,2]]) {
    board[idx(x, y)] = color;
  }
  const result = computeBest(board, 1, {
    deep: true,
    workerId: 0,
    __testConfig: { depth: 10, maxNodes: 100, maxMs: 50 },
  });
  assert.ok(result.x >= 0 && result.x < 15 && result.y >= 0 && result.y < 15, JSON.stringify(result));
  assert.equal(board[idx(result.x, result.y)], 0);
  assert.ok(Number.isFinite(result.value));
});
