// 五子棋提示引擎 v6 — 借鉴 gobang (lihongxun945) 的 MiniMax + Alpha-Beta + VCT/VCF
//
// 架构来源: https://github.com/lihongxun945/gobang
//   1. 增量点位评估: 每个空位缓存四方向棋形分数, 落子只更新周围 5 格,
//      评估 = 己方全盘空位分数 - 对方全盘空位分数 (免全盘重扫)
//   2. 分级移动生成: 成五 > 活四 > 冲四 > 双四 > 双三 > 冲四活三 > 活三 >
//      双活二 > 眠三 > 活二, 每级取前 N 个; 复合棋形(双四/双三/冲四活三)组合计数
//   3. 迭代加深 Alpha-Beta: 只搜偶数层(己方能赢的解), 必胜即返回,
//      必输选最长路径挣扎; 缓存(Zobrist)跨搜索共享
//   4. VCT/VCF: 只搜活三/冲四(强制链)的变体, 先找杀, 再常规搜索
//   5. 防守妙手: 走一步后检查对方杀棋路径是否变长 —— 变长则防守有效,
//      否则改堵对方杀棋起点。这解决"看不到对手经营意图"的盲区
//
// 预算: 节点 + 时间双重上限, 超时回退启发式 —— 手机上不卡。
// 隐私: 纯本地计算, 结果只画在本地 canvas, 不经 WebSocket。

