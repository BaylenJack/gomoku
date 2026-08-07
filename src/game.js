// 五子棋规则核心 — 纯函数, 无副作用, 可独立测试
//
// 规则集: Freestyle Gomoku (自由五子棋 / 无禁手)
//   - 15x15 棋盘, 黑先
//   - 横/竖/斜任意方向连成 5 子或以上即胜 (长连算胜)
//   - 无三三/四四/长连禁手 (那是连珠 Renju 规则, 休闲玩家门槛太高)
//   - 棋盘下满无五连 = 和棋
// 参考: https://en.wikipedia.org/wiki/Gomoku

export const SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const idx = (x, y) => y * SIZE + x;
export const inBounds = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

export function createBoard() {
  return new Array(SIZE * SIZE).fill(EMPTY);
}

// 四个方向: 横, 竖, 主对角, 副对角
const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/**
 * 检查在 (x,y) 落下 color 后是否成五连(或更长)。
 * 返回 null 或 { line: [[x,y],...] } — line 含该方向上完整的连子(可能 >5)
 */
export function checkWin(board, x, y, color) {
  if (!inBounds(x, y)) return null;
  for (const [dx, dy] of DIRS) {
    // 回退到这条连子的起点
    let sx = x;
    let sy = y;
    while (inBounds(sx - dx, sy - dy) && board[idx(sx - dx, sy - dy)] === color) {
      sx -= dx;
      sy -= dy;
    }
    // 从起点向前收集
    const line = [];
    let cx = sx;
    let cy = sy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === color) {
      line.push([cx, cy]);
      cx += dx;
      cy += dy;
    }
    // Freestyle: 5 子及以上都算胜
    if (line.length >= 5) return { line };
  }
  return null;
}

export function isFull(board) {
  return board.every((v) => v !== EMPTY);
}

export const other = (color) => (color === BLACK ? WHITE : BLACK);

/**
 * 校验一手棋是否合法。合法返回 null, 非法返回错误原因字符串。
 */
export function validateMove(state, x, y, color) {
  if (state.status !== 'playing') return '对局未在进行中';
  if (!Number.isInteger(x) || !Number.isInteger(y)) return '坐标非法';
  if (!inBounds(x, y)) return '落子超出棋盘';
  if (state.turn !== color) return '还没轮到你';
  if (state.board[idx(x, y)] !== EMPTY) return '该位置已有棋子';
  return null;
}

/**
 * 落子并推进对局状态。调用前必须先通过 validateMove。
 * 直接修改传入的 state (服务端持有唯一实例)。
 */
export function applyMove(state, x, y, color, now = Date.now()) {
  state.board[idx(x, y)] = color;
  state.moves.push({ x, y, color, t: now });
  state.lastMove = { x, y, color };

  const win = checkWin(state.board, x, y, color);
  if (win) {
    state.status = 'won';
    state.winner = color;
    state.winLine = win.line;
    return state;
  }
  if (isFull(state.board)) {
    state.status = 'draw';
    state.winner = null;
    return state;
  }
  state.turn = other(color);
  return state;
}

/**
 * 悔棋: 回退到请求方的上一手之前, 使其重新获得落子权。
 * 若最后一手是对方下的, 需回退 2 手; 若是自己刚下的, 回退 1 手。
 * 返回实际回退的手数 (0 表示无棋可悔)。
 */
export function applyUndo(state, requesterColor) {
  if (state.moves.length === 0) return 0;
  let popped = 0;
  // 先弹掉对方压在上面的手
  while (state.moves.length > 0 && state.moves[state.moves.length - 1].color !== requesterColor) {
    const m = state.moves.pop();
    state.board[idx(m.x, m.y)] = EMPTY;
    popped++;
  }
  // 再弹掉请求方自己的那一手
  if (state.moves.length > 0 && state.moves[state.moves.length - 1].color === requesterColor) {
    const m = state.moves.pop();
    state.board[idx(m.x, m.y)] = EMPTY;
    popped++;
  }
  if (popped === 0) return 0;

  // 悔棋后对局回到进行中, 轮到请求方
  state.status = 'playing';
  state.winner = null;
  state.winLine = null;
  state.turn = requesterColor;
  state.lastMove =
    state.moves.length > 0
      ? {
          x: state.moves[state.moves.length - 1].x,
          y: state.moves[state.moves.length - 1].y,
          color: state.moves[state.moves.length - 1].color,
        }
      : null;
  return popped;
}
