import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');
const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(code, sandbox);
const { computeBest, __test__ } = sandbox.self.GomokuHint;

const SIZE = 15;
const idx = (x, y) => y * SIZE + x;
const empty = () => new Array(SIZE * SIZE).fill(0);
const fastDeep = { deep: true, workerId: 0, __testConfig: { depth: 6, maxNodes: 200_000, maxMs: 300 } };

test('增量哈希和评估在 move/undo 后与全盘重算一致', () => {
  const board = empty();
  for (const [x, y, c] of [[7,7,1],[8,8,2],[6,7,1],[8,7,2]]) board[idx(x, y)] = c;
  const work = board.slice();
  const evaluator = __test__.createEvaluator(work);
  evaluator.init();

  const check = () => {
    const fresh = __test__.createEvaluator(work.slice());
    fresh.init();
    assert.deepEqual(evaluator.hash(), __test__.boardHash(work));
    assert.equal(evaluator.evaluate(1), fresh.evaluate(1));
    assert.equal(evaluator.evaluate(2), fresh.evaluate(2));
  };

  check();
  evaluator.move(5, 7, 1); check();
  evaluator.move(9, 7, 2); check();
  evaluator.undo(9, 7); check();
  evaluator.undo(5, 7); check();
  assert.deepEqual(work, board);
});

test('非终局静态高分不会越过必胜阈值', () => {
  const board = empty();
  for (const y of [2, 5, 8, 11]) {
    for (let x = 5; x <= 8; x++) board[idx(x, y)] = 1;
  }
  const evaluator = __test__.createEvaluator(board.slice());
  evaluator.init();
  assert.ok(evaluator.evaluate(1) < 10_000_000);
});

test('普通四存在时不会漏掉更强的复合棋形候选', () => {
  const board = empty();
  for (const [x, y] of [[6,7],[8,7],[7,6],[7,8],[10,3],[11,3],[12,3]]) board[idx(x, y)] = 1;
  board[idx(0, 0)] = 2;
  const moves = __test__.valuableMoves(board, 1, { cDepth: 0 });
  assert.ok(moves.some(([x, y]) => x === 7 && y === 7), '双三交点 (7,7) 不应被普通四候选挤掉');
  assert.ok(moves.some(([x, y]) => (x === 9 || x === 13) && y === 3), '普通四候选仍应保留');
});

test('入口拒绝非法棋盘和满盘', () => {
  assert.throws(() => computeBest([], 1), /225/);
  const bad = empty(); bad[3] = 9;
  assert.throws(() => computeBest(bad, 1), /非法/);
  assert.throws(() => computeBest(new Array(225).fill(1), 2), /棋盘已满/);
});

test('关键防守规则仍优先命中活四、活三和跳三', () => {
  const cases = [
    { stones: [[5,7],[6,7],[7,7],[8,7]], valid: (r) => r.y === 7 && (r.x === 4 || r.x === 9) },
    { stones: [[6,7],[7,7],[8,7]], valid: (r) => r.y === 7 && (r.x === 5 || r.x === 9) },
    { stones: [[5,7],[6,7],[8,7]], valid: (r) => r.y === 7 && [4,7,9].includes(r.x) },
  ];
  for (const { stones, valid } of cases) {
    const board = empty();
    for (const [x, y] of stones) board[idx(x, y)] = 2;
    board[idx(2, 2)] = 1;
    board[idx(3, 3)] = 1;
    const before = board.slice();
    const result = computeBest(board, 1, fastDeep);
    assert.ok(valid(result), `错误防守点: ${JSON.stringify(result)}`);
    assert.ok(result.nodes > 0 && result.depth >= 2, `战术局面必须进入深搜: ${JSON.stringify(result)}`);
    assert.deepEqual(board, before, '计算不得污染输入棋盘');
  }
});

test('四个方向的对手四连都能堵住，含单端被封局面', () => {
  const lines = [
    { start: [5, 7], dir: [1, 0] },
    { start: [7, 5], dir: [0, 1] },
    { start: [5, 5], dir: [1, 1] },
    { start: [5, 9], dir: [1, -1] },
  ];
  for (const { start: [sx, sy], dir: [dx, dy] } of lines) {
    for (const blockedSide of [-1, 0, 1]) {
      const board = empty();
      for (let i = 0; i < 4; i++) board[idx(sx + dx * i, sy + dy * i)] = 2;
      const left = [sx - dx, sy - dy];
      const right = [sx + dx * 4, sy + dy * 4];
      if (blockedSide < 0) board[idx(left[0], left[1])] = 1;
      if (blockedSide > 0) board[idx(right[0], right[1])] = 1;
      board[idx(1, 1)] = 1;
      const result = computeBest(board, 1, fastDeep);
      const valid = [];
      if (blockedSide >= 0) valid.push(left);
      if (blockedSide <= 0) valid.push(right);
      assert.ok(valid.some(([x, y]) => result.x === x && result.y === y),
        `方向 (${dx},${dy}) blocked=${blockedSide} 返回 ${JSON.stringify(result)}`);
      assert.ok(result.nodes > 0, '四连防守也必须经过搜索比较，不能启发式秒回');
    }
  }
});

test('对手三连与己方反击并存时必须搜索后再决定', () => {
  const board = empty();
  for (const [x, y, c] of [
    [3,7,1],[4,7,2],[5,7,2],[6,7,2],
    [9,5,1],[11,5,1],[10,4,1],[10,6,1],
  ]) board[idx(x, y)] = c;
  const result = computeBest(board, 1, fastDeep);
  assert.ok(result.nodes > 0 && result.depth >= 2, `必须进入搜索: ${JSON.stringify(result)}`);
  const blockedThree = result.x === 7 && result.y === 7;
  const provenCounterattack = result.value >= 10_000_000;
  assert.ok(blockedThree || provenCounterattack,
    `不堵三连时必须已经证明反击必胜: ${JSON.stringify(result)}`);
});
