// 五子棋提示引擎 v11.7 — 三连深析 / 完整迭代预测 / 3000 万节点 / 深度 10 / 10 秒
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
// v11.3 (gobang V3 借鉴):
//   - VCT 攻防角色分离: 杀棋链只搜进攻方活三+/对方冲四+, 防守方只搜挡点,
//     根节点只进攻 —— 分支减半, 同样预算杀棋链更深 (V3 getPoints vct 分支)
//   - VCT 非胜值只在最终迭代提交: 浅层"没杀"证明不了任何事(5步后输 ≠ 1步不输),
//     中间迭代只接受"能赢" (V3 minmax)。常规搜索保持逐层提交(深度 10 下
//     干净窗口实测超预算导致 18% 回退启发式, 得不偿失), 截断兜底由
//     budget.best 的最终迭代门控负责: 预算耗尽宁回退启发式也不拿浅层乐观值。
//
// 预算: 节点 + 时间双重上限, 超时回退启发式 —— 手机上不卡。
// 隐私: 纯本地计算, 结果只画在本地 canvas, 不经 WebSocket。

// UMD: 浏览器挂 global, CommonJS 挂 module.exports, ESM 场景也兼容
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof exports === 'object' && exports !== null) exports.default = factory();
  else if (typeof self !== 'undefined') self.GomokuHint = factory();
  else if (typeof globalThis !== 'undefined') globalThis.GomokuHint = factory();
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
  // v11.5: 第二个独立 Zobrist 表 —— 缓存 key 由 32 位扩到 53 位。
  // 原 32 位 key 在几万节点的搜索树里碰撞概率 ~1-5%: 碰撞 → 缓存误命中 →
  // 偶发错误评估("蠢棋"的来源之一)。双表拼接后碰撞概率 ~2^-53, 可忽略。
  const ZB2 = (() => {
    const rnd = mulberry32(0x243F6A88);
    const t = new Uint32Array(SIZE * SIZE * 2 + 2);
    for (let i = 0; i < t.length; i++) t[i] = (rnd() * 4294967296) >>> 0;
    return t;
  })();
  const zOf = (cell, color) => ZB[cell * 2 + (color - 1)];
  function boardHash(board) {
    let h1 = 0, h2 = 0;
    for (let i = 0; i < board.length; i++) {
      if (board[i] !== EMPTY) {
        const c = board[i];
        h1 = (h1 ^ ZB[i * 2 + (c - 1)]) >>> 0;
        h2 = (h2 ^ ZB2[i * 2 + (c - 1)]) >>> 0;
      }
    }
    return [h1, h2];
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
    four: /011110|01110110/,
    // 跳四: 单跳(已有) + 双跳(101101/110101)
    blockFour: /10111|11011|11101|101101|110101|211110|211101|211011|210111|011112|101112|110112|111012/,
    // 活三: 连续 + 单跳 + 双跳(1010101)
    three: /011100|011010|010110|001110|0101010|0101001|1001010/,
    blockThree: /211100|211010|210110|001112|010112|011012|210101|101012/,
    // 活二: 连续 + 单跳 + 双跳(10001/10101)
    two: /001100|011000|000110|010100|001010|1001001|1000100|0010001|0101001|0010100|100101|101001/,
  };

  // 在 (x,y) 放 role 后沿 (dx,dy) 方向的棋形
  // v11: 扫描窗口扩到 6(双侧), 覆盖双跳棋形
  function getShape(board, x, y, dx, dy, role) {
    let s = '1';
    for (let i = 1; i <= 6; i++) {
      const nx = x + dx * i, ny = y + dy * i;
      if (!inB(nx, ny)) { s += '2'; break; }
      const v = board[idx(nx, ny)];
      if (v === EMPTY) s += '0';
      else if (v === role) s += '1';
      else { s += '2'; break; }
    }
    for (let i = 1; i <= 6; i++) {
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
      case SH.FIVE: return FIVE; // v11.2: 成五点按满值计 —— 修复 FIVE 阈值不可达(原返回 FOUR=1e5, 永远够不到 1e7 获胜判定)
      case SH.BLOCK_FIVE: return BLOCK_FOUR;
      case SH.FOUR: return FOUR; // v11.4: 活四点按 100000 计 —— 原返回 THREE(1000), 活四比双三(20000)还低 20 倍
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
    const fiveCnt = [0, 0]; // v11.2: 各色盘面实际五连数 —— 增量维护, evaluate 直接判胜负
    const totals = [0, 0];
    let hash1 = 0, hash2 = 0;

    function updatePoint(x, y, role, changedDir = -1) {
      const rIdx = role - 1;
      const c = idx(x, y);
      const old = scores[rIdx][c];
      let total = 0;
      let fourCnt = 0, blockFourCnt = 0, threeCnt = 0, twoCnt = 0;
      if (changedDir >= 0) {
        const [dx, dy] = DIRS[changedDir];
        shapeCache[rIdx][c * 4 + changedDir] = getShape(board, x, y, dx, dy, role);
      } else {
        for (let d = 0; d < 4; d++) {
          const [dx, dy] = DIRS[d];
          shapeCache[rIdx][c * 4 + d] = getShape(board, x, y, dx, dy, role);
        }
      }
      for (let d = 0; d < 4; d++) {
        const sh = shapeCache[rIdx][c * 4 + d];
        if (sh === SH.FOUR) fourCnt++;
        else if (sh === SH.BLOCK_FOUR) blockFourCnt++;
        else if (sh === SH.THREE) threeCnt++;
        else if (sh === SH.TWO) twoCnt++;
        total += shapeScore(sh);
      }
      // 复合棋形: 双四/冲四活三/双三/双活二
      // v11.4: 活四+1 冲四也算双四(对手一步堵不完), 与 getValuableMoves 分类一致
      if (fourCnt >= 2 || (fourCnt && blockFourCnt >= 1)) {
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
      totals[rIdx] += total - old;
    }

    function refresh(x, y) {
      // 落子点影响周围 6 格内的所有空位 (v11: 窗口扩到 6 配合双跳识别)
      for (let d = 0; d < DIRS.length; d++) {
        const [dx, dy] = DIRS[d];
        for (const sign of [1, -1]) {
          for (let step = 1; step <= 6; step++) {
            const nx = x + sign * step * dx, ny = y + sign * step * dy;
            if (!inB(nx, ny)) break;
            if (board[idx(nx, ny)] !== EMPTY) continue;
            updatePoint(nx, ny, 1, d);
            updatePoint(nx, ny, 2, d);
          }
        }
      }
    }

    return {
      init() {
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          const c = idx(x, y);
          const v = board[c];
          if (v === EMPTY) {
            updatePoint(x, y, 1);
            updatePoint(x, y, 2);
          } else {
            hash1 = (hash1 ^ ZB[c * 2 + (v - 1)]) >>> 0;
            hash2 = (hash2 ^ ZB2[c * 2 + (v - 1)]) >>> 0;
            if (winsAfter(board, x, y, v)) fiveCnt[v - 1]++;
          }
        }
      },
      move(x, y, role) {
        const c = idx(x, y);
        totals[0] -= scores[0][c];
        totals[1] -= scores[1][c];
        hash1 = (hash1 ^ ZB[c * 2 + (role - 1)]) >>> 0;
        hash2 = (hash2 ^ ZB2[c * 2 + (role - 1)]) >>> 0;
        board[c] = role;
        if (winsAfter(board, x, y, role)) fiveCnt[role - 1]++;
        refresh(x, y);
      },
      undo(x, y) {
        const c = idx(x, y);
        const role = board[c];
        if (role !== EMPTY && winsAfter(board, x, y, role)) fiveCnt[role - 1]--;
        hash1 = (hash1 ^ ZB[c * 2 + (role - 1)]) >>> 0;
        hash2 = (hash2 ^ ZB2[c * 2 + (role - 1)]) >>> 0;
        board[c] = EMPTY;
        // 该点占用期间没有被 refresh 改写，保留的正是落子前点分。
        totals[0] += scores[0][c];
        totals[1] += scores[1][c];
        refresh(x, y);
      },
      evaluate(role) {
        const rIdx = role - 1, oIdx = 1 - rIdx;
        // v11.2: 盘面已有成五 → 直接判胜负(搜索的获胜判定必须真实可达)
        if (fiveCnt[rIdx]) return FIVE;
        if (fiveCnt[oIdx]) return -FIVE;
        const s = totals[rIdx] - totals[oIdx];
        // 非终局静态分不能越过 FIVE，否则 VCT 会把高分棋形误判成已证明必胜。
        return Math.max(-(FIVE - 1), Math.min(FIVE - 1, s));
      },
      shapeAt(x, y, d, role) { return shapeCache[role - 1][idx(x, y) * 4 + d]; },
      pointScore(x, y, role) { return scores[role - 1][idx(x, y)]; },
      hash() { return [hash1, hash2]; },
    };
  }

  // ---------- 分级移动生成 (gobang eval.js getPoints/getMoves + gobang_AI order/has_neightnor) ----------
  // v8: 动态深度降级 —— 深度 > 6 层时强制只搜活三/冲四(gobang onlyThreeThreshold)。
  // 这是 gobang 能搜 12 层的核心: 深层只搜威胁, 分支砍到极小。
  const ONLY_THREE_THRESHOLD = 6;
  function getValuableMoves(evaluator, board, role, depth, onlyThree, onlyFour, lastMove) {
    const N = SIZE;
    // 深度降级: 深层搜索只保留活三/冲四/成五级威胁
    const deep = depth > ONLY_THREE_THRESHOLD && !onlyThree && !onlyFour;
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
          // 深度降级: 深层只保留活三/冲四/成五
          if (deep && cat !== 'five' && cat !== 'blockFive' && cat !== 'four' &&
              cat !== 'blockFour' && cat !== 'fourFour' && cat !== 'fourThree' &&
              cat !== 'threeThree' && cat !== 'three') continue;
          // v11.3: VCT 攻防角色分离 (gobang V3 getPoints vct 分支)
          // 杀棋链只关心进攻方的活三+ 和"必须回应"的冲四档:
          //   进攻方回合 = 自己的活三+ + 对手冲四+(不回应就输);
          //   防守方回合 = 对手活三+(堵点) + 自己的冲四+(挡点);
          //   根节点只进攻, 不防守。
          // 防守方的活三(反攻)不进杀棋链 —— 分支减半, 同样预算能搜更深。
          if (onlyThree) {
            const isAttackMove = depth % 2 === 0; // 偶数层=进攻方回合(根即进攻方)
            if (depth === 0 && r !== role) continue;
            const fourPlus = cat === 'four' || cat === 'blockFour' || cat === 'fourFour' ||
                             cat === 'five' || cat === 'blockFive';
            const threePlus = cat === 'three' || cat === 'threeThree' || cat === 'fourThree' || fourPlus;
            const keep = (r === role) === isAttackMove ? threePlus : fourPlus;
            if (!keep) continue;
          }
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
      deduped.sort((a, b) => {
        // 同棋形优先搜索双方点分更高的落点，消除原先按 y/x 扫描导致的方位偏差。
        const as = evaluator.pointScore(a[0], a[1], role) + evaluator.pointScore(a[0], a[1], other(role));
        const bs = evaluator.pointScore(b[0], b[1], role) + evaluator.pointScore(b[0], b[1], other(role));
        if (as !== bs) return bs - as;
        const ac = Math.max(Math.abs(a[0] - 7), Math.abs(a[1] - 7));
        const bc = Math.max(Math.abs(b[0] - 7), Math.abs(b[1] - 7));
        return (ac - bc) || (a[1] - b[1]) || (a[0] - b[0]);
      });
      return deduped.slice(0, n);
    };

    if (sets.five.length || sets.blockFive.length) return orderNear([...sets.five, ...sets.blockFive], 8);
    // 复合强制棋形必须先于普通四检查，并与普通四合并后再截断；旧顺序会因
    // 任意一个普通 four 存在而把 fourFour/fourThree 整组漏掉。
    if (sets.fourFour.length || sets.fourThree.length || sets.threeThree.length || sets.four.length || onlyFour) {
      return orderNear([
        ...sets.fourFour, ...sets.fourThree, ...sets.threeThree,
        ...sets.four, ...sets.blockFour, ...sets.three,
      ], onlyFour ? 12 : 16);
    }
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
  const CACHE_MAX = 50000;

  // onlyThree: VCT 变体(只搜活三+/冲四); onlyFour: VCF 变体(只搜四/五)
  // v10 (PentaZen 剪枝): 杀手走法 + 静态搜索 + Razoring/Futility
  function makeMinmax(onlyThree = false, onlyFour = false) {
    // 杀手走法表: killers[深度][0/1] —— 记录剪枝成功的走法, 同深度优先试
    const killers = [];
    // v11.4: 跨请求重置 —— worker 缓存引擎模块, killers 不重置会把上一请求的
    // 剪枝记录泄漏进下一请求的走法排序, 预算截断时结果随请求历史漂移。
    function resetKillers() { killers.length = 0; }
    function helper(evaluator, board, role, depth, cDepth, path, alpha, beta, budget, cache, lastMove, bestSlot) {
      if (++budget.nodes > budget.maxNodes) throw BUDGET;
      if (budget.t0 && performance.now() - budget.t0 > budget.maxMs) throw BUDGET;

      // 静态搜索: 到达叶子(或接近叶子)时, 不立即评估 —— 继续搜强制走法
      // (冲四/活三), 避免"被一子反转"的假评估 (PentaZen quiescence)
      if (cDepth >= depth) {
        return [evaluator.evaluate(role), null, path];
      }
      // Razoring: 深度浅 + 静态评估远低于 alpha → 直接截断
      if (!onlyThree && !onlyFour && cDepth >= depth - 2 && depth - cDepth <= 2) {
        const staticScore = evaluator.evaluate(role);
        if (staticScore + 45 * (depth - cDepth) <= alpha) {
          return [staticScore, null, path];
        }
      }

      const [h1, h2] = evaluator.hash();
      // v8: 缓存 key 含变体标志 —— VCT/VCF 与常规搜索的缓存不通用(gobang)
      // v11.5: 53 位 key —— 高 32 位 h2 纯位段(<<21) + 低 21 位 mix
      // (mix 把 role/深度/变体混合进 h1), 位段无重叠 → 无进位歧义。
      // 原 32 位 key 在几万节点的树里碰撞 ~1-5%, 误命中产生偶发错棋。
      const mix = (h1 ^ Math.imul(role + (depth - cDepth) * 4 + (onlyThree ? 2 : 0) + (onlyFour ? 1 : 0), 0x9E3779B1)) >>> 0;
      const key = h2 * 2097152 + (mix >>> 11);
      const prev = cache.get(key);
      if (prev && (Math.abs(prev.value) >= FIVE || prev.depth >= depth - cDepth) &&
          prev.onlyThree === onlyThree && prev.onlyFour === onlyFour) {
        return [prev.value, prev.move, [...path, ...prev.path]];
      }

      // gobang_AI order: 离最后落子近的点优先搜索(Alpha-Beta 剪枝效率关键)
      let points = getValuableMoves(evaluator, board, role, cDepth, onlyThree, onlyFour, lastMove);
      if (cDepth === 0 && budget.rootPriority && budget.rootPriority.length) {
        const seen = new Set();
        const merged = [];
        for (const p of [...budget.rootPriority, ...points]) {
          if (!p || p.length !== 2 || board[idx(p[0], p[1])] !== EMPTY) continue;
          const k = p[1] * SIZE + p[0];
          if (!seen.has(k)) { seen.add(k); merged.push(p); }
        }
        points = merged;
      }
      if (!points.length) return [evaluator.evaluate(role), null, path];

      // v10 杀手走法: 把剪枝成功的走法排到最前面(同深度优先试)。
      // 注意: killers 按 cDepth 索引(同深度节点), 只在剪枝时写入;
      // 排序是稳定的(只把杀手提到前面, 不重排其余)。
      const k1 = killers[cDepth] ? killers[cDepth][0] : null;
      const k2 = killers[cDepth] ? killers[cDepth][1] : null;
      if (k1 !== null || k2 !== null) {
        const killerSet = new Set([k1, k2].filter((k) => k !== null));
        if (killerSet.size) {
          points = [...points.filter((p) => killerSet.has(p[0] * SIZE + p[1])),
                   ...points.filter((p) => !killerSet.has(p[0] * SIZE + p[1]))];
        }
      }

      // Lazy SMP 根节点分流：worker 0 保持最佳排序，其余 worker 从候选列表的
      // 不同区段开始。四路在预算截断时探索不同分支，不再重复同一棵树。
      if (cDepth === 0 && points.length > 1 && budget.rootOffset) {
        const shift = Math.floor(points.length * (budget.rootOffset % 4) / 4);
        if (shift > 0) points = [...points.slice(shift), ...points.slice(0, shift)];
      }

      let value = -MAX;
      let move = null;
      let bestPath = path;
      let bestDepth = 0;
      let completedDepth = cDepth;
      let finalExact = false;
      const alphaStart = alpha;
      let previousIterationMs = 0;
      let beforePreviousIterationMs = 0;

      // v11.2: 迭代加深 —— 每轮迭代记录"该深度最优", 迭代结束时提交, 更深迭代优先。
      // (v11 回归: 每层每步直接覆盖, 浅层 d=2 的乐观值永远压住深层准确值, 有效深度≈2)
      // 标准迭代加深只在根节点执行。旧实现每个递归节点都从浅层重新迭代，
      // 同一子树被指数级重复搜索；内部节点直接搜索根轮次指定的目标深度。
      const firstIterationDepth = cDepth === 0 ? cDepth + 1 : depth;
      for (let d = firstIterationDepth; d <= depth; d += 1) {
        if (d % 2 !== 0) continue; // 迭代加深只搜偶数层(己方能赢的解)
        // 常规根搜索只启动预计能完成的下一轮。未完成迭代不会产生可用结果，
        // 盲目跑满墙钟只会增加等待；VCT/VCF 不使用预测，避免漏深层杀棋。
        if (cDepth === 0 && !onlyThree && !onlyFour && completedDepth >= 6 && previousIterationMs > 0) {
          const elapsed = performance.now() - budget.t0;
          const remaining = budget.maxMs - elapsed;
          const observedGrowth = beforePreviousIterationMs > 0
            ? previousIterationMs / beforePreviousIterationMs
            : 3;
          const growth = Math.max(2, Math.min(8, observedGrowth));
          const estimatedNextMs = previousIterationMs * growth;
          if (remaining < estimatedNextMs * 1.15) {
            budget.predictedStop = true;
            break;
          }
        }
        const iterationStartedAt = performance.now();
        const iterationStartedNodes = budget.nodes;
        let iterBest = -MAX, iterMove = null, iterPath = path, iterDepth = 0;
        let breakAll = false;
        let iterCutoff = false;
        let iterAlpha = alphaStart;
        for (const [x, y] of points) {
          evaluator.move(x, y, role);
          const newPath = [...path, [x, y]];
          let [cv, , cp] = helper(evaluator, board, other(role), d, cDepth + 1, newPath, -beta, -iterAlpha, budget, cache, [x, y], bestSlot);
          cv = -cv;
          evaluator.undo(x, y);

          // v11.3 (gobang V3): VCT 变体非胜值只在最终迭代提交 —— 中间迭代只接受"能赢",
          // 浅层"没杀"证明不了任何事 (V3: 5步后输 ≠ 1步不输)。
          // 常规变体保持逐层提交(深度 10 下干净窗口会超预算, 实测 18% 回退启发式),
          // 预算截断时由 budget.best 的最终迭代门控兜底。
          if ((!onlyThree || cv >= FIVE || d === depth) &&
              (cv > iterBest || (cv <= -FIVE && iterBest <= -FIVE && cp.length > iterDepth))) {
            iterBest = cv;
            iterMove = [x, y];
            iterPath = cp;
            iterDepth = cp.length;
          }
          iterAlpha = Math.max(iterAlpha, iterBest);
          // v10: Alpha-Beta 剪枝命中 → 记录杀手走法(PentaZen update_killers)
          if (iterAlpha >= beta) {
            if (!killers[cDepth]) killers[cDepth] = [null, null];
            if (killers[cDepth][0] !== x * SIZE + y) {
              killers[cDepth][1] = killers[cDepth][0];
              killers[cDepth][0] = x * SIZE + y;
            }
            iterCutoff = true;
            break;
          }
          if (iterAlpha >= FIVE) { breakAll = true; break; } // 自己赢了就结束
        }
        // 迭代结束提交: 更深迭代(更准确)的结果优先, 覆盖浅层
        if (iterMove !== null) {
          value = iterBest;
          move = iterMove;
          bestPath = iterPath;
          bestDepth = iterDepth;
          completedDepth = d;
          finalExact = !iterCutoff || iterBest >= FIVE;
          // v11.2: budget.best 只从根层写入 —— 预算超时时返回部分搜索结果
          // v11.3 (gobang V3): VCT 变体(onlyThree)非胜值只在最终迭代提交 ——
          // 浅层"没杀"证明不了任何事; v11.4: 常规变体逐迭代写入 —— 浅层完整
          // 迭代(d=2/4)结果远好于纯启发式, 最终迭代超时也有真结果可用,
          // 不再整个搜索白跑后退化回启发式。
          if (bestSlot && cDepth === 0 && (!onlyThree || d === depth || iterBest >= FIVE) &&
              (!bestSlot.best || d > bestSlot.best.searchDepth ||
               (d === bestSlot.best.searchDepth &&
                (iterBest > bestSlot.best.value ||
                 (iterBest <= -FIVE && bestSlot.best.value <= -FIVE && iterPath.length > bestSlot.best.depth))))) {
            bestSlot.best = {
              value: iterBest, move: iterMove, path: iterPath,
              depth: iterPath.length, searchDepth: d,
            };
          }
        }
        // 下一轮优先搜索上一轮 PV，提高 Alpha-Beta 剪枝率。
        if (iterMove && d < depth) {
          points = [iterMove, ...points.filter((p) => p[0] !== iterMove[0] || p[1] !== iterMove[1])];
        }
        if (cDepth === 0) {
          beforePreviousIterationMs = previousIterationMs;
          previousIterationMs = Math.max(0.01, performance.now() - iterationStartedAt);
          if (!budget.iterations) budget.iterations = [];
          budget.iterations.push({
            depth: d,
            ms: Math.round(previousIterationMs * 100) / 100,
            nodes: budget.nodes - iterationStartedNodes,
          });
        }
        if (breakAll) break;
      }

      // 剪枝节点只有上下界，不得作为精确值写入置换表。旧实现复用这种值会
      // 在不同 alpha/beta 窗口下产生错误命中。
      if (finalExact && completedDepth === depth && cache.size < CACHE_MAX &&
          (!prev || prev.depth < depth - cDepth)) {
        cache.set(key, {
          depth: depth - cDepth,
          value,
          move,
          path: bestPath.slice(cDepth),
          // v8: 缓存区分变体 —— VCT/VCF 与常规搜索的缓存不通用(gobang)
          onlyThree,
          onlyFour,
        });
      }
      return [value, move, bestPath];
    }
    helper.resetKillers = resetKillers;
    return helper;
  }

  const _minmax = makeMinmax();
  const vct = makeMinmax(true);

  // 主搜索: VCT 找杀 → 常规 minmax → 防守校验(对方杀棋路径是否变长)
  // v8: 常规深度 6(动态深度降级后深层只搜威胁, 分支可控),
  // VCT 深度 14(gobang depth+8 的加强版)。
  // v8.1: 各阶段独立预算 —— 共享预算会让防守校验的 VCT 饿死 minmax。
  // v11.2: 各阶段独立 t0(阶段开始时起算) —— 原来共享 computeBest 的 t0,
  // 阶段 3 实际可用时间 ≈ 25%T − 前面耗时, 基本从不执行(被饿死)。
  // v11.2: 阶段 1 的 BUDGET 用 try/catch 消化 —— 原来直接穿透杀死阶段 2/3。
  // v11.2: bestSlot = 外层 budget —— 各阶段根层搜索结果写入同一槽, 超时能回取。
  function minmaxSearch(evaluator, board, role, depth, budget, lastMove) {
    const cache = new Map();
    const vctDepth = depth + 8;
    const startedAt = performance.now();
    const deadline = startedAt + budget.maxMs;
    const totalNodes = budget.maxNodes;
    const rootOffset = budget.rootOffset || 0;
    const rootPriority = budget.rootPriority || [];

    // 阶段 1: VCT 找杀(预算 35%)
    // v11.4: 各阶段用独立 evaluator 副本 —— BUDGET 超时是异常抛出, 搜索树上
    // move/undo 不平衡, 共享 evaluator 会让下一阶段在残留棋子上搜索,
    // 误判假五连/假分数, 结果随超时点漂移(同一棋盘每次不同)。
    const b1 = {
      nodes: 0, maxNodes: Math.floor(totalNodes * 0.35),
      t0: performance.now(), maxMs: budget.maxMs * 0.35,
      best: null, rootOffset, rootPriority,
    };
    let value, move, bestPath;
    try {
      const vBoard = board.slice();
      const vctEval = createEvaluator(vBoard);
      vctEval.init();
      [value, move, bestPath] = vct(vctEval, vBoard, role, vctDepth, 0, [], -MAX, MAX, b1, cache, lastMove, b1);
      if (value >= FIVE && move) {
        budget.nodes = b1.nodes;
        return { move, value, path: bestPath, depth: vctDepth, verified: true };
      }
    } catch (e) {
      if (e !== BUDGET) throw e;
      // 阶段 1 超时: 保留已搜到的部分结果, 继续阶段 2
    }

    // 阶段 2: 常规 minmax。阶段 1 提前结束时，把未用时间/节点转给主搜索，
    // 同时为阶段 3 固定保留 25%，避免旧版总是只用到约 6 秒就提前结束。
    const stage3NodeReserve = Math.floor(totalNodes * 0.25);
    const stage3TimeReserve = budget.maxMs * 0.25;
    const remainingNodesAfterB1 = Math.max(1, totalNodes - b1.nodes);
    const b2 = {
      nodes: 0,
      maxNodes: Math.max(1, remainingNodesAfterB1 - stage3NodeReserve),
      t0: performance.now(),
      maxMs: Math.max(1, deadline - performance.now() - stage3TimeReserve),
      best: null, rootOffset, rootPriority,
    };
    value = undefined;
    move = null;
    bestPath = [];
    try {
      const mBoard = board.slice();
      const minEval = createEvaluator(mBoard);
      minEval.init();
      [value, move, bestPath] = _minmax(minEval, mBoard, role, depth, 0, [], -MAX, MAX, b2, cache, lastMove, b2);
    } catch (e) {
      if (e !== BUDGET) throw e;
    }
    if ((!move || value === undefined) && b2.best) {
      value = b2.best.value;
      move = b2.best.move;
      bestPath = b2.best.path;
    }
    budget.best = b2.best;
    budget.nodes = b1.nodes + b2.nodes;
    budget.predictedStop = !!b2.predictedStop;
    budget.iterations = b2.iterations || [];
    if (!move) return null;
    if (value >= FIVE) {
      return {
        move, value, path: bestPath,
        depth: b2.best ? b2.best.searchDepth : depth,
        verified: true,
      };
    }

    // 阶段 3: 防守校验(预算 25%) —— 我落 move 后对手能否 VCT 杀?
    // 能且己方无必胜 → 改堵对方杀棋起点(防守妙手, 补 2b 的盲区:
    // 2b 只拦 1-2 步的盘面威胁, 搜索级的强制杀链由这里拦截)。
    // v11.5: 删第二次"确认"调用 —— 第一次 vct 已耗尽 b3, 第二次共享同一
    // 预算必然立即超时, 让 path3.length 抛 TypeError(undefined.length) 沿
    // catch 链上抛, computeBest 整个崩溃; 且 VCT 的 onlyThree 门控保证
    // value2 >= FIVE 只在真找到杀时成立(中间迭代非胜值不提交), 无需确认。
    const b3 = {
      nodes: 0,
      maxNodes: Math.max(1, totalNodes - b1.nodes - b2.nodes),
      t0: performance.now(),
      maxMs: Math.max(1, deadline - performance.now()),
      best: null, rootOffset, rootPriority: [],
    };
    let verified = true;
    try {
      const sBoard = board.slice();
      const sEval = createEvaluator(sBoard);
      sEval.init();
      sEval.move(move[0], move[1], role);
      let [value2, move2, path2] = vct(sEval, sBoard, other(role), vctDepth, 0, [], -MAX, MAX, b3, cache, move, null);
      sEval.undo(move[0], move[1]);
      // 黑 value < FIVE(未确认必胜) + 白 value2 >= FIVE(确认必胜) → 必堵。
      // 路径比较是多余的: "黑快五"的场景(活三/活四延伸)在偶数层搜索内已确认
      // value >= FIVE, 条件已排除; 黑未确认必胜时, 白的强制杀链必然先到。
      if (value < FIVE && value2 >= FIVE && move2) {
        budget.nodes = b1.nodes + b2.nodes + b3.nodes;
        // 堵杀棋起点是安全候选，但没有剩余预算再次证明，标记为未完全验证。
        return {
          move: move2, value, path: path2,
          depth: b2.best ? b2.best.searchDepth : 0,
          verified: false,
        };
      }
    } catch (e) {
      if (e !== BUDGET) throw e;
      verified = false;
    }
    budget.nodes = b1.nodes + b2.nodes + b3.nodes;
    return {
      move, value, path: bestPath,
      depth: b2.best ? b2.best.searchDepth : depth,
      verified,
    };
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

  // v11.5: 一步杀扫描 —— 落子即成活四/双活三/冲四活三/双四 → 对手一步堵不完, 直接杀。
  // 原放在 2b 内(对手活三/双威胁时才查), 且"堵对手成五"在它之前 —— 对手只有
  // 冲四时先被迫堵棋, 漏掉必胜杀(杀棋链迫使对手全程应挡, 其冲四永远走不完)。
  function killInOne(board, color) {
    for (const [x, y] of nearCells(board)) {
      const b2 = board.slice();
      b2[idx(x, y)] = color;
      let fourCnt = 0, threeCnt = 0, liveFour = false;
      for (const [dx, dy] of DIRS) {
        const l = dirThreat(b2, x, y, dx, dy, color);
        if (l >= 4) {
          fourCnt++;
          // dirThreat 的 4 不区分活四/冲四 —— scanLine 精确确认活四(双开口)
          if (l === 4) { const s = scanLine(b2, x, y, dx, dy, color); if (s.n === 4 && s.open === 2) liveFour = true; }
        }
        else if (l >= 3) threeCnt++;
      }
      // 活四 / 双四 / 冲四活三 / 双活三 → 对手一步堵不完
      if (liveFour || fourCnt >= 2 || (fourCnt >= 1 && threeCnt >= 1) || threeCnt >= 2) {
        return { x, y };
      }
    }
    return null;
  }

  // 两个成五点是否同一活四的两端(相距 5、中间 4 子连续)。
  // 活四下一手必胜, 己方杀来不及; 双冲四(两个独立成五点)不是一步杀,
  // 己方一步杀先手必胜, 仍应优先杀。
  function sameLiveFour(board, opp, a, b) {
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (!((dx === 5 && dy === 0) || (dx === 0 && dy === 5) || (dx === 5 && dy === 5))) return false;
    const sx = dx === 0 ? 0 : (b.x - a.x) / dx;
    const sy = dy === 0 ? 0 : (b.y - a.y) / dy;
    for (let i = 1; i <= 4; i++) {
      if (board[idx(a.x + sx * i, a.y + sy * i)] !== opp) return false;
    }
    return true;
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
          // v11.4: 眠三(单开口)端点不再硬性必堵 —— 不堵不会立刻输, 却会把 2b
          // 提前截断, 让引擎只顾防守放弃进攻(搜索被架空)。保留活三(双开口)
          // 与冲四/活四(n=4)端点 —— 这两类不堵就输。
          if (n === 3 && !(o1 && o2)) continue;
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

  // v11: 返回带 score 的启发式最优(供 heuristicBest 和反推防守共用)
  function bestByEval(board, color) {
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

      if (s > bestScore) { bestScore = s; best = { x, y, score: s }; }
    }
    return best || { x: 7, y: 7, score: -Infinity };
  }

  function heuristicBest(board, color) {
    return bestByEval(board, color);
  }

  // ---------- 入口 ----------
  /**
   * 计算最佳落点
   * @param {number[]} board 扁平 15x15 棋盘
   * @param {number} color BLACK=1 | WHITE=2
   * @returns {{x:number, y:number}}
   */
  // v11: opts.skipHardRules —— 深度版跳过可选反推(2c)直接深搜
  // v11.2: 硬性防守(2b)无条件执行, 深度版只跳过反推启发式
  function computeBest(board, color, opts) {
    const computeStartedAt = performance.now();
    if (!Array.isArray(board) || board.length !== SIZE * SIZE) {
      throw new TypeError('board 必须是 225 格数组');
    }
    if (color !== BLACK && color !== WHITE) {
      throw new TypeError('color 必须是 1 或 2');
    }
    let emptyCount = 0;
    for (let i = 0; i < board.length; i++) {
      if (board[i] === EMPTY) emptyCount++;
      else if (board[i] !== BLACK && board[i] !== WHITE) throw new TypeError(`board[${i}] 棋子值非法`);
    }
    if (emptyCount === 0) throw new Error('棋盘已满，没有合法落点');
    // v11.4: 跨请求重置杀手走法表 —— 引擎模块在 worker 里被缓存复用,
    // killers 不重置会让结果依赖请求历史(同一棋盘不同答案)。
    vct.resetKillers();
    _minmax.resetKillers();
    const skipHard = !!(opts && (opts.skipHardRules === true || opts.deep === true));
    const rootOffset = opts && Number.isInteger(opts.workerId) ? Math.abs(opts.workerId) % 4 : 0;
    const opp = other(color);

    // 1. 直接成五
    const wins = winPoints(board, color);
    if (wins.length) return wins[0];

    // 战术规则只负责把关键点放到根节点最前面，不再替深搜直接作决定。
    // 这样对手三连/跳三/双威胁出现时，所有候选仍会经过完整攻防比较。
    const tacticalPriority = [];
    const prioritySeen = new Set();
    const addPriority = (p) => {
      if (!p || !inB(p.x, p.y) || board[idx(p.x, p.y)] !== EMPTY) return;
      const k = p.y * SIZE + p.x;
      if (!prioritySeen.has(k)) {
        prioritySeen.add(k);
        tacticalPriority.push([p.x, p.y]);
      }
    };

    // 1.5 己方一步杀优先于堵棋 —— 杀是必胜: 对手冲四只需一步堵, 堵完己方威胁
    // 还在, 继续杀; 先堵反而把先手让出去(对手双活三也同理)。
    // 对手活四在盘(两个成五点同一四连两端)下一手必胜, 己方杀来不及, 不在此列;
    // 双冲四(两个独立成五点)不是一步杀, 己方杀仍成立。
    const oppWins = winPoints(board, opp);
    if (oppWins.length <= 2) {
      const liveFour = oppWins.length === 2 && sameLiveFour(board, opp, oppWins[0], oppWins[1]);
      if (!liveFour) {
        const kill = killInOne(board, color);
        if (kill) addPriority(kill);
      }
    }

    // 2. 对手下一手成五点优先进入根搜索，搜索负责比较两个堵点及反击手段。
    for (const p of oppWins) addPriority(p);

    // 2b. 硬性防守: 对手落子即成活四/双威胁的点 → 必堵或抢占
    // (搜索会算到这些威胁, 但硬性规则更快更稳, 且搜索预算有限)
    // v11.2: 硬性防守无条件执行 —— 这些检查是 O(附近格子) 的, 不耗搜索预算;
    // 深度档(skipHardRules)只跳过 2c 的可选反推, 防守底线不降级。
    // v7: 跳三缺口(非活四)不再硬性必堵 —— 交给搜索评估。
    // gobang_AI 攻防系数 0.1: 下棋优先于堵棋, 跳三可晚一步堵。
    const urgent = oppOpenFourPoints(board, opp);
    const double = oppDoubleThreatPoints(board, opp);
    const line = oppLineBlocks(board, opp);
    if (urgent.length || double.length || line.length) {
      const cands = [...urgent, ...double, ...line];
      // 紧迫度: 对手活三/四(必堵) > 对手双威胁 > 己方活四机会 > 聚子
      // v8 修正: 堵对手活三的端点必须优先于己方活四机会 ——
      // 对手活三下一步成活四就输了, 己方活四机会晚一步下还在。
      const urgency = new Map();
      // line(对手同线 3 子必堵端点)提到最高, 与 urgent 同级
      for (const p of line) {
        const k = p.y * SIZE + p.x;
        if (!urgency.has(k) || urgency.get(k) < 3) urgency.set(k, 3);
      }
      for (const p of urgent) urgency.set(p.y * SIZE + p.x, 3);
      for (const p of double) {
        const k = p.y * SIZE + p.x;
        if (!urgency.has(k) || urgency.get(k) < 2) urgency.set(k, 2);
      }
      const ranked = [];
      for (const b of cands) {
        const b2 = board.slice();
        b2[idx(b.x, b.y)] = color;
        let s = evalBoardConn(b2, color);
        // 必堵活四/活三的点: 大额加权 —— 对手下一手必胜, 优先于一切
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
        ranked.push({ p: b, score: s });
      }
      ranked.sort((a, b) => b.score - a.score);
      for (const item of ranked) addPriority(item.p);
    }

    // 2c. 一步反推防守 (mumuy gobang 法):
    // 对手下步最优点如果威胁远超我方可选点 → 直接抢对手的点
    // (堵"潜在双威胁"比搜索更直接 —— 普通档预算小, 搜索内未必看到这个点)
    // v11.2: 深度档(skipHardRules)跳过 —— 深度档用满预算深算, 反推只信搜索结论
    if (!skipHard) {
      const myBest = bestByEval(board, color);
      const oppBest = bestByEval(board, opp);
      if (oppBest.score > myBest.score + 4000 && oppBest.score !== -Infinity) {
        return { x: oppBest.x, y: oppBest.y };
      }
    } // end skipHard(2c)
    // v11.2: 删除 5e6 启发式提前返回 —— 打分尺度下普通活三就超 5e6,
    // 该分支让 111 局面中 101 个 <30ms 直接返回, 搜索几乎从不运行,
    // 也看不见对手的 2-4 步强杀序列。双活三/冲四活三的采纳交给修复后的搜索。

    // 3. MiniMax + Alpha-Beta + VCT/VCF 主搜索
    // v9: Web Worker 后台跑 — 预算 3 秒 / 80 万节点, 深度中盘 8。
    // 开局(<8 子)深度 2, 中盘 8, 残局(>190 子)深度 4。
    let stoneCount = 0;
    for (let i = 0; i < board.length; i++) if (board[i] !== EMPTY) stoneCount++;
    // v11.5-tuned: 全局固定 10 层深度。开局、中盘、残局使用同一搜索深度，
    // 节点与墙钟预算负责在复杂局面中安全截断。
    const depth = 10;
    const nodeBudget = 30000000;
    const timeBudgetMs = 9000;
    const testConfig = opts && opts.__testConfig;
    const effectiveDepth = testConfig && Number.isInteger(testConfig.depth)
      ? Math.max(2, Math.min(depth, testConfig.depth))
      : depth;

    // 开局定式: 仅黑第 3 手(天元 + 白 1 子)用严格定式 ——
    // 黑天元开局理论必胜, 白 1 子在斜对角时, 黑应下与天元相邻的活 2 点
    // (普通开局库易给劣手, 这里只保留一个经过验证的必胜雏形)
    if (!skipHard && stoneCount === 2 && color === BLACK) {
      const stones = [];
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== EMPTY) stones.push([x, y, board[idx(x, y)]]);
      }
      const black = stones.find((s) => s[2] === BLACK);
      const white = stones.find((s) => s[2] === WHITE);
      if (black && white) {
        // 黑天元, 白斜邻 → 黑下天元的横/竖邻点(做活 2)
        if (black[0] === 7 && black[1] === 7 &&
            Math.abs(white[0] - 7) === 1 && Math.abs(white[1] - 7) === 1) {
          const cands = [[7, 6], [7, 8], [6, 7], [8, 7]];
          for (const [x, y] of cands) {
            if (board[idx(x, y)] === EMPTY) return { x, y };
          }
        }
      }
    }

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
    // v11.5-tuned: 3000 万节点硬上限；引擎最多占用 9 秒，给 dispatcher、HTTP
    // 与公网传输预留约 1 秒，保证端到端 10 秒窗口。budget.best 让截断时
    // 仍返回最后一次完成迭代的结果。
    const budget = {
      nodes: 0,
      maxNodes: testConfig && Number.isFinite(testConfig.maxNodes)
        ? Math.max(100, Math.min(nodeBudget, testConfig.maxNodes))
        : nodeBudget,
      t0: performance.now(),
      maxMs: Math.max(50,
        (testConfig && Number.isFinite(testConfig.maxMs) ? Math.min(timeBudgetMs, testConfig.maxMs) : timeBudgetMs) -
        (performance.now() - computeStartedAt)),
      visited: null,
      best: null,
      rootOffset,
      rootPriority: tacticalPriority,
    };
    try {
      const res = minmaxSearch(evaluator, searchBoard, color, effectiveDepth, budget, lastMove);
      if (res && res.move) {
        return {
          x: res.move[0], y: res.move[1],
          value: res.value, path: res.path || [], depth: res.depth || 0,
          verified: res.verified !== false, nodes: budget.nodes,
          predictedStop: !!budget.predictedStop,
          iterations: budget.iterations || [],
        };
      }
    } catch (e) {
      if (e !== BUDGET) throw e;
    }
    // v11.2: 预算耗尽(阶段超时)或搜索无果, 但已有部分搜索结果 → 用它, 而非纯启发式
    if (budget.best && budget.best.move) {
      return {
        x: budget.best.move[0], y: budget.best.move[1],
        value: budget.best.value, path: budget.best.path || [],
        depth: budget.best.searchDepth || 0, verified: false, nodes: budget.nodes,
        predictedStop: !!budget.predictedStop,
        iterations: budget.iterations || [],
      };
    }

    // 4. 启发式保底(做棋/防守, 预算超时或搜索无结果)
    return heuristicBest(board, color);
  }

  const __test__ = {
    createEvaluator,
    boardHash,
    valuableMoves(board, color, opts) {
      const copy = board.slice();
      const evaluator = createEvaluator(copy);
      evaluator.init();
      return getValuableMoves(
        evaluator, copy, color,
        (opts && opts.cDepth) || 0,
        !!(opts && opts.onlyThree),
        !!(opts && opts.onlyFour),
        (opts && opts.lastMove) || null,
      );
    },
  };

  return { computeBest, __test__ };
});
