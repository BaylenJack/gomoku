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

test('奇数目标深度也会搜索合法着法，不返回未初始化哨兵', () => {
  const board = empty();
  for (const [x, y, color] of [[7,7,1], [8,7,2], [7,8,1], [8,8,2]]) board[idx(x, y)] = color;
  const result = computeBest(board, 1, {
    deep: true,
    workerId: 0,
    __testConfig: { depth: 5, maxNodes: 300_000, maxMs: 700 },
  });
  assert.ok(Number.isFinite(result.value) && result.value > -1_000_000_000, JSON.stringify(result));
  assert.equal(board[idx(result.x, result.y)], 0);
  assert.ok(result.nodes > 1);
});

test('入口拒绝在已有五连的终局继续生成非法后续着法', () => {
  const board = empty();
  for (let x = 3; x <= 7; x++) board[idx(x, 7)] = 1;
  board[idx(5, 5)] = 2;
  assert.throws(() => computeBest(board, 2), /棋局已结束/);
});

test('普通四威胁存在时仍保留更强的复合必胜候选', () => {
  const board = empty();
  const stones = [
    [13,9,1],[2,3,2],[10,10,1],[1,4,2],[13,5,1],[3,6,2],
    [5,11,1],[4,7,2],[5,12,1],[1,3,2],[6,7,1],[9,12,2],
    [12,6,1],[8,5,2],[13,1,1],[7,9,2],[10,8,1],[2,8,2],
    [8,6,1],[2,6,2],[3,2,1],[2,4,2],[13,13,1],[8,2,2],[1,2,1],
  ];
  for (const [x, y, color] of stones) board[idx(x, y)] = color;
  const shape = __test__.analyzePoint(board, 2, 5, 2);
  assert.ok(shape.forced || shape.winCells.length >= 2, JSON.stringify(shape));
  const moves = __test__.valuableMoves(board, 2);
  assert.ok(moves.some(([x, y]) => x === 2 && y === 5), '候选生成不得漏掉 (2,5)');
});
