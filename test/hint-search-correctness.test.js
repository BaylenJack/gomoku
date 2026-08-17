import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');
const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(code, sandbox);
const hook = sandbox.self.GomokuHint.__test__;
const idx = (x, y) => y * 15 + x;
const empty = () => new Array(225).fill(0);

test('搜索内部奇数深度不会返回未初始化的 -MAX 哨兵', () => {
  const board = empty();
  board[idx(7, 7)] = 1;
  board[idx(8, 7)] = 2;
  const path = [[7, 7], [8, 7], [7, 8], [8, 8]];
  const result = hook.searchNode(board, 1, {
    depth: 5, cDepth: 4, path, lastMove: [8, 8], maxMs: 1000,
  });
  assert.notEqual(result.value, -1_000_000_000);
  assert.ok(result.move, '仍有合法候选时必须实际搜索一手');
  assert.ok(result.nodes > 1, '不能在入口直接空转返回');
});

test('搜索在已有五连的节点立即终止，不生成非法后续 PV', () => {
  const board = empty();
  for (let x = 3; x <= 7; x++) board[idx(x, 7)] = 1;
  board[idx(5, 5)] = 2;
  const path = [[7, 7]];
  const result = hook.searchNode(board, 2, { depth: 6, cDepth: 1, path });
  assert.equal(result.value, -10_000_000);
  assert.equal(result.move, null);
  assert.deepEqual(result.path, path);
  assert.equal(result.nodes, 1);
});

test('普通四威胁存在时仍保留更强的精确两手必胜候选', () => {
  const board = empty();
  const stones = [
    [13,9,1],[2,3,2],[10,10,1],[1,4,2],[13,5,1],[3,6,2],
    [5,11,1],[4,7,2],[5,12,1],[1,3,2],[6,7,1],[9,12,2],
    [12,6,1],[8,5,2],[13,1,1],[7,9,2],[10,8,1],[2,8,2],
    [8,6,1],[2,6,2],[3,2,1],[2,4,2],[13,13,1],[8,2,2],[1,2,1],
  ];
  for (const [x, y, color] of stones) board[idx(x, y)] = color;
  const forced = hook.forcedWinInTwoPoints(board, 2);
  assert.ok(forced.some((p) => p.x === 2 && p.y === 5 && p.replies >= 2));
  const moves = hook.valuableMoves(board, 2);
  assert.ok(moves.some(([x, y]) => x === 2 && y === 5), '候选生成不得漏掉 (2,5)');
});
