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
const fast = { deep: true, workerId: 0, __testConfig: { depth: 7, maxNodes: 400_000, maxMs: 800 } };

test('v12 防守对手活三会真实搜索并且不污染输入棋盘', () => {
  const board = empty();
  for (const x of [4, 5, 6]) board[idx(x, 7)] = 2;
  board[idx(1, 1)] = 1;
  board[idx(10, 10)] = 1;
  const before = board.slice();
  const result = computeBest(board, 1, fast);
  assert.ok(result.y === 7 && (result.x === 3 || result.x === 7), JSON.stringify(result));
  assert.ok(result.nodes > 0 && result.depth >= 2, JSON.stringify(result));
  assert.deepEqual(board, before);
});

test('v12 进攻活三仍会比较延伸和关键防点', () => {
  const board = empty();
  for (const x of [4, 5, 6]) board[idx(x, 7)] = 1;
  for (const [x, y] of [[8,5], [10,5], [9,4], [9,6]]) board[idx(x, y)] = 2;
  const result = computeBest(board, 1, fast);
  const extend = result.y === 7 && (result.x === 3 || result.x === 7);
  const takeIntersection = result.x === 9 && result.y === 5;
  assert.ok(extend || takeIntersection, JSON.stringify(result));
  assert.ok(result.nodes > 0);
});

test('v12 预算截断只提交最后完整完成的迭代', () => {
  const board = empty();
  for (const [x, y, color] of [
    [7,7,1], [8,7,1], [6,6,1], [9,9,1], [5,8,1], [9,6,1],
    [7,6,2], [8,8,2], [6,7,2], [5,5,2], [8,5,2], [10,8,2],
  ]) board[idx(x, y)] = color;
  const result = computeBest(board, 1, fast);
  assert.ok(result.iterations.length > 0, JSON.stringify(result));
  assert.equal(result.depth, result.iterations.at(-1).depth, JSON.stringify(result));
  assert.ok(Number.isFinite(result.value) && result.value > -1_000_000_000);
});

test('v12 真实防守复盘至少消除对手下一手直接成五', () => {
  const board = empty();
  for (const [x, y] of [[7,7],[7,8],[8,8],[9,6],[6,5],[6,7],[5,6],[5,5],[7,10]]) board[idx(x, y)] = 2;
  for (const [x, y] of [[7,6],[8,7],[6,6],[9,8],[8,5],[6,8],[8,9],[4,5]]) board[idx(x, y)] = 1;
  const result = computeBest(board, 1, fast);
  const after = board.slice();
  after[idx(result.x, result.y)] = 1;
  assert.deepEqual(Array.from(__test__.immediateWins(after, 2)), [], JSON.stringify(result));
});

test('v12 对手已有四连时绝不以己方造势覆盖必堵点', () => {
  const board = empty();
  for (const x of [5, 6, 7, 8]) board[idx(x, 7)] = 2;
  for (const [x, y] of [[4,5], [6,5], [5,4], [5,6]]) board[idx(x, y)] = 1;
  const result = computeBest(board, 1, fast);
  assert.ok(result.y === 7 && (result.x === 4 || result.x === 9), JSON.stringify(result));
});