(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.GomokuHint = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 15;
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const idx = (x, y) => y * SIZE + x;
  const inB = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const other = (c) => (c === BLACK ? WHITE : BLACK);

  const BUDGET = Symbol('budget');

  // ---------- Zobrist 哈希 (确定性种子) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ZB = (() => {
    const rnd = mulberry32(0x9E3779B9);
    const t = new Uint32Array(SIZE * SIZE * 2 + 2);
    for (let i = 0; i < t.length; i++) t[i] = (rnd() * 4294967296) >>> 0;
    return t;
  })();
  const zOf = (cell, color) => ZB[cell * 2 + (color - 1)];
  function boardHash(board) {
    let h = 0;
    for (let i = 0; i < board.length; i++) {
      if (board[i] !== EMPTY) h = (h ^ zOf(i, board[i])) >>> 0;
    }
    return h;
  }

  // ---------- 棋形识别 (gobang shape.js 字符串法) ----------
  const SH = {
    FIVE: 5, BLOCK_FIVE: 50, FOUR: 4, FOUR_FOUR: 44, FOUR_THREE: 43,
    THREE_THREE: 33, BLOCK_FOUR: 40, THREE: 3, BLOCK_THREE: 30,
    TWO_TWO: 22, TWO: 2, NONE: 0,
  };
  const PAT = {
    five: /11111/,
    blockfive: /211111|111112/,
    four: /011110/,
    blockFour: /10111|11011|11101|211110|211101|211011|210111|011112|101112|110112|111012/,
    three: /011100|011010|010110|001110/,
    blockThree: /211100|211010|210110|001112|010112|011012/,
    two: /001100|011000|000110|010100|001010/,
  };

  // 在 (x,y) 放 role 后沿 (dx,dy) 方向的棋形
  function getShape(board, x, y, dx, dy, role) {
    let s = '1';
    for (let i = 1; i <= 5; i++) {
      const nx = x + dx * i, ny = y + dy * i;
      if (!inB(nx, ny)) { s += '2'; break; }
      const v = board[idx(nx, ny)];
      if (v === EMPTY) s += '0';
      else if (v === role) s += '1';
      else { s += '2'; break; }
    }
    for (let i = 1; i <= 5; i++) {
      const nx = x - dx * i, ny = y - dy * i;
      if (!inB(nx, ny)) { s = '2' + s; break; }
      const v = board[idx(nx, ny)];
      if (v === EMPTY) s = '0' + s;
      else if (v === role) s = '1' + s;
      else { s = '2' + s; break; }
    }
    if (PAT.five.test(s)) return SH.FIVE;
    if (PAT.blockfive.test(s)) return SH.BLOCK_FIVE;
    if (PAT.four.test(s)) return SH.FOUR;
    if (PAT.blockFour.test(s)) return SH.BLOCK_FOUR;
    if (PAT.three.test(s)) return SH.THREE;
    if (PAT.blockThree.test(s)) return SH.BLOCK_THREE;
    if (PAT.two.test(s)) return SH.TWO;
    return SH.NONE;
  }

  // ---------- 评分权重 (gobang eval.js) ----------
  const FIVE = 10000000;
  const FOUR = 100000;
  const FOUR_FOUR = FOUR;
  const FOUR_THREE = FOUR;
  const THREE_THREE = FOUR / 2;
  const BLOCK_FOUR = 1500;
  const THREE = 1000;
  const BLOCK_THREE = 150;
  const TWO_TWO = 200;
  const TWO = 100;
  const BLOCK_TWO = 15;
  const ONE = 10;

  // 棋形 → 落子潜力分 (当前点未落子的得分)
  function shapeScore(shape) {
    switch (shape) {
      case SH.FIVE: return FOUR;
      case SH.BLOCK_FIVE: return BLOCK_FOUR;
      case SH.FOUR: return THREE;
      case SH.FOUR_FOUR: return THREE;
      case SH.FOUR_THREE: return THREE;
      case SH.BLOCK_FOUR: return BLOCK_THREE;
      case SH.THREE: return TWO;
      case SH.THREE_THREE: return THREE_THREE / 10;
      case SH.BLOCK_THREE: return BLOCK_TWO;
      case SH.TWO: return ONE;
      case SH.TWO_TWO: return TWO_TWO / 10;
      default: return 0;
    }
  }

  // ---------- 增量点位评估器 (gobang eval.js) ----------
  // scores[roleIdx][cell], shapeCache[roleIdx][cell*4+dir]
  function createEvaluator(board) {
    const N = SIZE, NN = N * N;
    const scores = [new Float64Array(NN), new Float64Array(NN)];
    const shapeCache = [new Int8Array(NN * 4), new Int8Array(NN * 4)];

    function updatePoint(x, y, role) {
      const rIdx = role - 1;
      const c = idx(x, y);
      let total = 0;
      let fourCnt = 0, blockFourCnt = 0, threeCnt = 0, twoCnt = 0;
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d];
        const sh = getShape(board, x, y, dx, dy, role);
        shapeCache[rIdx][c * 4 + d] = sh;
        if (sh === SH.FOUR) fourCnt++;
        else if (sh === SH.BLOCK_FOUR) blockFourCnt++;
        else if (sh === SH.THREE) threeCnt++;
        else if (sh === SH.TWO) twoCnt++;
        total += shapeScore(sh);
      }
      // 复合棋形: 双四/冲四活三/双三/双活二
      if (fourCnt >= 2 || (fourCnt && blockFourCnt >= 2)) {
        // 双冲四或活四+冲四 → 极高
        total += FOUR_FOUR * 0.6;
      } else if (blockFourCnt >= 2) {
        total += FOUR_FOUR * 0.4;
      } else if (blockFourCnt && threeCnt) {
        total += FOUR_THREE * 0.4;
      } else if (threeCnt >= 2) {
        total += THREE_THREE * 0.4;
      } else if (twoCnt >= 2) {
        total += TWO_TWO * 0.4;
      }
      scores[rIdx][c] = total;
    }

    function refresh(x, y) {
      // 落子点影响周围 5 格内的所有空位
      for (const [dx, dy] of DIRS) {
        for (const sign of [1, -1]) {
          for (let step = 1; step <= 5; step++) {
            const nx = x + sign * step * dx, ny = y + sign * step * dy;
            if (!inB(nx, ny)) break;
            if (board[idx(nx, ny)] !== EMPTY) continue;
            updatePoint(nx, ny, 1);
            updatePoint(nx, ny, 2);
          }
        }
      }
    }

    return {
      init() {
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          if (board[idx(x, y)] === EMPTY) { updatePoint(x, y, 1); updatePoint(x, y, 2); }
        }
      },
      move(x, y, role) {
        board[idx(x, y)] = role;
        refresh(x, y);
      },
      undo(x, y) {
        board[idx(x, y)] = EMPTY;
        refresh(x, y);
      },
      evaluate(role) {
        const rIdx = role - 1, oIdx = 1 - rIdx;
        let s = 0;
        for (let i = 0; i < NN; i++) s += scores[rIdx][i] - scores[oIdx][i];
        return s;
      },
      shapeAt(x, y, d, role) { return shapeCache[role - 1][idx(x, y) * 4 + d]; },
    };
  }

  // ---------- 分级移动生成 (gobang eval.js getPoints/getMoves + gobang_AI order/has_neightnor) ----------
  function getValuableMoves(evaluator, board, role, depth, onlyThree, onlyFour, lastMove) {
    const N = SIZE;
    const sets = {
      five: [], blockFive: [], four: [], fourFour: [], fourThree: [],
      threeThree: [], blockFour: [], three: [], twoTwo: [], blockThree: [], two: [],
    };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (board[idx(x, y)] !== EMPTY) continue;
        // gobang_AI has_neightnor: 无邻居的点不评估(搜索聚焦, 深度更深)
        if (!hasNeighbor(board, x, y)) continue;
        for (const r of [role, other(role)]) {
          let fourCnt = 0, blockFourCnt = 0, threeCnt = 0, twoCnt = 0;
          let best = SH.NONE;
          for (let d = 0; d < 4; d++) {
            const sh = evaluator.shapeAt(x, y, d, r);
            if (sh > best) best = sh;
            if (sh === SH.FOUR) fourCnt++;
            else if (sh === SH.BLOCK_FOUR) blockFourCnt++;
            else if (sh === SH.THREE) threeCnt++;
            else if (sh === SH.TWO) twoCnt++;
          }
          let cat;
          if (best === SH.FIVE || best === SH.BLOCK_FIVE) cat = best === SH.FIVE ? 'five' : 'blockFive';
          else if (fourCnt >= 2 || (fourCnt && blockFourCnt)) cat = 'fourFour';
          else if (blockFourCnt >= 2) cat = 'fourFour';
          else if (blockFourCnt && threeCnt) cat = 'fourThree';
          else if (threeCnt >= 2) cat = 'threeThree';
          else if (fourCnt) cat = 'four';
          else if (blockFourCnt) cat = 'blockFour';
          else if (threeCnt) cat = 'three';
          else if (twoCnt >= 2) cat = 'twoTwo';
          else if (best === SH.BLOCK_THREE) cat = 'blockThree';
          else if (best === SH.TWO) cat = 'two';
          else continue;
          sets[cat].push([x, y]);
        }
      }
    }

    const dedupe = (arr) => {
      const seen = new Set(), out = [];
      for (const [x, y] of arr) {
        const k = y * SIZE + x;
        if (!seen.has(k)) { seen.add(k); out.push([x, y]); }
      }
      return out;
    };
    // gobang_AI order: 离最后落子近的点排前面(Alpha-Beta 剪枝效率关键)。
    // v7 修正: 当最后落子是远离战场的孤立子(如开局远角), 以"离最近的
    // 己方/对方棋子"为基准排序 —— 聚焦在真正的战场, 而非对手的闲子。
    const orderNear = (arr, n) => {
      const deduped = dedupe(arr);
      if (!lastMove) return deduped.slice(0, n);
      deduped.sort((a, b) => {
        const da = distToNearestStone(a, board);
        const db = distToNearestStone(b, board);
        return da - db;
      });
      return deduped.slice(0, n);
    };

    if (sets.five.length || sets.blockFive.length) return orderNear([...sets.five, ...sets.blockFive], 8);
    if (onlyFour || sets.four.length) return orderNear([...sets.four, ...sets.blockFour], 12);
    if (sets.fourFour.length) return orderNear([...sets.fourFour, ...sets.blockFour], 12);
    if (sets.fourThree.length) return orderNear([...sets.fourThree, ...sets.blockFour, ...sets.three], 14);
    if (sets.threeThree.length) return orderNear([...sets.threeThree, ...sets.blockFour, ...sets.three], 14);
    if (onlyThree) return orderNear([...sets.blockFour, ...sets.three], 14);
    return orderNear([...sets.blockFour, ...sets.three, ...sets.blockThree, ...sets.twoTwo, ...sets.two], 16);
  }

  function hasNeighbor(board, x, y) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (inB(nx, ny) && board[idx(nx, ny)] !== EMPTY) return true;
      }
    }
    return false;
  }

  // 点到最近棋子的切比雪夫距离
  function distToNearestStone(pt, board) {
    let best = 99;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] === EMPTY) continue;
        const d = Math.max(Math.abs(pt[0] - x), Math.abs(pt[1] - y));
        if (d < best) best = d;
      }
    }
    return best;
  }

  // ---------- 胜负判定 (落子后增量检查) ----------
  function winsAfter(board, x, y, role) {
    for (const [dx, dy] of DIRS) {
      let n = 1;
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i, ny = y + dy * i;
        if (!inB(nx, ny) || board[idx(nx, ny)] !== role) break;
        n++;
      }
      for (let i = 1; i < 5; i++) {
        const nx = x - dx * i, ny = y - dy * i;
        if (!inB(nx, ny) || board[idx(nx, ny)] !== role) break;
        n++;
      }
      if (n >= 5) return true;
    }
    return false;
  }

  // ---------- MiniMax + Alpha-Beta + 迭代加深 (gobang minmax.js) ----------
  const MAX = 1000000000;
  const CACHE_MAX = 8000;

  // onlyThree: VCT 变体(只搜活三+/冲四); onlyFour: VCF 变体(只搜四/五)
  function makeMinmax(onlyThree = false, onlyFour = false) {
    return function helper(evaluator, board, role, depth, cDepth, path, alpha, beta, budget, cache, lastMove) {
      if (++budget.nodes > budget.maxNodes) throw BUDGET;
      if (budget.t0 && performance.now() - budget.t0 > budget.maxMs) throw BUDGET;

      if (cDepth >= depth) {
        return [evaluator.evaluate(role), null, path];
      }

      const hash = boardHash(board);
      const key = (hash + role * 2654435761 + (depth - cDepth) * 4101842887) >>> 0;
      const prev = cache.get(key);
      if (prev && (Math.abs(prev.value) >= FIVE || prev.depth >= depth - cDepth)) {
        return [prev.value, prev.move, [...path, ...prev.path]];
      }

      // gobang_AI order: 离最后落子近的点优先搜索(Alpha-Beta 剪枝效率关键)
      const points = getValuableMoves(evaluator, board, role, cDepth, onlyThree, onlyFour, lastMove);
      if (!points.length) return [evaluator.evaluate(role), null, path];

      let value = -MAX;
      let move = null;
      let bestPath = path;
      let bestDepth = 0;

      for (let d = cDepth + 1; d <= depth; d += 1) {
        if (d % 2 !== 0) continue; // 迭代加深只搜偶数层(己方能赢的解)
        let breakAll = false;
        for (const [x, y] of points) {
          evaluator.move(x, y, role);
          const newPath = [...path, [x, y]];
          let [cv, , cp] = helper(evaluator, board, other(role), d, cDepth + 1, newPath, -beta, -alpha, budget, cache, [x, y]);
          cv = -cv;
          evaluator.undo(x, y);

          if (cv >= FIVE || d === depth) {
            // 必输的棋也挣扎: 选最长路径
            if (cv > value || (cv <= -FIVE && value <= -FIVE && cp.length > bestDepth)) {
              value = cv;
              move = [x, y];
              bestPath = cp;
              bestDepth = cp.length;
            }
          }
          alpha = Math.max(alpha, value);
          if (alpha >= FIVE) { breakAll = true; break; } // 自己赢了就结束
          if (alpha >= beta) break;
        }
        if (breakAll) break;
      }

      if (cache.size < CACHE_MAX && (!prev || prev.depth < depth - cDepth)) {
        cache.set(key, {
          depth: depth - cDepth,
          value,
          move,
          path: bestPath.slice(cDepth),
        });
      }
      return [value, move, bestPath];
    };
  }

  const _minmax = makeMinmax();
  const vct = makeMinmax(true);
  const vcf = makeMinmax(false, true);

  // 主搜索: VCT 找杀 → 常规 minmax → 防守校验(对方杀棋路径是否变长)
  function minmaxSearch(evaluator, board, role, depth, budget, lastMove) {
    const cache = new Map();
    const vctDepth = depth + 8;

    let [value, move, bestPath] = vct(evaluator, board, role, vctDepth, 0, [], -MAX, MAX, budget, cache, lastMove);
    if (value >= FIVE && move) return { move, value, path: bestPath };

    [value, move, bestPath] = _minmax(evaluator, board, role, depth, 0, [], -MAX, MAX, budget, cache, lastMove);
    if (!move) return null;

    // 防守校验: 假设自己走了 move, 对方还有杀棋吗? 路径变长则有效
    evaluator.move(move[0], move[1], role);
    let [value2, move2, path2] = vct(evaluator, board, other(role), vctDepth, 0, [], -MAX, MAX, budget, cache, move);
    evaluator.undo(move[0], move[1]);
    if (value < FIVE && value2 >= FIVE && move2 && path2.length > bestPath.length) {
      let [value3, , path3] = vct(evaluator, board, other(role), vctDepth, 0, [], -MAX, MAX, budget, cache, move);
      if (path2.length <= path3.length) {
        return { move: move2, value, path: path2 }; // 改堵对方杀棋起点
      }
    }
    return { move, value, path: bestPath };
  }

  // ---------- 启发式保底 (v5 做棋/防守) ----------
  function scanLine(board, x, y, dx, dy, color) {
    let n1 = 0;
    for (let p = 1; p < 5; p++) {
      const nx = x - dx * p, ny = y - dy * p;
      if (!inB(nx, ny)) break;
      if (board[idx(nx, ny)] === color) n1++; else break;
    }
    let n2 = 0;
    for (let p = 1; p < 5; p++) {
      const nx = x + dx * p, ny = y + dy * p;
      if (!inB(nx, ny)) break;
      if (board[idx(nx, ny)] === color) n2++; else break;
    }
    const n = n1 + 1 + n2;
    const e1x = x - dx * (n1 + 1), e1y = y - dy * (n1 + 1);
    const e2x = x + dx * (n2 + 1), e2y = y + dy * (n2 + 1);
    let open = 0;
    if (inB(e1x, e1y) && board[idx(e1x, e1y)] === EMPTY) open++;
    if (inB(e2x, e2y) && board[idx(e2x, e2y)] === EMPTY) open++;
    let jump = 0;
    if (open > 0) {
      if (inB(e1x - dx, e1y - dy) && board[idx(e1x - dx, e1y - dy)] === color) jump++;
      if (inB(e2x + dx, e2y + dy) && board[idx(e2x + dx, e2y + dy)] === color) jump++;
    }
    return { n, open, jump };
  }

  function dirThreat(board, x, y, dx, dy, color) {
    const { n, open, jump } = scanLine(board, x, y, dx, dy, color);
    if (n >= 5) return 5;
    if (n === 4 && open >= 1) return 4;
    if (n === 3 && open === 2) return 3;
    if (n === 3 && open === 1 && jump >= 1) return 3;
    if (open === 2 && jump >= 1 && n === 2) return 3;
    if (n === 2 && open === 2) return 2;
    return 0;
  }

  function nearCells(board) {
    const set = new Set();
    let any = false;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] === EMPTY) continue;
        any = true;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (inB(nx, ny) && board[idx(nx, ny)] === EMPTY) set.add(ny * SIZE + nx);
          }
        }
      }
    }
    return any ? [...set].map((i) => [i % SIZE, Math.floor(i / SIZE)]) : [[7, 7]];
  }

  function winPoints(board, color) {
    const out = [];
    for (const [x, y] of nearCells(board)) {
      for (const [dx, dy] of DIRS) {
        if (dirThreat(board, x, y, dx, dy, color) >= 5) { out.push({ x, y }); break; }
      }
    }
    return out;
  }

  // 对手"落子即成活四/冲四"的点(必要防守的候选)
  function oppOpenFourPoints(board, opp) {
    const pts = new Set();
    for (const [x, y] of nearCells(board)) {
      for (const [dx, dy] of DIRS) {
        const s = scanLine(board, x, y, dx, dy, opp);
        if (s.n === 4 && s.open === 2) { pts.add(y * SIZE + x); break; }
      }
    }
    return [...pts].map((i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }));
  }

  // 对手"落子即形成双威胁"(双活三/活三+冲四)的点 —— 必争点
  function oppDoubleThreatPoints(board, opp) {
    const pts = [];
    for (const [x, y] of nearCells(board)) {
      let count = 0, max = 0;
      for (const [dx, dy] of DIRS) {
        const l = dirThreat(board, x, y, dx, dy, opp);
        if (l > max) max = l;
        if (l >= 3) count++;
      }
      if (count >= 2 && max >= 3) pts.push({ x, y });
    }
    return pts;
  }

  // 对手"落子即成跳四/冲四"的点(跳三缺口) —— 次紧急
  function oppRushFourPoints(board, opp) {
    const pts = new Set();
    for (const [x, y] of nearCells(board)) {
      for (const [dx, dy] of DIRS) {
        const s = scanLine(board, x, y, dx, dy, opp);
        if (s.n === 4 && s.open >= 1) { pts.add(y * SIZE + x); break; }
        if (s.n === 3 && s.jump >= 1 && s.open >= 1) { pts.add(y * SIZE + x); break; }
      }
    }
    return [...pts].map((i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }));
  }

  // 对手同线聚子(连续 3 子) → 堵端点防成杀
  function oppLineBlocks(board, opp) {
    const blocks = new Set();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== opp) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && board[idx(px, py)] === opp) continue;
          let n = 0, cx = x, cy = y;
          while (inB(cx, cy) && board[idx(cx, cy)] === opp) { n++; cx += dx; cy += dy; }
          if (n < 3) continue;
          const o1 = inB(x - dx, y - dy) && board[idx(x - dx, y - dy)] === EMPTY;
          const o2 = inB(cx, cy) && board[idx(cx, cy)] === EMPTY;
          if (o1) blocks.add((y - dy) * SIZE + (x - dx));
          if (o2) blocks.add(cy * SIZE + cx);
        }
      }
    }
    return [...blocks].map((i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }));
  }

  function patternCounts(board, color) {
    const c = { five: 0, open4: 0, rush4: 0, live3: 0, jump3: 0, sleep3: 0, live2: 0, double3: 0 };
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && board[idx(px, py)] === color) continue;
          let n = 0, cx = x, cy = y;
          while (inB(cx, cy) && board[idx(cx, cy)] === color) { n++; cx += dx; cy += dy; }
          const o1 = inB(x - dx, y - dy) && board[idx(x - dx, y - dy)] === EMPTY;
          const o2 = inB(cx, cy) && board[idx(cx, cy)] === EMPTY;
          const open = (o1 ? 1 : 0) + (o2 ? 1 : 0);
          const jump1 = o1 && inB(x - 2 * dx, y - 2 * dy) && board[idx(x - 2 * dx, y - 2 * dy)] === color;
          const jump2 = o2 && inB(cx + dx, cy + dy) && board[idx(cx + dx, cy + dy)] === color;
          if (n >= 5) c.five++;
          else if (n === 4) { if (open === 2) c.open4++; else if (open === 1) c.rush4++; }
          else if (n === 3) { if (open === 2) c.live3++; else if (open === 1) c.sleep3++; }
          else if (n === 2) {
            if (open === 2) c.live2++;
            if (open >= 1 && (jump1 || jump2)) c.jump3++;
          }
        }
      }
    }
    if (c.live3 >= 2) c.double3 = 1;
    return c;
  }

  const PW = {
    five: 1e9, open4: 5e8, rush4: 1e8,
    double3: 8e6,
    live3: 3e6, jump3: 3e5, sleep3: 3e4,
    live2: 8e3,
  };
  // 评估: 己方模式分 - 对方模式分 × 攻防系数。
  // 借鉴 gobang_AI: 对手分只按 0.1 折算 —— 五子棋 AI 必须进攻压倒防守,
  // 防守偏差过大(如 1.08)会让引擎只会堵、不会攻("太蠢"的根因之一)。
  const DEF_RATIO = 0.1;
  function evalBoard(board, color) {
    const mc = patternCounts(board, color);
    const mo = patternCounts(board, other(color));
    let s = 0;
    for (const k in PW) s += PW[k] * (mc[k] - mo[k] * DEF_RATIO);
    return s;
  }

  // v7 gobang_AI 交叉加成: 落子后若形成 >=2 个活三级方向(双活三/活三+冲四),
  // 交叉威胁是"对手堵不完"的杀棋之源, 分数暴增。
  // 这是评估函数"一子双威胁"的关键 —— 做棋点评分暴涨, 引擎会主动找交叉。
  function crossBonus(board, x, y, color) {
    let threeCnt = 0, fourCnt = 0;
    for (const [dx, dy] of DIRS) {
      const l = dirThreat(board, x, y, dx, dy, color);
      if (l >= 4) fourCnt++;
      else if (l >= 3) threeCnt++;
    }
    if (fourCnt >= 1 && threeCnt >= 1) return PW.live3;      // 冲四+活三
    if (threeCnt >= 2) return PW.live3;                       // 双活三
    return 0;
  }

  function connectivity(board, color) {
    let total = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== color) continue;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (inB(nx, ny) && board[idx(nx, ny)] === color) n++;
          }
        }
        total += n;
      }
    }
    return total;
  }

  function evalBoardConn(board, color) {
    const mine = evalBoard(board, color);
    const conn = connectivity(board, color) - connectivity(board, other(color));
    return mine + conn * 5e3;
  }

  function liveThreeBlocks(board, color) {
    const blocks = new Set();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && board[idx(px, py)] === color) continue;
          let n = 0, cx = x, cy = y;
          while (inB(cx, cy) && board[idx(cx, cy)] === color) { n++; cx += dx; cy += dy; }
          if (n !== 3) continue;
          const o1 = inB(x - dx, y - dy) && board[idx(x - dx, y - dy)] === EMPTY;
          const o2 = inB(cx, cy) && board[idx(cx, cy)] === EMPTY;
          if (o1 && o2) {
            blocks.add((y - dy) * SIZE + (x - dx));
            blocks.add(cy * SIZE + cx);
          }
        }
      }
    }
    return [...blocks].map((i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }));
  }

  function heuristicBest(board, color) {
    const opp = other(color);
    const cands = nearCells(board);

    let best = null, bestScore = -Infinity;
    for (const [x, y] of cands) {
      const b2 = board.slice();
      b2[idx(x, y)] = color;
      let s = evalBoardConn(b2, color);

      let conn = 0, d2 = 0;
      for (const [dx, dy] of DIRS) {
        const l = dirThreat(b2, x, y, dx, dy, color);
        if (l >= 2) { conn++; if (l === 2) d2++; }
      }
      if (conn >= 2) {
        s += 6e5 * Math.min(conn, 3);
      } else if (d2 >= 1) {
        s += 1.5e5;
      }
      // v7 交叉加成: 一子形成双活三/活三+冲四 → 对手堵不完, 杀棋之源
      s += crossBonus(b2, x, y, color);
      if (liveThreeBlocks(b2, color).length) s += 1e6; // 先手权
      if (winPoints(b2, opp).length) s -= 1e10;

      s += (7 - Math.max(Math.abs(x - 7), Math.abs(y - 7))) * 20;

      if (s > bestScore) { bestScore = s; best = { x, y }; }
    }
    return best || { x: 7, y: 7 };
  }

  // ---------- 入口 ----------
  /**
   * 计算最佳落点
   * @param {number[]} board 扁平 15x15 棋盘
   * @param {number} color BLACK=1 | WHITE=2
   * @returns {{x:number, y:number}}
   */
  function computeBest(board, color) {
    const opp = other(color);

    // 1. 直接成五
    const wins = winPoints(board, color);
    if (wins.length) return wins[0];

    // 2. 对手下一手成五 → 必堵(选堵点中对自己最好的)
    const oppWins = winPoints(board, opp);
    if (oppWins.length) {
      let best = oppWins[0], bestScore = -Infinity;
      for (const b of oppWins) {
        const b2 = board.slice();
        b2[idx(b.x, b.y)] = color;
        const s = evalBoardConn(b2, color);
        if (s > bestScore) { bestScore = s; best = b; }
      }
      return { x: best.x, y: best.y };
    }

    // 2b. 硬性防守: 对手落子即成活四/双威胁的点 → 必堵或抢占
    // (搜索会算到这些威胁, 但硬性规则更快更稳, 且搜索预算有限)
    // v7: 跳三缺口(非活四)不再硬性必堵 —— 交给搜索评估。
    // gobang_AI 攻防系数 0.1: 下棋优先于堵棋, 跳三可晚一步堵。
    const urgent = oppOpenFourPoints(board, opp);
    const double = oppDoubleThreatPoints(board, opp);
    const line = oppLineBlocks(board, opp);
    if (urgent.length || double.length || line.length) {
      const cands = [...urgent, ...double, ...line];
      // 紧迫度: 活四(对手下一手必胜) > 双威胁 > 聚子
      const urgency = new Map();
      for (const p of urgent) urgency.set(p.y * SIZE + p.x, 3);
      for (const p of double) {
        const k = p.y * SIZE + p.x;
        if (!urgency.has(k) || urgency.get(k) < 2) urgency.set(k, 2);
      }
      for (const p of line) {
        const k = p.y * SIZE + p.x;
        if (!urgency.has(k)) urgency.set(k, 0);
      }
      let best = cands[0], bestScore = -Infinity;
      for (const b of cands) {
        const b2 = board.slice();
        b2[idx(b.x, b.y)] = color;
        let s = evalBoardConn(b2, color);
        // 必堵活四的点: 大额加权 —— 对手下一手必胜, 优先于一切
        const u = urgency.get(b.y * SIZE + b.x) || 0;
        s += u * 8e6;
        // v6 反击: 防守点若同时形成自己的活三/双活二(先手), 加权
        // 高手棋理"攻守兼备": 堵对手的同时自己发展, 不被牵着走
        if (liveThreeBlocks(b2, color).length) s += 3e6;
        else {
          let conn = 0;
          for (const [dx, dy] of DIRS) {
            if (dirThreat(b2, b.x, b.y, dx, dy, color) >= 2) conn++;
          }
          if (conn >= 2) s += 8e5;
        }
        if (s > bestScore) { bestScore = s; best = b; }
      }
      return { x: best.x, y: best.y };
    }

    // 3. MiniMax + Alpha-Beta + VCT/VCF 主搜索
    // gobang 默认 depth 4 + VCT(depth+8); 这里 depth 4, VCT 深 12。
    // 预算: 350ms —— 深度够到"先手进攻"的收益(浅搜索天然偏保守防守)。
    const searchBoard = board.slice();
    const evaluator = createEvaluator(searchBoard);
    evaluator.init();
    // 找最后落子(用于搜索聚焦排序)
    let lastMove = null;
    for (let y = SIZE - 1; y >= 0 && !lastMove; y--) {
      for (let x = SIZE - 1; x >= 0; x--) {
        if (board[idx(x, y)] !== EMPTY) { lastMove = [x, y]; break; }
      }
    }
    try {
      const budget = { nodes: 0, maxNodes: 150000, t0: performance.now(), maxMs: 350, visited: null };
      const res = minmaxSearch(evaluator, searchBoard, color, 4, budget, lastMove);
      if (res && res.move) return { x: res.move[0], y: res.move[1] };
    } catch (e) {
      if (e !== BUDGET) throw e;
    }

    // 4. 启发式保底(做棋/防守, 预算超时或搜索无结果)
    return heuristicBest(board, color);
  }

  return { computeBest };
});
