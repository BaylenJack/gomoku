import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE,
  EMPTY,
  BLACK,
  WHITE,
  idx,
  createBoard,
  checkWin,
  isFull,
  validateMove,
  applyMove,
  applyUndo,
  other,
} from '../src/game.js';

// 构造一个处于对局中的干净状态
function freshState() {
  return {
    board: createBoard(),
    moves: [],
    turn: BLACK,
    status: 'playing',
    winner: null,
    winLine: null,
    lastMove: null,
  };
}

// 在棋盘上按方向铺若干子(不走 applyMove, 用于直接测 checkWin)
function place(board, x, y, dx, dy, n, color) {
  for (let i = 0; i < n; i++) board[idx(x + dx * i, y + dy * i)] = color;
}

test('棋盘初始为 15x15 全空', () => {
  const b = createBoard();
  assert.equal(b.length, 225);
  assert.equal(SIZE, 15);
  assert.ok(b.every((v) => v === EMPTY));
});

test('横向五连判胜, 且返回完整连线', () => {
  const b = createBoard();
  place(b, 3, 7, 1, 0, 5, BLACK);
  const r = checkWin(b, 5, 7, BLACK);
  assert.ok(r, '应判定为五连');
  assert.equal(r.line.length, 5);
  assert.deepEqual(r.line, [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]);
});

test('纵向五连判胜', () => {
  const b = createBoard();
  place(b, 2, 1, 0, 1, 5, WHITE);
  assert.ok(checkWin(b, 2, 3, WHITE));
});

test('主对角线五连判胜', () => {
  const b = createBoard();
  place(b, 0, 0, 1, 1, 5, BLACK);
  assert.ok(checkWin(b, 2, 2, BLACK));
});

test('副对角线五连判胜', () => {
  const b = createBoard();
  place(b, 0, 8, 1, -1, 5, WHITE);
  assert.ok(checkWin(b, 2, 6, WHITE));
});

test('四连不判胜', () => {
  const b = createBoard();
  place(b, 3, 7, 1, 0, 4, BLACK);
  assert.equal(checkWin(b, 5, 7, BLACK), null);
});

test('Freestyle: 长连(六子)算胜, 且连线完整返回 6 子', () => {
  const b = createBoard();
  place(b, 3, 7, 1, 0, 6, BLACK);
  const r = checkWin(b, 5, 7, BLACK);
  assert.ok(r, '自由五子棋中长连应算胜');
  assert.equal(r.line.length, 6);
});

test('被对方子截断则不算连', () => {
  const b = createBoard();
  place(b, 3, 7, 1, 0, 2, BLACK);
  b[idx(5, 7)] = WHITE;
  place(b, 6, 7, 1, 0, 3, BLACK);
  assert.equal(checkWin(b, 4, 7, BLACK), null);
  assert.equal(checkWin(b, 7, 7, BLACK), null);
});

test('连子跨越棋盘边界不会误判(不发生行折返)', () => {
  const b = createBoard();
  // 第 7 行末尾 3 子 + 第 8 行开头 2 子, 一维上连续但二维上不同行
  place(b, 12, 7, 1, 0, 3, BLACK);
  place(b, 0, 8, 1, 0, 2, BLACK);
  assert.equal(checkWin(b, 14, 7, BLACK), null, '不应把跨行的子当成横向连');
});

test('validateMove 拦截非法落子', () => {
  const s = freshState();
  assert.equal(validateMove(s, 7, 7, BLACK), null, '合法落子应通过');
  assert.ok(validateMove(s, 7, 7, WHITE), '未轮到白棋应被拒');
  assert.ok(validateMove(s, -1, 7, BLACK), '越界应被拒');
  assert.ok(validateMove(s, 15, 7, BLACK), '越界应被拒');
  assert.ok(validateMove(s, 1.5, 7, BLACK), '非整数坐标应被拒');

  applyMove(s, 7, 7, BLACK);
  assert.ok(validateMove(s, 7, 7, WHITE), '已有棋子的位置应被拒');

  s.status = 'won';
  assert.ok(validateMove(s, 0, 0, s.turn), '对局结束后不可落子');
});

test('applyMove 正常交替行棋并记录 lastMove', () => {
  const s = freshState();
  applyMove(s, 7, 7, BLACK);
  assert.equal(s.turn, WHITE);
  assert.deepEqual(s.lastMove, { x: 7, y: 7, color: BLACK });
  applyMove(s, 8, 8, WHITE);
  assert.equal(s.turn, BLACK);
  assert.equal(s.moves.length, 2);
});

test('applyMove 成五后置为 won 并停在胜方', () => {
  const s = freshState();
  for (let i = 0; i < 4; i++) {
    applyMove(s, i, 0, BLACK);
    applyMove(s, i, 5, WHITE);
  }
  applyMove(s, 4, 0, BLACK);
  assert.equal(s.status, 'won');
  assert.equal(s.winner, BLACK);
  assert.equal(s.winLine.length, 5);
  assert.equal(validateMove(s, 10, 10, WHITE), '对局未在进行中');
});

test('棋盘下满且无五连判和棋', () => {
  const b = createBoard();
  assert.equal(isFull(b), false);
  b.fill(BLACK);
  assert.equal(isFull(b), true);
});

test('悔棋: 对方刚落子时回退 2 手, 落子权回到请求方', () => {
  const s = freshState();
  applyMove(s, 7, 7, BLACK);
  applyMove(s, 8, 8, WHITE);
  assert.equal(s.turn, BLACK);

  const n = applyUndo(s, BLACK);
  assert.equal(n, 2);
  assert.equal(s.moves.length, 0);
  assert.equal(s.turn, BLACK);
  assert.equal(s.board[idx(7, 7)], EMPTY);
  assert.equal(s.board[idx(8, 8)], EMPTY);
  assert.equal(s.lastMove, null);
});

test('悔棋: 自己刚落子对方未跟时只回退 1 手', () => {
  const s = freshState();
  applyMove(s, 7, 7, BLACK);
  applyMove(s, 8, 8, WHITE);
  applyMove(s, 7, 8, BLACK);
  assert.equal(s.turn, WHITE);

  const n = applyUndo(s, BLACK);
  assert.equal(n, 1, '只应弹掉黑棋自己最后一手');
  assert.equal(s.moves.length, 2);
  assert.equal(s.turn, BLACK);
  assert.deepEqual(s.lastMove, { x: 8, y: 8, color: WHITE });
});

test('悔棋可以撤销已判定的胜局', () => {
  const s = freshState();
  for (let i = 0; i < 4; i++) {
    applyMove(s, i, 0, BLACK);
    applyMove(s, i, 5, WHITE);
  }
  applyMove(s, 4, 0, BLACK);
  assert.equal(s.status, 'won');

  applyUndo(s, BLACK);
  assert.equal(s.status, 'playing');
  assert.equal(s.winner, null);
  assert.equal(s.winLine, null);
  assert.equal(s.turn, BLACK);
});

test('空棋盘悔棋返回 0 且不改变状态', () => {
  const s = freshState();
  assert.equal(applyUndo(s, BLACK), 0);
  assert.equal(s.moves.length, 0);
  assert.equal(s.turn, BLACK);
});

test('other 正确翻转颜色', () => {
  assert.equal(other(BLACK), WHITE);
  assert.equal(other(WHITE), BLACK);
});
