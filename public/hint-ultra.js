// 五子棋超深度提示引擎 v13.0 — 根分片并行 / 增量线评估 / 保守 VCF 证明
// 固定生产上限：选择性深度 14 / 6000 万节点 / 6.8 秒计算 / 8 秒端到端
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof self !== 'undefined') self.GomokuUltraHint = factory();
  else root.GomokuUltraHint = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 15;
  const CELLS = SIZE * SIZE;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const WIN = 10_000_000;
  const INF = 1_000_000_000;
  const TT_LIMIT = 260_000;
  const BUDGET = Symbol('ultra-budget');
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const other = (role) => role === BLACK ? WHITE : BLACK;
  const at = (x, y) => y * SIZE + x;
  const inside = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  const now = () => performance.now();

  const SCORE = Object.freeze({
    FIVE: WIN,
    OPEN_FOUR: 2_200_000,
    FOUR_THREE: 920_000,
    CLOSED_FOUR: 210_000,
    DOUBLE_THREE: 145_000,
    OPEN_THREE: 19_000,
    SLEEP_THREE: 2_600,
    OPEN_TWO: 480,
    SLEEP_TWO: 80,
  });

  function random32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return (value ^ (value >>> 14)) >>> 0;
    };
  }

  const Z1 = new Uint32Array(CELLS * 2);
  const Z2 = new Uint32Array(CELLS * 2);
  {
    const first = random32(0xB5297A4D);
    const second = random32(0x68E31DA4);
    for (let i = 0; i < Z1.length; i++) {
      Z1[i] = first();
      Z2[i] = second();
    }
  }

  const LINES = [];
  const CELL_LINES = Array.from({ length: CELLS }, () => []);
  const AFFECTED = Array.from({ length: CELLS }, () => []);

  function addLine(cells) {
    if (cells.length < 5) return;
    const id = LINES.length;
    LINES.push(Int16Array.from(cells));
    for (const cell of cells) CELL_LINES[cell].push(id);
  }

  for (let y = 0; y < SIZE; y++) addLine(Array.from({ length: SIZE }, (_, x) => at(x, y)));
  for (let x = 0; x < SIZE; x++) addLine(Array.from({ length: SIZE }, (_, y) => at(x, y)));
  for (let sx = 0; sx < SIZE; sx++) {
    const main = [];
    for (let x = sx, y = 0; inside(x, y); x++, y++) main.push(at(x, y));
    addLine(main);
    const anti = [];
    for (let x = sx, y = SIZE - 1; inside(x, y); x++, y--) anti.push(at(x, y));
    addLine(anti);
  }
  for (let sy = 1; sy < SIZE; sy++) {
    const main = [];
    for (let x = 0, y = sy; inside(x, y); x++, y++) main.push(at(x, y));
    addLine(main);
    if (sy < SIZE - 1) {
      const anti = [];
      for (let x = 0, y = sy; inside(x, y); x++, y--) anti.push(at(x, y));
      addLine(anti);
    }
  }
  for (let cell = 0; cell < CELLS; cell++) {
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    const seen = new Uint8Array(CELLS);
    seen[cell] = 1;
    AFFECTED[cell].push(cell);
    for (const [dx, dy] of DIRS) {
      for (let offset = -5; offset <= 5; offset++) {
        const nx = x + dx * offset;
        const ny = y + dy * offset;
        if (!inside(nx, ny)) continue;
        const target = at(nx, ny);
        if (seen[target]) continue;
        seen[target] = 1;
        AFFECTED[cell].push(target);
      }
    }
  }

  function lineValue(board, line, role) {
    const enemy = other(role);
    let value = 0;
    let i = 0;
    while (i < line.length) {
      if (board[line[i]] !== role) { i++; continue; }
      const start = i;
      while (i < line.length && board[line[i]] === role) i++;
      const length = i - start;
      const leftOpen = start > 0 && board[line[start - 1]] === EMPTY;
      const rightOpen = i < line.length && board[line[i]] === EMPTY;
      const openings = Number(leftOpen) + Number(rightOpen);
      if (length >= 5) value += WIN;
      else if (length === 4) value += openings === 2 ? 520_000 : openings === 1 ? 82_000 : 0;
      else if (length === 3) value += openings === 2 ? 13_500 : openings === 1 ? 1_900 : 0;
      else if (length === 2) value += openings === 2 ? 410 : openings === 1 ? 75 : 0;
      else if (openings === 2) value += 18;
    }
    for (let start = 0; start + 5 <= line.length; start++) {
      let own = 0;
      let vacant = 0;
      let blocked = false;
      for (let step = 0; step < 5; step++) {
        const stone = board[line[start + step]];
        if (stone === enemy) { blocked = true; break; }
        if (stone === role) own++;
        else vacant++;
      }
      if (blocked) continue;
      if (own === 4 && vacant === 1) value += 64_000;
      else if (own === 3 && vacant === 2) value += 980;
      else if (own === 2 && vacant === 3) value += 55;
    }
    return Math.min(WIN - 1, value);
  }

  function hashBoard(board) {
    let h1 = 0;
    let h2 = 0;
    for (let cell = 0; cell < CELLS; cell++) {
      const role = board[cell];
      if (role !== BLACK && role !== WHITE) continue;
      const z = cell * 2 + role - 1;
      h1 = (h1 ^ Z1[z]) >>> 0;
      h2 = (h2 ^ Z2[z]) >>> 0;
    }
    return [h1, h2];
  }

  class Position {
    constructor(board) {
      this.board = board;
      this.stones = 0;
      this.last = -1;
      this.stack = [];
      this.neighbors = new Uint8Array(CELLS);
      this.lineScores = [new Int32Array(LINES.length), new Int32Array(LINES.length)];
      this.totals = [0, 0];
      this.pointScores = [new Int32Array(CELLS), new Int32Array(CELLS)];
      this.pointWins = [new Uint8Array(CELLS), new Uint8Array(CELLS)];
      this.pointOpenThrees = [new Uint8Array(CELLS), new Uint8Array(CELLS)];
      this.pointFive = [new Uint8Array(CELLS), new Uint8Array(CELLS)];
      [this.h1, this.h2] = hashBoard(board);
      for (let cell = 0; cell < CELLS; cell++) {
        if (board[cell] === EMPTY) continue;
        this.stones++;
        this.adjustNeighbors(cell, 1);
      }
      for (let id = 0; id < LINES.length; id++) {
        for (let role = BLACK; role <= WHITE; role++) {
          const score = lineValue(board, LINES[id], role);
          this.lineScores[role - 1][id] = score;
          this.totals[role - 1] += score;
        }
      }
      for (let cell = 0; cell < CELLS; cell++) this.refreshPoint(cell);
    }

    adjustNeighbors(cell, delta) {
      const x = cell % SIZE;
      const y = Math.floor(cell / SIZE);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inside(nx, ny)) continue;
          this.neighbors[at(nx, ny)] += delta;
        }
      }
    }

    refresh(cell, before) {
      for (const id of CELL_LINES[cell]) {
        for (let role = BLACK; role <= WHITE; role++) {
          const previous = this.lineScores[role - 1][id];
          const next = before ? 0 : lineValue(this.board, LINES[id], role);
          if (before) this.totals[role - 1] -= previous;
          else {
            this.lineScores[role - 1][id] = next;
            this.totals[role - 1] += next;
          }
        }
      }
    }

    refreshPoint(cell) {
      for (let role = BLACK; role <= WHITE; role++) {
        const side = role - 1;
        if (this.board[cell] !== EMPTY) {
          this.pointScores[side][cell] = -INF;
          this.pointWins[side][cell] = 0;
          this.pointOpenThrees[side][cell] = 0;
          this.pointFive[side][cell] = 0;
          continue;
        }
        const info = pointInfo(this, cell, role);
        this.pointScores[side][cell] = info.score;
        this.pointWins[side][cell] = info.wins.length;
        this.pointOpenThrees[side][cell] = info.openThrees;
        this.pointFive[side][cell] = info.five ? 1 : 0;
      }
    }

    refreshAffected(cell) {
      for (const target of AFFECTED[cell]) this.refreshPoint(target);
    }

    move(cell, role) {
      this.refresh(cell, true);
      this.stack.push([cell, this.last]);
      this.board[cell] = role;
      const z = cell * 2 + role - 1;
      this.h1 = (this.h1 ^ Z1[z]) >>> 0;
      this.h2 = (this.h2 ^ Z2[z]) >>> 0;
      this.adjustNeighbors(cell, 1);
      this.stones++;
      this.last = cell;
      this.refresh(cell, false);
      this.refreshAffected(cell);
    }

    undo() {
      const [cell, previousLast] = this.stack.pop();
      const role = this.board[cell];
      this.refresh(cell, true);
      this.adjustNeighbors(cell, -1);
      const z = cell * 2 + role - 1;
      this.h1 = (this.h1 ^ Z1[z]) >>> 0;
      this.h2 = (this.h2 ^ Z2[z]) >>> 0;
      this.board[cell] = EMPTY;
      this.stones--;
      this.last = previousLast;
      this.refresh(cell, false);
      this.refreshAffected(cell);
    }

    key(role) {
      const mixed = (this.h1 ^ Math.imul(role, 0x9E3779B1)) >>> 0;
      return this.h2 * 2_097_152 + (mixed >>> 11);
    }

    evaluate(role) {
      const mine = this.totals[role - 1];
      const theirs = this.totals[other(role) - 1];
      return Math.max(-(WIN - 1), Math.min(WIN - 1, Math.round(mine - theirs * 1.13 + 32)));
    }
  }

  function winsAt(board, cell, role) {
    if (cell < 0 || board[cell] !== role) return false;
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    for (const [dx, dy] of DIRS) {
      let count = 1;
      for (let step = 1; step < 5; step++) {
        const nx = x + dx * step;
        const ny = y + dy * step;
        if (!inside(nx, ny) || board[at(nx, ny)] !== role) break;
        count++;
      }
      for (let step = 1; step < 5; step++) {
        const nx = x - dx * step;
        const ny = y - dy * step;
        if (!inside(nx, ny) || board[at(nx, ny)] !== role) break;
        count++;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  const LINE_STATE = new Int8Array(11);
  const LINE_CELL = new Int16Array(11);
  const OPEN_THREES = [[0,1,1,1,0], [0,1,1,0,1,0], [0,1,0,1,1,0]];
  const OPEN_TWOS = [[0,0,1,1,0,0], [0,1,0,1,0]];

  function matches(pattern) {
    for (let start = 0; start + pattern.length <= 11; start++) {
      if (start > 5 || start + pattern.length <= 5) continue;
      let ok = true;
      for (let i = 0; i < pattern.length; i++) {
        if (LINE_STATE[start + i] !== pattern[i]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  function pointInfo(position, cell, role) {
    const board = position.board;
    if (cell < 0 || cell >= CELLS || board[cell] !== EMPTY) {
      return { score: -INF, five: false, wins: [], openThrees: 0, forcing: false };
    }
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    board[cell] = role;
    const wins = [];
    let five = false;
    let openThrees = 0;
    let sleepThrees = 0;
    let openTwos = 0;
    let sleepTwos = 0;
    for (const [dx, dy] of DIRS) {
      for (let offset = -5; offset <= 5; offset++) {
        const p = offset + 5;
        const nx = x + dx * offset;
        const ny = y + dy * offset;
        if (!inside(nx, ny)) {
          LINE_STATE[p] = -1;
          LINE_CELL[p] = -1;
        } else {
          const next = at(nx, ny);
          LINE_CELL[p] = next;
          LINE_STATE[p] = board[next] === role ? 1 : board[next] === EMPTY ? 0 : -1;
        }
      }
      let directionSleepThree = false;
      let directionSleepTwo = false;
      for (let start = 1; start <= 5; start++) {
        let own = 0;
        let vacant = 0;
        let vacancy = -1;
        let blocked = false;
        for (let step = 0; step < 5; step++) {
          const state = LINE_STATE[start + step];
          if (state < 0) { blocked = true; break; }
          if (state === 1) own++;
          else { vacant++; vacancy = start + step; }
        }
        if (blocked) continue;
        if (own === 5) five = true;
        else if (own === 4 && vacant === 1) {
          const win = LINE_CELL[vacancy];
          if (win >= 0 && !wins.includes(win)) wins.push(win);
        } else if (own === 3 && vacant === 2) directionSleepThree = true;
        else if (own === 2 && vacant === 3) directionSleepTwo = true;
      }
      if (OPEN_THREES.some(matches)) openThrees++;
      if (directionSleepThree) sleepThrees++;
      if (OPEN_TWOS.some(matches)) openTwos++;
      if (directionSleepTwo) sleepTwos++;
    }
    board[cell] = EMPTY;

    let score = 0;
    if (five) score = SCORE.FIVE;
    else if (wins.length >= 2) score = SCORE.OPEN_FOUR;
    else if (wins.length === 1 && openThrees > 0) score = SCORE.FOUR_THREE;
    else if (wins.length === 1) score = SCORE.CLOSED_FOUR;
    else if (openThrees >= 2) score = SCORE.DOUBLE_THREE;
    else if (openThrees === 1) score = SCORE.OPEN_THREE;
    else if (sleepThrees > 0) score = SCORE.SLEEP_THREE * Math.min(2, sleepThrees);
    else if (openTwos > 0) score = SCORE.OPEN_TWO * Math.min(2, openTwos);
    else score = SCORE.SLEEP_TWO * Math.min(2, sleepTwos);
    const distance = Math.max(Math.abs(x - 7), Math.abs(y - 7));
    score += Math.max(0, 7 - distance) * 4;
    return {
      score,
      five,
      wins,
      openThrees,
      forcing: five || wins.length > 0 || openThrees >= 2,
    };
  }

  function candidateCells(position) {
    if (position.stones === 0) return [at(7, 7)];
    const result = [];
    for (let cell = 0; cell < CELLS; cell++) {
      if (position.board[cell] === EMPTY && position.neighbors[cell] > 0) result.push(cell);
    }
    return result;
  }

  function immediateWins(position, role) {
    const wins = [];
    for (const cell of candidateCells(position)) {
      if (position.pointFive[role - 1][cell]) wins.push(cell);
    }
    return wins;
  }

  function moveCap(ply) {
    if (ply === 0) return 20;
    if (ply <= 2) return 10;
    if (ply <= 4) return 8;
    if (ply <= 7) return 6;
    return 5;
  }

  function generate(position, role, ply, ctx, options = {}) {
    const enemy = other(role);
    const all = [];
    const ownWins = [];
    const enemyWins = [];
    const history = ctx ? ctx.history[role - 1] : null;
    for (const cell of candidateCells(position)) {
      const attack = {
        score: position.pointScores[role - 1][cell],
        five: position.pointFive[role - 1][cell] !== 0,
        winCount: position.pointWins[role - 1][cell],
        openThrees: position.pointOpenThrees[role - 1][cell],
      };
      attack.forcing = attack.five || attack.winCount > 0 || attack.openThrees >= 2;
      const defense = {
        score: position.pointScores[enemy - 1][cell],
        five: position.pointFive[enemy - 1][cell] !== 0,
        winCount: position.pointWins[enemy - 1][cell],
        openThrees: position.pointOpenThrees[enemy - 1][cell],
      };
      defense.forcing = defense.five || defense.winCount > 0 || defense.openThrees >= 2;
      const tactical = attack.score >= SCORE.OPEN_THREE || defense.score >= SCORE.OPEN_THREE;
      const item = {
        cell,
        attack,
        defense,
        tactical,
        order: attack.score * 1.22 + defense.score * 1.16 + (history ? history[cell] : 0),
      };
      if (attack.five) ownWins.push(item);
      if (defense.five) enemyWins.push(item);
      all.push(item);
    }
    const order = (a, b) => {
      if (a.cell === options.ttMove) return -1;
      if (b.cell === options.ttMove) return 1;
      if (a.order !== b.order) return b.order - a.order;
      return a.cell - b.cell;
    };
    ownWins.sort(order);
    enemyWins.sort(order);
    let pool = ownWins.length ? ownWins : enemyWins.length ? enemyWins : all;
    if (options.forcing) pool = pool.filter((item) => item.attack.five || item.attack.winCount > 0);
    pool.sort(order);

    const cap = options.cap || moveCap(ply);
    const selected = [];
    const seen = new Set();
    const tacticalMoves = pool.filter((move) => move.tactical);
    const targetCount = Math.max(cap, tacticalMoves.length);
    for (const item of [...tacticalMoves, ...pool]) {
      if (seen.has(item.cell)) continue;
      seen.add(item.cell);
      selected.push(item);
      if (selected.length >= targetCount) break;
    }
    if (options.root && options.shardCount > 1 && !ownWins.length && !enemyWins.length) {
      return {
        moves: selected.filter((_, rank) => rank % options.shardCount === options.shardIndex),
        ownWinCount: 0,
        enemyWinCount: 0,
      };
    }
    return { moves: selected, ownWinCount: ownWins.length, enemyWinCount: enemyWins.length };
  }

  function tick(ctx) {
    ctx.nodes++;
    if (ctx.nodes > ctx.maxNodes) throw BUDGET;
    if ((ctx.nodes & 63) === 0 && now() >= ctx.deadline) throw BUDGET;
  }

  function qsearch(position, role, ply, alpha, beta, ctx, qDepth) {
    tick(ctx);
    if (position.last >= 0 && winsAt(position.board, position.last, other(role))) return -WIN + ply;
    const generated = generate(position, role, ply, ctx, { cap: 8 });
    const canWin = generated.ownWinCount > 0;
    const forcedDefense = !canWin && generated.enemyWinCount > 0;
    if (forcedDefense && generated.enemyWinCount >= 2) return -WIN + ply;
    const stand = position.evaluate(role);
    if (!forcedDefense) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (qDepth >= 3) return stand;
    }
    const tactical = generated.moves.filter((item) => canWin || forcedDefense ||
      item.attack.score >= SCORE.CLOSED_FOUR || item.defense.score >= SCORE.CLOSED_FOUR);
    if (!tactical.length) return stand;
    for (const item of tactical) {
      position.move(item.cell, role);
      let value;
      try {
        value = winsAt(position.board, item.cell, role)
          ? WIN - ply - 1
          : -qsearch(position, other(role), ply + 1, -beta, -alpha, ctx, qDepth + 1);
      } finally {
        position.undo();
      }
      if (value >= beta) return value;
      if (value > alpha) alpha = value;
    }
    return alpha;
  }

  function negamax(position, role, depth, ply, alpha, beta, ctx, extensionsLeft) {
    tick(ctx);
    if (position.last >= 0 && winsAt(position.board, position.last, other(role))) return -WIN + ply;
    if (depth <= 0) return qsearch(position, role, ply, alpha, beta, ctx, 0);

    const alphaStart = alpha;
    const key = position.key(role);
    const cached = ctx.tt.get(key);
    if (cached && cached.depth >= depth) {
      if (cached.flag === 0) return cached.value;
      if (cached.flag === 1 && cached.value >= beta) return cached.value;
      if (cached.flag === 2 && cached.value <= alpha) return cached.value;
    }
    const generated = generate(position, role, ply, ctx, { ttMove: cached ? cached.move : -1 });
    if (!generated.moves.length) return position.evaluate(role);
    const killers = ctx.killers[ply] || [-1, -1];
    generated.moves.sort((a, b) => {
      const first = a.cell === killers[0] ? 2 : a.cell === killers[1] ? 1 : 0;
      const second = b.cell === killers[0] ? 2 : b.cell === killers[1] ? 1 : 0;
      return second - first;
    });

    let best = -INF;
    let bestMove = -1;
    for (let i = 0; i < generated.moves.length; i++) {
      const item = generated.moves[i];
      position.move(item.cell, role);
      let value;
      try {
        if (winsAt(position.board, item.cell, role)) {
          value = WIN - ply - 1;
        } else {
          const forcing = item.attack.winCount > 0 || item.defense.winCount > 0 ||
            item.attack.openThrees >= 2 || item.defense.openThrees >= 2;
          let nextDepth = depth - 1;
          let nextExtensions = extensionsLeft;
          if (forcing && extensionsLeft > 0 && depth >= 2) {
            nextDepth = depth;
            nextExtensions--;
          } else if (!item.tactical && depth >= 5 && i >= 4) {
            nextDepth = Math.max(0, depth - (i >= 8 ? 3 : 2));
          }
          if (i === 0) {
            value = -negamax(position, other(role), nextDepth, ply + 1, -beta, -alpha, ctx, nextExtensions);
          } else {
            value = -negamax(position, other(role), nextDepth, ply + 1, -alpha - 1, -alpha, ctx, nextExtensions);
            if (value > alpha && value < beta) {
              value = -negamax(position, other(role), forcing ? Math.max(nextDepth, depth - 1) : depth - 1,
                ply + 1, -beta, -alpha, ctx, nextExtensions);
            }
          }
        }
      } finally {
        position.undo();
      }
      if (value > best) { best = value; bestMove = item.cell; }
      if (value > alpha) alpha = value;
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

  function rootSearch(position, role, depth, alpha, beta, ctx, shardIndex, shardCount) {
    const generated = generate(position, role, 0, ctx, { root: true, shardIndex, shardCount });
    if (!generated.moves.length) return null;
    let best = -INF;
    let bestMove = -1;
    const scores = [];
    for (let i = 0; i < generated.moves.length; i++) {
      tick(ctx);
      const item = generated.moves[i];
      position.move(item.cell, role);
      let value;
      try {
        if (winsAt(position.board, item.cell, role)) value = WIN;
        else if (i === 0) value = -negamax(position, other(role), depth - 1, 1, -beta, -alpha, ctx, 2);
        else {
          value = -negamax(position, other(role), depth - 1, 1, -alpha - 1, -alpha, ctx, 2);
          if (value > alpha && value < beta) {
            value = -negamax(position, other(role), depth - 1, 1, -beta, -alpha, ctx, 2);
          }
        }
      } finally {
        position.undo();
      }
      scores.push({ move: item.cell, value });
      if (value > best) { best = value; bestMove = item.cell; }
      if (value > alpha) alpha = value;
    }
    scores.sort((a, b) => b.value - a.value || a.move - b.move);
    return { move: bestMove, value: best, scores };
  }

  function proveVCF(position, attacker, maxPly, ctx, deadline) {
    const memo = new Map();
    const previousDeadline = ctx.deadline;
    ctx.deadline = Math.min(previousDeadline, deadline);
    function attack(remaining) {
      tick(ctx);
      if (remaining <= 0) return null;
      const key = `${position.key(attacker)}:${remaining}`;
      if (memo.has(key)) return memo.get(key);
      const defender = other(attacker);
      const generated = generate(position, attacker, 0, ctx, { forcing: true, cap: 18 });
      for (const item of generated.moves) {
        position.move(item.cell, attacker);
        try {
          if (winsAt(position.board, item.cell, attacker)) {
            const path = [item.cell];
            memo.set(key, path);
            return path;
          }
          if (immediateWins(position, defender).length) continue;
          const wins = immediateWins(position, attacker);
          if (wins.length >= 2) {
            const path = [item.cell];
            memo.set(key, path);
            return path;
          }
          if (wins.length !== 1 || position.board[wins[0]] !== EMPTY) continue;
          position.move(wins[0], defender);
          let child;
          try {
            child = attack(remaining - 2);
          } finally {
            position.undo();
          }
          if (child) {
            const path = [item.cell, wins[0], ...child];
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
      return { path: attack(maxPly), complete: true };
    } finally {
      ctx.deadline = previousDeadline;
    }
  }

  function validate(board, color) {
    if (!Array.isArray(board) || board.length !== CELLS) throw new TypeError('board 必须是 225 格数组');
    if (color !== BLACK && color !== WHITE) throw new TypeError('color 必须是 1 或 2');
    let vacant = 0;
    for (let i = 0; i < CELLS; i++) {
      if (board[i] === EMPTY) vacant++;
      else if (board[i] !== BLACK && board[i] !== WHITE) throw new TypeError(`board[${i}] 棋子值非法`);
    }
    if (!vacant) throw new Error('棋盘已满，没有合法落点');
    for (let i = 0; i < CELLS; i++) {
      if (board[i] !== EMPTY && winsAt(board, i, board[i])) throw new Error('棋局已结束，不能继续搜索');
    }
  }

  function context(maxNodes, deadline) {
    return {
      nodes: 0,
      maxNodes,
      deadline,
      tt: new Map(),
      killers: [],
      history: [new Int32Array(CELLS), new Int32Array(CELLS)],
    };
  }

  function asResult(cell, extras) {
    return { x: cell % SIZE, y: Math.floor(cell / SIZE), ...extras };
  }

  function computeBest(board, color, options = {}) {
    const startedAt = now();
    validate(board, color);
    const position = new Position(board.slice());
    const depth = 14;
    const nodeBudget = 60000000;
    const timeBudgetMs = 6800;
    const test = options.__testConfig || null;
    const targetDepth = test && Number.isInteger(test.depth) ? Math.max(2, Math.min(depth, test.depth)) : depth;
    const maxNodes = test && Number.isFinite(test.maxNodes) ? Math.max(100, Math.min(nodeBudget, test.maxNodes)) : nodeBudget;
    const maxMs = test && Number.isFinite(test.maxMs) ? Math.max(50, Math.min(timeBudgetMs, test.maxMs)) : timeBudgetMs;
    const shardCount = Number.isInteger(options.shardCount) ? Math.max(1, Math.min(8, options.shardCount)) : 1;
    const shardIndex = Number.isInteger(options.shardIndex) ? Math.max(0, Math.min(shardCount - 1, options.shardIndex)) : 0;
    const hardDeadline = startedAt + maxMs;
    const ctx = context(maxNodes, hardDeadline);

    if (position.stones === 0) return asResult(at(7, 7), {
      value: 0, depth: 0, nodes: 0, verified: true, path: [[7, 7]], iterations: [], engine: 'ultra-v13',
    });
    const ownWins = immediateWins(position, color);
    if (ownWins.length) return asResult(ownWins[0], {
      value: WIN, depth: 0, nodes: 0, verified: true,
      path: [[ownWins[0] % SIZE, Math.floor(ownWins[0] / SIZE)]], iterations: [], engine: 'ultra-v13',
    });
    const enemyWins = immediateWins(position, other(color));
    if (enemyWins.length) return asResult(enemyWins[0], {
      value: enemyWins.length > 1 ? -WIN : 0, depth: 0, nodes: 0, verified: true,
      path: [[enemyWins[0] % SIZE, Math.floor(enemyWins[0] / SIZE)]], iterations: [], engine: 'ultra-v13',
    });

    if (options.proof !== false) {
      ctx.deadline = Math.min(hardDeadline - 1, startedAt + Math.min(900, maxMs * 0.15));
      try {
        const proof = proveVCF(position, color, Math.min(21, targetDepth + 7), ctx, ctx.deadline);
        if (proof.path && proof.path.length) {
          const cell = proof.path[0];
          return asResult(cell, {
            value: WIN,
            depth: Math.max(2, proof.path.length),
            nodes: ctx.nodes,
            verified: true,
            path: proof.path.map((move) => [move % SIZE, Math.floor(move / SIZE)]),
            iterations: [],
            engine: 'ultra-v13',
          });
        }
      } catch (error) {
        if (error !== BUDGET) throw error;
      }
    }

    const searchDeadline = hardDeadline - Math.min(360, maxMs * 0.07);
    ctx.deadline = Math.max(now() + 25, searchDeadline);
    const iterations = [];
    let best = null;
    let previousValue = 0;
    let previousMs = 0;
    let olderMs = 0;
    let predictedStop = false;
    for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
      if (currentDepth >= 6 && previousMs > 0) {
        const growth = olderMs > 0 ? Math.max(1.6, Math.min(6, previousMs / olderMs)) : 2.8;
        if (ctx.deadline - now() < previousMs * growth * 1.08) { predictedStop = true; break; }
      }
      const iterationStart = now();
      const iterationNodes = ctx.nodes;
      let alpha = currentDepth >= 3 ? previousValue - 18_000 : -INF;
      let beta = currentDepth >= 3 ? previousValue + 18_000 : INF;
      try {
        let found = rootSearch(position, color, currentDepth, alpha, beta, ctx, shardIndex, shardCount);
        if (found && (found.value <= alpha || found.value >= beta)) {
          found = rootSearch(position, color, currentDepth, -INF, INF, ctx, shardIndex, shardCount);
        }
        if (!found) break;
        best = { ...found, depth: currentDepth };
        previousValue = found.value;
        const elapsed = now() - iterationStart;
        const entry = {
          depth: currentDepth,
          x: found.move % SIZE,
          y: Math.floor(found.move / SIZE),
          value: found.value,
          ms: Math.round(elapsed * 100) / 100,
          nodes: ctx.nodes - iterationNodes,
        };
        iterations.push(entry);
        olderMs = previousMs;
        previousMs = Math.max(0.01, elapsed);
        if (found.value >= WIN) break;
      } catch (error) {
        if (error !== BUDGET) throw error;
        break;
      }
    }

    if (!best) {
      const fallback = generate(position, color, 0, ctx, { root: true, shardIndex, shardCount }).moves[0] ||
        generate(position, color, 0, ctx, {}).moves[0];
      if (!fallback) throw new Error('没有可用候选点');
      return asResult(fallback.cell, {
        value: fallback.order,
        depth: 0,
        nodes: ctx.nodes,
        verified: false,
        path: [[fallback.cell % SIZE, Math.floor(fallback.cell / SIZE)]],
        iterations,
        predictedStop,
        engine: 'ultra-v13',
      });
    }

    let verified = best.value >= WIN;
    if (!verified && now() < hardDeadline - 20) {
      position.move(best.move, color);
      try {
        ctx.deadline = hardDeadline;
        try {
          const danger = proveVCF(position, other(color), Math.min(13, targetDepth), ctx, hardDeadline);
          verified = !danger.path && danger.complete;
        } catch (error) {
          if (error !== BUDGET) throw error;
          verified = false;
        }
      } finally {
        position.undo();
      }
    }

    return asResult(best.move, {
      value: best.value,
      depth: best.depth,
      nodes: ctx.nodes,
      verified,
      path: [[best.move % SIZE, Math.floor(best.move / SIZE)]],
      iterations,
      predictedStop,
      engine: 'ultra-v13',
    });
  }

  const __test__ = {
    hashBoard,
    pointInfo(board, x, y, role) { return pointInfo(new Position(board.slice()), at(x, y), role); },
    immediateWins(board, role) {
      return immediateWins(new Position(board.slice()), role).map((cell) => [cell % SIZE, Math.floor(cell / SIZE)]);
    },
    valuableMoves(board, role) {
      const position = new Position(board.slice());
      const ctx = context(1_000_000, now() + 3000);
      return generate(position, role, 0, ctx, { root: true, shardIndex: 0, shardCount: 1 }).moves
        .map((move) => [move.cell % SIZE, Math.floor(move.cell / SIZE)]);
    },
    incrementalConsistency(board) {
      const work = board.slice();
      const position = new Position(work);
      const matchesFresh = () => {
        const fresh = new Position(work.slice());
        if (position.h1 !== fresh.h1 || position.h2 !== fresh.h2 ||
            position.totals[0] !== fresh.totals[0] || position.totals[1] !== fresh.totals[1]) return false;
        for (let role = 0; role < 2; role++) {
          for (let cell = 0; cell < CELLS; cell++) {
            if (position.pointScores[role][cell] !== fresh.pointScores[role][cell] ||
                position.pointWins[role][cell] !== fresh.pointWins[role][cell] ||
                position.pointOpenThrees[role][cell] !== fresh.pointOpenThrees[role][cell] ||
                position.pointFive[role][cell] !== fresh.pointFive[role][cell]) return false;
          }
        }
        return true;
      };
      if (!matchesFresh()) return false;
      let applied = 0;
      for (let step = 0; step < 6; step++) {
        const move = candidateCells(position)[step % Math.max(1, candidateCells(position).length)];
        if (move === undefined) break;
        position.move(move, step % 2 === 0 ? BLACK : WHITE);
        applied++;
        if (!matchesFresh()) return false;
      }
      while (applied-- > 0) {
        position.undo();
        if (!matchesFresh()) return false;
      }
      return matchesFresh() && work.every((value, index) => value === board[index]);
    },
  };

  return { computeBest, __test__ };
});
