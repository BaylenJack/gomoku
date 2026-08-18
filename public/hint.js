// 五子棋深度提示引擎 v12.0 — 2026 全量重写
// 独立架构：强制杀证明 + PVS/Alpha-Beta + 威胁静态延伸 + 双哈希置换表
// 固定上限：深度 10 / 3000 万节点 / 7 秒计算 / 8 秒端到端
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof self !== 'undefined') self.GomokuHint = factory();
  else root.GomokuHint = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 15;
  const CELLS = SIZE * SIZE;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const WIN = 10_000_000;
  const INF = 1_000_000_000;
  const TT_LIMIT = 160_000;
  const BUDGET = Symbol('deep-search-budget');
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const other = (role) => role === BLACK ? WHITE : BLACK;
  const indexOf = (x, y) => y * SIZE + x;
  const inBoard = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  const now = () => performance.now();

  const SCORE = Object.freeze({
    FIVE: WIN,
    OPEN_FOUR: 2_000_000,
    FOUR_THREE: 850_000,
    CLOSED_FOUR: 180_000,
    DOUBLE_THREE: 120_000,
    OPEN_THREE: 16_000,
    SLEEP_THREE: 2_200,
    OPEN_TWO: 420,
    SLEEP_TWO: 70,
  });

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
  }

  const Z1 = new Uint32Array(CELLS * 2);
  const Z2 = new Uint32Array(CELLS * 2);
  {
    const r1 = mulberry32(0xA341316C);
    const r2 = mulberry32(0xC8013EA4);
    for (let i = 0; i < Z1.length; i++) {
      Z1[i] = r1();
      Z2[i] = r2();
    }
  }

  function boardHash(board) {
    let h1 = 0;
    let h2 = 0;
    for (let i = 0; i < CELLS; i++) {
      const role = board[i];
      if (role === BLACK || role === WHITE) {
        const z = i * 2 + role - 1;
        h1 = (h1 ^ Z1[z]) >>> 0;
        h2 = (h2 ^ Z2[z]) >>> 0;
      }
    }
    return [h1, h2];
  }

  class Position {
    constructor(board) {
      this.board = board;
      const [h1, h2] = boardHash(board);
      this.h1 = h1;
      this.h2 = h2;
      this.stones = 0;
      this.last = -1;
      this.stack = [];
      for (let i = 0; i < CELLS; i++) if (board[i] !== EMPTY) this.stones++;
    }

    move(cell, role) {
      this.stack.push([cell, this.last]);
      this.board[cell] = role;
      const z = cell * 2 + role - 1;
      this.h1 = (this.h1 ^ Z1[z]) >>> 0;
      this.h2 = (this.h2 ^ Z2[z]) >>> 0;
      this.stones++;
      this.last = cell;
    }

    undo() {
      const [cell, previousLast] = this.stack.pop();
      const role = this.board[cell];
      const z = cell * 2 + role - 1;
      this.h1 = (this.h1 ^ Z1[z]) >>> 0;
      this.h2 = (this.h2 ^ Z2[z]) >>> 0;
      this.board[cell] = EMPTY;
      this.stones--;
      this.last = previousLast;
    }

    key(side) {
      const mixed = (this.h1 ^ Math.imul(side, 0x9E3779B1)) >>> 0;
      return this.h2 * 2_097_152 + (mixed >>> 11);
    }
  }

  function isWinAt(board, cell, role) {
    if (cell < 0 || board[cell] !== role) return false;
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    for (const [dx, dy] of DIRS) {
      let count = 1;
      for (let step = 1; step < 5; step++) {
        const nx = x + dx * step;
        const ny = y + dy * step;
        if (!inBoard(nx, ny) || board[indexOf(nx, ny)] !== role) break;
        count++;
      }
      for (let step = 1; step < 5; step++) {
        const nx = x - dx * step;
        const ny = y - dy * step;
        if (!inBoard(nx, ny) || board[indexOf(nx, ny)] !== role) break;
        count++;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  const LINE_STATE = new Int8Array(11);
  const LINE_CELL = new Int16Array(11);
  const PATTERNS = [
    [0, 1, 1, 1, 0],
    [0, 1, 1, 0, 1, 0],
    [0, 1, 0, 1, 1, 0],
  ];
  const TWO_PATTERNS = [[0, 0, 1, 1, 0, 0], [0, 1, 0, 1, 0]];
  const SHAPE_FIVE = 1;
  const SHAPE_OPEN_THREE = 2;
  const SHAPE_SLEEP_THREE = 4;
  const SHAPE_OPEN_TWO = 8;
  const SHAPE_SLEEP_TWO = 16;

  function containsPattern(pattern) {
    for (let start = 0; start + pattern.length <= 11; start++) {
      if (start > 5 || start + pattern.length <= 5) continue;
      let matched = true;
      for (let i = 0; i < pattern.length; i++) {
        if (LINE_STATE[start + i] !== pattern[i]) { matched = false; break; }
      }
      if (matched) return true;
    }
    return false;
  }

  function directionShape(board, x, y, dx, dy, role, winningCells) {
    for (let offset = -5; offset <= 5; offset++) {
      const lineIndex = offset + 5;
      const nx = x + dx * offset;
      const ny = y + dy * offset;
      if (!inBoard(nx, ny)) {
        LINE_STATE[lineIndex] = -1;
        LINE_CELL[lineIndex] = -1;
      } else {
        const cell = indexOf(nx, ny);
        const value = board[cell];
        LINE_CELL[lineIndex] = cell;
        LINE_STATE[lineIndex] = value === role ? 1 : value === EMPTY ? 0 : -1;
      }
    }

    let flags = 0;
    for (let start = 1; start <= 5; start++) {
      let own = 0;
      let empty = 0;
      let emptyIndex = -1;
      let blocked = false;
      for (let i = 0; i < 5; i++) {
        const state = LINE_STATE[start + i];
        if (state < 0) { blocked = true; break; }
        if (state === 1) own++;
        else { empty++; emptyIndex = start + i; }
      }
      if (blocked) continue;
      if (own === 5) flags |= SHAPE_FIVE;
      else if (own === 4 && empty === 1) {
        const win = LINE_CELL[emptyIndex];
        if (win >= 0 && !winningCells.includes(win)) winningCells.push(win);
      } else if (own === 3 && empty === 2) flags |= SHAPE_SLEEP_THREE;
      else if (own === 2 && empty === 3) flags |= SHAPE_SLEEP_TWO;
    }
    for (const pattern of PATTERNS) {
      if (containsPattern(pattern)) { flags |= SHAPE_OPEN_THREE; break; }
    }
    for (const pattern of TWO_PATTERNS) {
      if (containsPattern(pattern)) { flags |= SHAPE_OPEN_TWO; break; }
    }
    return flags;
  }

  function analyzePoint(position, cell, role) {
    const board = position.board;
    if (cell < 0 || cell >= CELLS || board[cell] !== EMPTY) {
      return { score: -INF, five: false, winCells: [], openThreeDirs: 0, forced: false };
    }
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    board[cell] = role;
    let five = false;
    let openThreeDirs = 0;
    let sleepThreeDirs = 0;
    let openTwoDirs = 0;
    let sleepTwoDirs = 0;
    const wins = [];
    for (const [dx, dy] of DIRS) {
      const shape = directionShape(board, x, y, dx, dy, role, wins);
      if (shape & SHAPE_FIVE) five = true;
      if (shape & SHAPE_OPEN_THREE) openThreeDirs++;
      if (shape & SHAPE_SLEEP_THREE) sleepThreeDirs++;
      if (shape & SHAPE_OPEN_TWO) openTwoDirs++;
      if (shape & SHAPE_SLEEP_TWO) sleepTwoDirs++;
    }
    board[cell] = EMPTY;

    const winCells = wins;
    let score;
    if (five) score = SCORE.FIVE;
    else if (winCells.length >= 2) score = SCORE.OPEN_FOUR;
    else if (winCells.length === 1 && openThreeDirs > 0) score = SCORE.FOUR_THREE;
    else if (winCells.length === 1) score = SCORE.CLOSED_FOUR;
    else if (openThreeDirs >= 2) score = SCORE.DOUBLE_THREE;
    else if (openThreeDirs === 1) score = SCORE.OPEN_THREE;
    else if (sleepThreeDirs > 0) score = SCORE.SLEEP_THREE * Math.min(2, sleepThreeDirs);
    else if (openTwoDirs > 0) score = SCORE.OPEN_TWO * Math.min(2, openTwoDirs);
    else score = SCORE.SLEEP_TWO * Math.min(2, sleepTwoDirs);

    const distance = Math.max(Math.abs(x - 7), Math.abs(y - 7));
    score += Math.max(0, 7 - distance) * 3;
    const forced = five || winCells.length >= 2 ||
      (winCells.length === 1 && openThreeDirs > 0) || openThreeDirs >= 2;
    return {
      score,
      five,
      winCells,
      openThreeDirs,
      sleepThreeDirs,
      openTwoDirs,
      forced,
    };
  }

  function nearbyCells(position, radius = 2) {
    if (position.stones === 0) return [indexOf(7, 7)];
    const marks = new Uint8Array(CELLS);
    const cells = [];
    for (let cell = 0; cell < CELLS; cell++) {
      if (position.board[cell] === EMPTY) continue;
      const x = cell % SIZE;
      const y = Math.floor(cell / SIZE);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inBoard(nx, ny)) continue;
          const next = indexOf(nx, ny);
          if (position.board[next] !== EMPTY || marks[next]) continue;
          marks[next] = 1;
          cells.push(next);
        }
      }
    }
    return cells;
  }

  function immediateWinMoves(position, role) {
    const wins = [];
    for (const cell of nearbyCells(position, 1)) {
      const info = analyzePoint(position, cell, role);
      if (info.five) wins.push(cell);
    }
    return wins;
  }

  function moveLimit(ply) {
    if (ply === 0) return 20;
    if (ply <= 2) return 14;
    if (ply <= 4) return 11;
    if (ply <= 6) return 9;
    return 7;
  }

  function insertPotential(top, value) {
    if (value <= 0) return;
    let index = top.length;
    while (index > 0 && top[index - 1] < value) index--;
    top.splice(index, 0, value);
    if (top.length > 6) top.length = 6;
  }

  function scanPosition(position, role, ctx) {
    const enemy = other(role);
    const all = [];
    const ownWins = [];
    const enemyWins = [];
    const ownPotential = [];
    const enemyPotential = [];
    const history = ctx && ctx.history ? ctx.history[role - 1] : null;
    for (const cell of nearbyCells(position, 2)) {
      const attack = analyzePoint(position, cell, role);
      const defense = analyzePoint(position, cell, enemy);
      insertPotential(ownPotential, attack.score);
      insertPotential(enemyPotential, defense.score);
      const item = {
        cell,
        attack,
        defense,
        tactical: attack.score >= SCORE.OPEN_THREE || defense.score >= SCORE.OPEN_THREE,
        order: Math.max(attack.score, defense.score * 1.14) + attack.score * 0.22 +
          (history ? history[cell] : 0),
      };
      if (attack.five) ownWins.push(item);
      if (defense.five) enemyWins.push(item);
      all.push(item);
    }
    const weights = [1, 0.55, 0.3, 0.16, 0.08, 0.04];
    let mine = 0;
    let theirs = 0;
    for (let i = 0; i < ownPotential.length; i++) mine += ownPotential[i] * weights[i];
    for (let i = 0; i < enemyPotential.length; i++) theirs += enemyPotential[i] * weights[i];
    const staticValue = Math.max(-(WIN - 1), Math.min(WIN - 1, Math.round(mine - theirs * 1.1 + 24)));
    return { all, ownWins, enemyWins, staticValue };
  }

  function selectMoves(scanned, ply, ctx, options = {}) {
    const { all, ownWins, enemyWins } = scanned;
    const byOrder = (a, b) => {
      if (options.ttMove === a.cell) return -1;
      if (options.ttMove === b.cell) return 1;
      if (a.order !== b.order) return b.order - a.order;
      return a.cell - b.cell;
    };
    ownWins.sort(byOrder);
    if (ownWins.length) return ownWins;
    enemyWins.sort(byOrder);
    if (enemyWins.length) return enemyWins;

    let moves = all;
    if (options.forcing) {
      moves = moves.filter((item) => item.attack.score >= SCORE.OPEN_THREE || item.attack.winCells.length > 0);
    }
    moves.sort(byOrder);
    const cap = options.cap || moveLimit(ply);
    const mustKeep = moves.filter((item) => item.tactical);
    const chosen = [];
    const seen = new Set();
    for (const item of [...mustKeep, ...moves]) {
      if (seen.has(item.cell)) continue;
      seen.add(item.cell);
      chosen.push(item);
      if (chosen.length >= cap) break;
    }

    if (options.root && chosen.length > 1 && ctx.rootOffset) {
      const shift = Math.floor(chosen.length * (ctx.rootOffset % 4) / 4);
      if (shift > 0) return [...chosen.slice(shift), ...chosen.slice(0, shift)];
    }
    return chosen;
  }

  function generateMoves(position, role, ply, ctx, options = {}) {
    return selectMoves(scanPosition(position, role, ctx), ply, ctx, options);
  }

  function evaluatePosition(position, role) {
    return scanPosition(position, role, null).staticValue;
  }

  function checkBudget(ctx) {
    ctx.nodes++;
    if (ctx.nodes > ctx.maxNodes) throw BUDGET;
    if ((ctx.nodes & 255) === 0 && now() >= ctx.deadline) throw BUDGET;
  }

  function forcingResponses(position, attacker, attackInfo) {
    const direct = immediateWinMoves(position, attacker);
    if (direct.length) return direct;
    if (attackInfo.openThreeDirs <= 0) return [];
    const responses = [];
    const seen = new Set();
    const defender = other(attacker);
    for (const cell of nearbyCells(position, 2)) {
      const attack = analyzePoint(position, cell, attacker);
      const counter = analyzePoint(position, cell, defender);
      // 防守方既可以占住进攻方的下一处双杀点，也可能以冲四/双杀反先。
      // 两类着法都必须进入证明树，不能只验证被动封堵。
      if (attack.winCells.length >= 2 || (attack.winCells.length === 1 && attack.openThreeDirs > 0) ||
          counter.winCells.length > 0 || counter.forced) {
        if (!seen.has(cell)) {
          seen.add(cell);
          responses.push(cell);
        }
      }
    }
    return responses;
  }

  function proveForcedWin(position, attacker, maxPly, ctx, softDeadline) {
    const memo = new Map();
    const savedDeadline = ctx.deadline;
    ctx.deadline = Math.min(savedDeadline, softDeadline);

    function attack(remaining) {
      checkBudget(ctx);
      if (remaining <= 0) return null;
      const key = `${position.key(attacker)}:${remaining}`;
      if (memo.has(key)) return memo.get(key);
      const defender = other(attacker);
      const moves = generateMoves(position, attacker, 0, ctx, { forcing: true, cap: 12 });
      for (const item of moves) {
        const move = item.cell;
        position.move(move, attacker);
        try {
          if (isWinAt(position.board, move, attacker)) {
            const path = [move];
            memo.set(key, path);
            return path;
          }

          // 对手若此刻能直接成五，当前进攻链不成立。
          if (immediateWinMoves(position, defender).length) continue;
          // 一手同时产生两个直接成五点时，对手一手无法全部封住；这是可以
          // 当场完成的证明。四三、双三仍需展开，避免忽略对手的反先手。
          if (item.attack.winCells.length >= 2) {
            const path = [move];
            memo.set(key, path);
            return path;
          }

          const responses = forcingResponses(position, attacker, item.attack);
          if (!responses.length) continue;
          let allWin = true;
          let longest = [];
          for (const response of responses) {
            if (position.board[response] !== EMPTY) continue;
            position.move(response, defender);
            let child = null;
            try {
              if (!isWinAt(position.board, response, defender)) child = attack(remaining - 2);
            } finally {
              position.undo();
            }
            if (!child) { allWin = false; break; }
            if (child.length > longest.length) longest = child;
          }
          if (allWin) {
            const path = [move, ...longest];
            memo.set(key, path);
            return path;
          }
        } finally {
          position.undo();
        }
      }
      memo.set(key, null);
      return null;
    }

    try {
      const path = attack(maxPly);
      return { path, complete: true };
    } finally {
      ctx.deadline = savedDeadline;
    }
  }

  function quiescence(position, role, ply, alpha, beta, ctx, qDepth) {
    checkBudget(ctx);
    if (position.last >= 0 && isWinAt(position.board, position.last, other(role))) return -WIN + ply;
    const scanned = scanPosition(position, role, ctx);
    const stand = scanned.staticValue;
    const canWinNow = scanned.ownWins.length > 0;
    const forcedDefense = !canWinNow && scanned.enemyWins.length > 0;
    if (forcedDefense && scanned.enemyWins.length >= 2) return -WIN + ply;
    if (!forcedDefense) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (qDepth >= 2) return stand;
    }

    const moves = selectMoves(scanned, ply, ctx, { cap: 8 });
    const tactical = moves.filter((item) => item.attack.score >= SCORE.CLOSED_FOUR ||
      item.defense.score >= SCORE.CLOSED_FOUR || item.attack.five || item.defense.five);
    if (!tactical.length) return stand;
    for (const item of tactical) {
      position.move(item.cell, role);
      let score;
      try {
        score = isWinAt(position.board, item.cell, role)
          ? WIN - ply - 1
          : -quiescence(position, other(role), ply + 1, -beta, -alpha, ctx, qDepth + 1);
      } finally {
        position.undo();
      }
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(position, role, depth, ply, alpha, beta, ctx) {
    checkBudget(ctx);
    if (position.last >= 0 && isWinAt(position.board, position.last, other(role))) return -WIN + ply;
    if (depth <= 0) return quiescence(position, role, ply, alpha, beta, ctx, 0);

    const alphaStart = alpha;
    const key = position.key(role);
    const cached = ctx.tt.get(key);
    if (cached && cached.depth >= depth) {
      if (cached.flag === 0) return cached.value;
      if (cached.flag === 1 && cached.value >= beta) return cached.value;
      if (cached.flag === 2 && cached.value <= alpha) return cached.value;
    }

    const killerA = ctx.killers[ply] ? ctx.killers[ply][0] : -1;
    const killerB = ctx.killers[ply] ? ctx.killers[ply][1] : -1;
    const moves = generateMoves(position, role, ply, ctx, { ttMove: cached ? cached.move : -1 });
    moves.sort((a, b) => {
      const ak = a.cell === killerA ? 2 : a.cell === killerB ? 1 : 0;
      const bk = b.cell === killerA ? 2 : b.cell === killerB ? 1 : 0;
      return bk - ak;
    });
    if (!moves.length) return evaluatePosition(position, role);

    let best = -INF;
    let bestMove = -1;
    for (let i = 0; i < moves.length; i++) {
      const item = moves[i];
      position.move(item.cell, role);
      let score;
      try {
        if (isWinAt(position.board, item.cell, role)) {
          score = WIN - ply - 1;
        } else if (i === 0) {
          score = -negamax(position, other(role), depth - 1, ply + 1, -beta, -alpha, ctx);
        } else {
          let nextDepth = depth - 1;
          const quiet = !item.tactical;
          if (depth >= 5 && i >= 5 && quiet) nextDepth = Math.max(0, depth - 2);
          score = -negamax(position, other(role), nextDepth, ply + 1, -alpha - 1, -alpha, ctx);
          if (score > alpha && score < beta) {
            score = -negamax(position, other(role), depth - 1, ply + 1, -beta, -alpha, ctx);
          }
        }
      } finally {
        position.undo();
      }

      if (score > best) { best = score; bestMove = item.cell; }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!ctx.killers[ply]) ctx.killers[ply] = [-1, -1];
        if (ctx.killers[ply][0] !== item.cell) {
          ctx.killers[ply][1] = ctx.killers[ply][0];
          ctx.killers[ply][0] = item.cell;
        }
        ctx.history[role - 1][item.cell] += depth * depth;
        break;
      }
    }

    if (ctx.tt.size < TT_LIMIT && bestMove >= 0) {
      const flag = best <= alphaStart ? 2 : best >= beta ? 1 : 0;
      ctx.tt.set(key, { depth, value: best, move: bestMove, flag });
    }
    return best;
  }

  function extractPV(position, role, rootMove, depth, ctx) {
    const path = [];
    const applied = [];
    let side = role;
    let move = rootMove;
    try {
      for (let ply = 0; ply < depth && move >= 0 && position.board[move] === EMPTY; ply++) {
        position.move(move, side);
        applied.push(move);
        path.push([move % SIZE, Math.floor(move / SIZE)]);
        if (isWinAt(position.board, move, side)) break;
        side = other(side);
        const entry = ctx.tt.get(position.key(side));
        move = entry ? entry.move : -1;
      }
    } finally {
      while (applied.length) { position.undo(); applied.pop(); }
    }
    return path;
  }

  function rootSearch(position, role, depth, ctx) {
    const moves = generateMoves(position, role, 0, ctx, { root: true });
    if (!moves.length) return null;
    let alpha = -INF;
    const beta = INF;
    let best = -INF;
    let bestMove = -1;
    for (let i = 0; i < moves.length; i++) {
      checkBudget(ctx);
      const item = moves[i];
      position.move(item.cell, role);
      let score;
      try {
        if (isWinAt(position.board, item.cell, role)) score = WIN;
        else if (i === 0) score = -negamax(position, other(role), depth - 1, 1, -beta, -alpha, ctx);
        else {
          score = -negamax(position, other(role), depth - 1, 1, -alpha - 1, -alpha, ctx);
          if (score > alpha) score = -negamax(position, other(role), depth - 1, 1, -beta, -alpha, ctx);
        }
      } finally {
        position.undo();
      }
      if (score > best) { best = score; bestMove = item.cell; }
      if (score > alpha) alpha = score;
      if (best >= WIN) break;
    }
    if (bestMove < 0) return null;
    return { value: best, move: bestMove, path: extractPV(position, role, bestMove, depth, ctx) };
  }

  function createContext(maxNodes, deadline, rootOffset) {
    return {
      nodes: 0,
      maxNodes,
      deadline,
      rootOffset,
      tt: new Map(),
      killers: [],
      history: [new Int32Array(CELLS), new Int32Array(CELLS)],
      predictedStop: false,
      iterations: [],
    };
  }

  function createEvaluator(board) {
    const position = new Position(board);
    return {
      init() {},
      move(x, y, role) { position.move(indexOf(x, y), role); },
      undo() { position.undo(); },
      evaluate(role) { return evaluatePosition(position, role); },
      hash() { return [position.h1, position.h2]; },
    };
  }

  function validate(board, color) {
    if (!Array.isArray(board) || board.length !== CELLS) throw new TypeError('board 必须是 225 格数组');
    if (color !== BLACK && color !== WHITE) throw new TypeError('color 必须是 1 或 2');
    let empty = 0;
    for (let i = 0; i < CELLS; i++) {
      if (board[i] === EMPTY) empty++;
      else if (board[i] !== BLACK && board[i] !== WHITE) throw new TypeError(`board[${i}] 棋子值非法`);
    }
    if (!empty) throw new Error('棋盘已满，没有合法落点');
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== EMPTY && isWinAt(board, i, board[i])) throw new Error('棋局已结束，不能继续搜索');
    }
  }

  function resultFromCell(cell, extras = {}) {
    return { x: cell % SIZE, y: Math.floor(cell / SIZE), ...extras };
  }

  function computeBest(board, color, opts = {}) {
    const startedAt = now();
    validate(board, color);
    const position = new Position(board.slice());

    // 生产配置固定不接受客户端降档；测试配置只允许缩小预算。
    const depth = 10;
    const nodeBudget = 30000000;
    const timeBudgetMs = 7000;
    const test = opts.__testConfig || null;
    const targetDepth = test && Number.isInteger(test.depth)
      ? Math.max(2, Math.min(depth, test.depth)) : depth;
    const maxNodes = test && Number.isFinite(test.maxNodes)
      ? Math.max(100, Math.min(nodeBudget, test.maxNodes)) : nodeBudget;
    const maxMs = test && Number.isFinite(test.maxMs)
      ? Math.max(50, Math.min(timeBudgetMs, test.maxMs)) : timeBudgetMs;
    const rootOffset = Number.isInteger(opts.workerId) ? Math.abs(opts.workerId) % 4 : 0;
    const hardDeadline = startedAt + maxMs;
    const ctx = createContext(maxNodes, hardDeadline, rootOffset);

    if (position.stones === 0) {
      return resultFromCell(indexOf(7, 7), {
        value: 0, path: [[7, 7]], depth: 0, verified: true, nodes: 0,
        predictedStop: false, iterations: [], engine: 'deep-v12',
      });
    }

    const directWins = immediateWinMoves(position, color);
    if (directWins.length) {
      return resultFromCell(directWins[0], {
        value: WIN, path: [[directWins[0] % SIZE, Math.floor(directWins[0] / SIZE)]],
        depth: 0, verified: true, nodes: 0, predictedStop: false,
        iterations: [], engine: 'deep-v12',
      });
    }

    // 第一阶段：只在对手没有一步杀时证明己方强制杀。证明成功可直接结束；
    // 对手已经冲四时绝不以“自己的计划”覆盖必堵点。
    const opponentWins = immediateWinMoves(position, other(color));
    if (!opponentWins.length) {
      const threatDeadline = Math.min(hardDeadline - 1, startedAt + Math.min(1500, maxMs * 0.22));
      try {
        const forced = proveForcedWin(position, color, Math.min(13, targetDepth + 3), ctx, threatDeadline);
        if (forced.path && forced.path.length) {
          const cell = forced.path[0];
          return resultFromCell(cell, {
            value: WIN,
            path: forced.path.map((move) => [move % SIZE, Math.floor(move / SIZE)]),
            depth: Math.max(2, forced.path.length), verified: true, nodes: ctx.nodes,
            predictedStop: false, iterations: [], engine: 'deep-v12',
          });
        }
      } catch (error) {
        if (error !== BUDGET) throw error;
      }
    }

    // 第二阶段：PVS 逐层加深。安全审计固定预留最后一段时间。
    const safetyReserve = Math.min(750, maxMs * 0.14);
    ctx.deadline = Math.max(now() + 30, hardDeadline - safetyReserve);
    let best = null;
    let previousMs = 0;
    let beforePreviousMs = 0;
    for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
      if (currentDepth >= 6 && previousMs > 0) {
        const remaining = ctx.deadline - now();
        const growth = beforePreviousMs > 0
          ? Math.max(1.7, Math.min(7, previousMs / beforePreviousMs)) : 3;
        if (remaining < previousMs * growth * 1.12) {
          ctx.predictedStop = true;
          break;
        }
      }
      const iterStart = now();
      const iterNodes = ctx.nodes;
      try {
        const found = rootSearch(position, color, currentDepth, ctx);
        if (!found) break;
        best = { ...found, depth: currentDepth };
        const elapsed = now() - iterStart;
        ctx.iterations.push({
          depth: currentDepth,
          ms: Math.round(elapsed * 100) / 100,
          nodes: ctx.nodes - iterNodes,
        });
        beforePreviousMs = previousMs;
        previousMs = Math.max(0.01, elapsed);
        if (found.value >= WIN) break;
      } catch (error) {
        if (error !== BUDGET) throw error;
        break;
      }
    }

    if (!best) {
      const fallback = generateMoves(position, color, 0, ctx, { root: true, cap: 20 })[0];
      const cell = fallback ? fallback.cell : nearbyCells(position, 2)[0];
      return resultFromCell(cell, {
        value: fallback ? fallback.order : 0,
        path: [[cell % SIZE, Math.floor(cell / SIZE)]], depth: 0,
        verified: false, nodes: ctx.nodes, predictedStop: ctx.predictedStop,
        iterations: ctx.iterations, engine: 'deep-v12',
      });
    }

    let finalMove = best.move;
    let verified = best.value >= WIN;

    // 第三阶段：把主搜索着法真正落下，再从对手视角寻找强制杀。
    // 找到反杀时抢占其启动点；审计超时则明确标记未验证，供四路谈合降权。
    if (!verified && now() < hardDeadline - 20) {
      position.move(best.move, color);
      try {
        ctx.deadline = hardDeadline;
        try {
          const danger = proveForcedWin(position, other(color), Math.min(9, targetDepth), ctx, hardDeadline);
          if (danger.path && danger.path.length) {
            const block = danger.path[0];
            if (board[block] === EMPTY && block !== best.move) finalMove = block;
            verified = false;
          } else {
            verified = danger.complete;
          }
        } catch (error) {
          if (error !== BUDGET) throw error;
          verified = false;
        }
      } finally {
        position.undo();
      }
    }

    const path = finalMove === best.move
      ? best.path
      : [[finalMove % SIZE, Math.floor(finalMove / SIZE)]];
    return resultFromCell(finalMove, {
      value: best.value,
      path,
      depth: best.depth,
      verified,
      nodes: ctx.nodes,
      predictedStop: ctx.predictedStop,
      iterations: ctx.iterations,
      engine: 'deep-v12',
    });
  }

  const __test__ = {
    boardHash,
    createEvaluator,
    analyzePoint(board, x, y, role) {
      const position = new Position(board.slice());
      return analyzePoint(position, indexOf(x, y), role);
    },
    valuableMoves(board, role, opts = {}) {
      const position = new Position(board.slice());
      const ctx = createContext(1_000_000, now() + 5000, 0);
      return generateMoves(position, role, opts.cDepth || 0, ctx, { root: (opts.cDepth || 0) === 0 })
        .map((item) => [item.cell % SIZE, Math.floor(item.cell / SIZE)]);
    },
    evaluateBoard(board, role) {
      return evaluatePosition(new Position(board.slice()), role);
    },
    immediateWins(board, role) {
      return immediateWinMoves(new Position(board.slice()), role)
        .map((cell) => [cell % SIZE, Math.floor(cell / SIZE)]);
    },
  };

  return { computeBest, __test__, constants: { SIZE, WIN } };
});
