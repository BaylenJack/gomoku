// 房间逻辑 — 座位分配、身份认领、对局推进
//
// 身份模型: 每个玩家持有一个 token(存 localStorage), 断线重连时凭 token 认领
// 原座位。这样刷新页面、切网络、手机息屏都不会丢失身份 —— 这是"稳定"的关键。

import { createBoard, BLACK, WHITE, validateMove, applyMove, applyUndo, other } from './game.js';

export function createRoom(id) {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // 座位: token -> 颜色。先到者执黑
    seats: {},
    names: {}, // color -> 昵称
    board: createBoard(),
    moves: [],
    turn: BLACK,
    status: 'waiting', // waiting | playing | won | draw
    winner: null,
    winLine: null,
    lastMove: null,
    // 每局交换先手: 记录下一局谁执黑
    nextBlackToken: null,
    score: {}, // token -> 胜局数
    undoRequest: null, // { by: color } 待对方确认的悔棋请求
    timer: { enabled: false, perMoveSec: 60 },
  };
}

export function seatCount(room) {
  return Object.keys(room.seats).length;
}

export function colorOf(room, token) {
  return room.seats[token] ?? null;
}

export function tokenOf(room, color) {
  return Object.keys(room.seats).find((t) => room.seats[t] === color) ?? null;
}

/**
 * 认领座位。已有座位的 token 直接返回原座位(断线重连),
 * 新 token 在有空位时入座, 满员则作为观战者返回 null。
 */
export function claimSeat(room, token, name) {
  if (room.seats[token] != null) {
    if (name) room.names[room.seats[token]] = name;
    return room.seats[token];
  }
  const taken = new Set(Object.values(room.seats));
  let color = null;
  if (!taken.has(BLACK)) color = BLACK;
  else if (!taken.has(WHITE)) color = WHITE;
  else return null; // 满员 → 观战

  room.seats[token] = color;
  room.names[color] = name || (color === BLACK ? '黑方' : '白方');
  if (room.score[token] == null) room.score[token] = 0;

  // 两人到齐, 开局
  if (seatCount(room) === 2 && room.status === 'waiting') {
    room.status = 'playing';
  }
  room.updatedAt = Date.now();
  return color;
}

export function tryMove(room, token, x, y) {
  const color = colorOf(room, token);
  if (color == null) return { ok: false, error: '你是观战者, 不能落子' };
  const err = validateMove(room, x, y, color);
  if (err) return { ok: false, error: err };

  applyMove(room, x, y, color);
  room.undoRequest = null; // 落子后作废未决的悔棋请求
  room.updatedAt = Date.now();

  if (room.status === 'won') {
    const winToken = tokenOf(room, color);
    if (winToken) room.score[winToken] = (room.score[winToken] || 0) + 1;
  }
  return { ok: true };
}

export function requestUndo(room, token) {
  const color = colorOf(room, token);
  if (color == null) return { ok: false, error: '观战者不能悔棋' };
  if (room.moves.length === 0) return { ok: false, error: '还没有落子' };
  if (room.undoRequest) return { ok: false, error: '已有待处理的悔棋请求' };
  room.undoRequest = { by: color };
  room.updatedAt = Date.now();
  return { ok: true, by: color };
}

export function resolveUndo(room, token, accept) {
  const color = colorOf(room, token);
  if (color == null) return { ok: false, error: '观战者无权处理' };
  if (!room.undoRequest) return { ok: false, error: '没有待处理的悔棋请求' };
  if (room.undoRequest.by === color) return { ok: false, error: '不能自己同意自己的悔棋' };

  const by = room.undoRequest.by;
  room.undoRequest = null;
  if (!accept) {
    room.updatedAt = Date.now();
    return { ok: true, accepted: false, by };
  }

  // 若悔的是已判胜的那一手, 需把胜局数扣回去(但超时判负不回退 —— 超时是已发生
  // 的事件, 悔棋只能回退棋盘, 不能撤销超时事实; 否则超时方可以无限悔棋刷分)。
  const wasWon = room.status === 'won';
  const wasTimeoutWin = wasWon && !room.winLine; // winLine 仅在五连判胜时设置
  const winToken = wasWon ? tokenOf(room, room.winner) : null;
  const n = applyUndo(room, by);
  if (wasWon && !wasTimeoutWin && winToken && room.score[winToken] > 0) room.score[winToken]--;

  room.updatedAt = Date.now();
  return { ok: true, accepted: true, by, undone: n };
}

/**
 * 开始新一局 — 交换先手以抵消先手优势。
 * 五子棋先手优势极大(理论已证明先手必胜), 每局交换是最简单的平衡手段,
 * 比 Swap2 少一个学习成本, 适合休闲对局。
 */
export function newGame(room) {
  const tokens = Object.keys(room.seats);
  if (tokens.length === 2) {
    // 交换两人的颜色
    for (const t of tokens) room.seats[t] = other(room.seats[t]);
    const n0 = room.names[BLACK];
    room.names[BLACK] = room.names[WHITE];
    room.names[WHITE] = n0;
  }
  room.board = createBoard();
  room.moves = [];
  room.turn = BLACK;
  room.status = tokens.length === 2 ? 'playing' : 'waiting';
  room.winner = null;
  room.winLine = null;
  room.lastMove = null;
  room.undoRequest = null;
  room.updatedAt = Date.now();
}

/** 发给客户端的视图 — 不含其他人的 token */
export function publicView(room, viewerToken) {
  const you = colorOf(room, viewerToken);
  const scoreByColor = {};
  for (const [t, c] of Object.entries(room.seats)) scoreByColor[c] = room.score[t] || 0;
  return {
    id: room.id,
    board: room.board,
    moves: room.moves.length,
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    winLine: room.winLine,
    lastMove: room.lastMove,
    names: room.names,
    score: scoreByColor,
    you,
    seated: seatCount(room),
    undoRequest: room.undoRequest,
    timer: room.timer,
  };
}
