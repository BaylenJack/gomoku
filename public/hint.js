// 五子棋提示引擎 v51 — 三连安全层 + MiniMax/Alpha-Beta + VCT/VCF
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

  // v45.2: 开局库 —— 覆盖前 5 手常见定式 (~3KB 静态数据, 5 手内生效)
  //   数据来源: 实战常见「平衡布阵」开局; 任何一手进搜索后由深度 6/10 接管。
  //   编码约定: 棋子按落子顺序交替 B/W (B1, W1, B2, W2, ...);
  //   黑 1 在 (7,7) 时优先 (天元开局最常见), 其余 (y,x) 字典序;
  //   白按 (y,x) 字典序 —— 适合「黑开天元, 白贴邻」这类典型开局。
  //   4+ 手多白时 lex 序可能与实际下棋顺序略有差异, 但同棋形推荐类似,
  //   实用上不影响选点。
  function boardKey(blacks, whites) {
    const cmpYX = (a, b) => (a[1] - b[1]) || (a[0] - b[0]);
    const centerIdx = blacks.findIndex(p => p[0] === 7 && p[1] === 7);
    const orderedBlacks = centerIdx >= 0
      ? [[7, 7], ...blacks.filter((_, i) => i !== centerIdx).sort(cmpYX)]
      : blacks.slice().sort(cmpYX);
    const orderedWhites = whites.slice().sort(cmpYX);
    let key = '', bi = 0, wi = 0;
    const total = orderedBlacks.length + orderedWhites.length;
    // v46 修复: 白先手开局 (blacks < whites) 时 orderedBlacks[bi++] 可能 undefined;
    //   之前未 guard, boardKey 抛 TypeError 让整次 computeBest 崩, 谈合 4/4 失败,
    //   客户端拿不到 hint → 玩家没下几步就死了。fallback: 任一侧为空就停止拼 key,
    //   返回的 key 不会匹配 OPENING_BOOK 任何条目 (书全是 B-开头), 自然 fall through。
    const totalBlack = orderedBlacks.length;
    const totalWhite = orderedWhites.length;
    for (let i = 0; i < total; i++) {
      if (i % 2 === 0) {
        if (bi >= totalBlack) break;
        const p = orderedBlacks[bi++];
        key += `B${p[0]},${p[1]}_`;
      } else {
        if (wi >= totalWhite) break;
        const p = orderedWhites[wi++];
        key += `W${p[0]},${p[1]}_`;
      }
    }
    if (key.length) key = key.slice(0, -1);
    return key;
  }

  const OPENING_BOOK = {
    // ============ 1 黑子 → 白 2 推荐 (4 entries) ============
    // 黑开天元 (7,7): 白贴邻 (活2/活3 基础)
    'B7,7': [[7, 6], [7, 8], [8, 7], [6, 7]],
    // 黑开 (8,8): 白贴邻
    'B8,8': [[7, 7], [7, 8], [8, 7]],
    // 黑开 (7,8): 白贴邻
    'B7,8': [[7, 7], [8, 8], [8, 7]],
    // 黑开 (8,7): 白贴邻
    'B8,7': [[7, 7], [8, 8], [7, 8]],

    // ============ 2 黑+白 → 黑 3 推荐 (16 entries, 含原 16 种 + 微调) ============
    // 黑开天元 + 白正交邻 (活2 威胁)
    'B7,7_W7,6': [[7, 8], [8, 7], [8, 8], [6, 6], [8, 6], [6, 8]],
    'B7,7_W7,8': [[7, 6], [8, 7], [8, 8], [6, 8], [6, 6]],
    'B7,7_W8,7': [[7, 8], [8, 8], [9, 7], [8, 6], [7, 6]],
    'B7,7_W6,7': [[7, 8], [6, 8], [6, 6], [8, 6], [7, 6]],
    // 黑开天元 + 白斜邻 (反斜堵或做活2)
    'B7,7_W8,8': [[7, 6], [8, 7], [6, 7], [7, 8]],
    'B7,7_W6,6': [[7, 6], [6, 7], [8, 7], [8, 6]],
    'B7,7_W8,6': [[7, 8], [8, 7], [9, 7]],
    'B7,7_W6,8': [[7, 6], [6, 7], [5, 7]],
    // 黑开天元 + 白远端 (平行发展)
    'B7,7_W9,7': [[8, 8], [8, 6]],
    'B7,7_W5,7': [[6, 8], [6, 6]],
    'B7,7_W7,9': [[6, 7], [8, 7]],
    'B7,7_W7,5': [[8, 7], [6, 7]],
    // 黑开天元 + 白远斜 (简化回应)
    'B7,7_W9,9': [[8, 8]],
    'B7,7_W5,5': [[6, 6]],
    // 黑开非天元 + 白贴天元 (白倾向抢中心)
    'B8,8_W7,7': [[8, 7], [7, 8], [9, 7]],
    'B7,8_W7,7': [[8, 8], [8, 7], [6, 7]],

    // ============ 3 黑+白+黑 → 白 4 推荐 (10 entries) ============
    // 黑开天元 + 白邻 + 黑贴 (白 4 应平衡布阵)
    'B7,7_W7,6_B7,8': [[8, 7], [8, 6], [6, 6]],
    'B7,7_W7,6_B8,7': [[7, 8], [8, 8], [8, 6]],
    'B7,7_W7,6_B8,8': [[7, 8], [8, 7], [6, 7]],
    'B7,7_W7,6_B6,6': [[6, 7], [7, 8], [8, 6]],
    'B7,7_W8,7_B7,8': [[7, 6], [8, 8], [6, 7]],
    'B7,7_W8,7_B8,8': [[9, 7], [7, 6], [8, 6]],
    'B7,7_W8,7_B9,7': [[8, 8], [8, 6]],
    'B7,7_W8,8_B7,6': [[8, 7], [7, 8], [6, 7]],
    'B7,7_W8,8_B8,7': [[7, 6], [9, 7], [7, 8]],
    'B7,7_W6,6_B7,6': [[7, 8], [8, 7], [8, 8]],

    // ============ 4 黑+白+黑+白 → 黑 5 推荐 (5 entries) ============
    // 4 手节点 (黑 5 关键决策点), 键按 lex 序
    'B7,7_W7,6_B7,8_W8,7': [[8, 8], [8, 6], [6, 6]],
    'B7,7_W6,6_B7,8_W7,6': [[6, 7], [7, 8], [8, 6]],
    'B7,7_W7,6_B8,7_W7,8': [[8, 8], [8, 6], [6, 7]],
    'B7,7_W7,6_B8,7_W8,8': [[7, 8], [6, 7], [6, 6]],
    'B7,7_W7,6_B8,8_W8,7': [[7, 8], [9, 7], [6, 7]],

    // ============ 5 黑+白+黑+白+黑 → 白 6 推荐 (2 entries) ============
    // 5 手节点 (白 6 关键决策点)
    'B7,7_W7,6_B7,8_W8,7_B8,8': [[6, 6], [6, 7], [8, 6]],
    'B7,7_W7,6_B8,7_W7,8_B8,8': [[6, 6], [6, 7], [9, 7]],
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
    // v11.7: FIVE 之后直接跳到 FOUR —— BLOCK_FIVE 在中盘极少出现(需要边界+长连),
    //   把它挪到 FOUR/THREE 之后, 让常见的活四/冲四早命中早退出, 平均省 1 次 regex test
    if (PAT.four.test(s)) return SH.FOUR;
    if (PAT.blockFour.test(s)) return SH.BLOCK_FOUR;
    if (PAT.three.test(s)) return SH.THREE;
    if (PAT.blockThree.test(s)) return SH.BLOCK_THREE;
    if (PAT.two.test(s)) return SH.TWO;
    if (PAT.blockfive.test(s)) return SH.BLOCK_FIVE; // 长连堵边, 罕见, 放最后
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
      // v47.2: 双活二交点 20 → 200 —— 原值比单活二 (ONE=10) 还低, 搜索评估
      // 看不见"双活二集结"的结构潜力 (一步双威胁之源), 预防性防守无评估基础。
      case SH.TWO_TWO: return TWO_TWO;
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
    // v47.4: 增量评估总和 totals[role] = Σ 空位点分; 增量 Zobrist hash1/hash2
    const totals = [0, 0];
    let hash1 = 0, hash2 = 0;

    function updatePoint(x, y, role) {
      const rIdx = role - 1;
      const c = idx(x, y);
      const old = scores[rIdx][c]; // v47.4: 旧分 (增量 totals 用)
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
        // v47.2: 双活二复合加分 0.4 → 1.0 —— 与 shapeScore(TWO_TWO) 同步提高,
        // 双活二交点 (可延伸成双威胁的结构) 在搜索评估里真正可见
        total += TWO_TWO;
      }
      scores[rIdx][c] = total;
      // v47.4: 增量评估总和 —— 该点分数变化量同步到 totals[role]
      totals[rIdx] += total - old;
    }

    function refresh(x, y) {
      // 落子点影响周围 6 格内的所有空位 (v11: 窗口扩到 6 配合双跳识别)
      for (const [dx, dy] of DIRS) {
        for (const sign of [1, -1]) {
          for (let step = 1; step <= 6; step++) {
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
          const v = board[idx(x, y)];
          if (v !== EMPTY) {
            // v47.4: 已有棋子必须 XOR 进增量 hash, 否则与 boardHash 全盘不一致
            const c = idx(x, y);
            hash1 = (hash1 ^ ZB[c * 2 + (v - 1)]) >>> 0;
            hash2 = (hash2 ^ ZB2[c * 2 + (v - 1)]) >>> 0;
          } else {
            updatePoint(x, y, 1);
            updatePoint(x, y, 2);
          }
        }
      },
      move(x, y, role) {
        const c = idx(x, y);
        // v47.4: 该点将被占用, 从空位评估和中移除 (两色)
        totals[0] -= scores[0][c];
        totals[1] -= scores[1][c];
        // v47.4: 增量 Zobrist —— boardHash 全盘扫描 O(225) → O(1)
        hash1 = (hash1 ^ ZB[c * 2 + (role - 1)]) >>> 0;
        hash2 = (hash2 ^ ZB2[c * 2 + (role - 1)]) >>> 0;
        board[c] = role;
        if (winsAfter(board, x, y, role)) fiveCnt[role - 1]++;
        refresh(x, y);
      },
      undo(x, y) {
        const role = board[idx(x, y)];
        if (role !== EMPTY && winsAfter(board, x, y, role)) fiveCnt[role - 1]--;
        const c = idx(x, y);
        // v47.4: 增量 Zobrist 还原 (XOR 两次 = 复位)
        hash1 = (hash1 ^ ZB[c * 2 + (role - 1)]) >>> 0;
        hash2 = (hash2 ^ ZB2[c * 2 + (role - 1)]) >>> 0;
        board[c] = EMPTY;
        refresh(x, y); // refresh 会重新计算该点分并加回 totals
      },
      evaluate(role) {
        const rIdx = role - 1, oIdx = 1 - rIdx;
        // v11.2: 盘面已有成五 → 直接判胜负(搜索的获胜判定必须真实可达)
        if (fiveCnt[rIdx]) return FIVE;
        if (fiveCnt[oIdx]) return -FIVE;
        // v47.4: 增量总和 —— 原实现每叶子全盘扫描 O(225), 现在 O(1)
        const s = totals[rIdx] - totals[oIdx];
        // v47.1 FIX5: 静态评估饱和 —— 活四/双四/冲四活三级单点分 (1e8/5e8)
        // 远超 FIVE 阈值 (1e7), 不饱和时搜索把"静态高分"误判为"强制必胜"
        // (value >= FIVE 判定命中) —— 阶段 1 VCT 报假杀、引擎下出看似必胜
        // 实则几步后必输的着法 (用户"被绝杀"的根因之一, 与 v46.1 协议层
        // FIVE 对齐同一问题在引擎内部的重现)。饱和后只有真实五连 (fiveCnt)
        // 能产生 ±FIVE, 必胜判定不再被静态分数污染。
        return Math.max(-(FIVE - 1), Math.min(FIVE - 1, s));
      },
      shapeAt(x, y, d, role) { return shapeCache[role - 1][idx(x, y) * 4 + d]; },
      // v47.2: 测试钩子 —— 返回空位点分 (搜索评估里该点的潜力值)
      pointScore(x, y, role) { return scores[role - 1][idx(x, y)]; },
      // v47.4: 增量 Zobrist (测试钩子 hash 一致性校验用)
      hash() { return [hash1, hash2]; },
    };
  }

  // ---------- 分级移动生成 (gobang eval.js getPoints/getMoves + gobang_AI order/has_neightnor) ----------
  // v8: 动态深度降级 —— 深度 > 6 层时强制只搜活三/冲四(gobang onlyThreeThreshold)。
  // 这是 gobang 能搜 12 层的核心: 深层只搜威胁, 分支砍到极小。
  const ONLY_THREE_THRESHOLD = 6;
  function getValuableMoves(evaluator, board, role, depth, onlyThree, onlyFour, lastMove, jitterSeed) {
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
            let keep = (r === role) === isAttackMove ? threePlus : fourPlus;
            // v47.1: 防守节点的安静防守点 —— 邻接 ≥2 个对手子的"纯防守"点
            // (拆对手聚集/堵活二延伸) 是 VCT 的盲区: 原实现防守方只许走
            // 对手威胁点+己方四+, 漏掉这类关键堵点 → 杀棋链误报 (假阳性),
            // 引擎被误导到错误堵点 (实测对 (7,10) 报假杀, 真活路 (8,9) 漏掉)。
            // 只在防守方回合补, 进攻方回合不加 (保持杀棋链窄)。
            if (!keep && !isAttackMove && r === role) {
              let oppN = 0;
              for (let dy = -1; dy <= 1 && oppN < 2; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nx = x + dx, ny = y + dy;
                  if (inB(nx, ny) && board[idx(nx, ny)] === other(role)) oppN++;
                }
              }
              if (oppN >= 2) keep = true;
            }
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
    // v11.7: 移除按距离排序 —— 调用方传进来的数组已按优先级排好
    //   ([...sets.blockFour, ...sets.three, ...sets.two]), 旧的 sort
    //   会让远端的 blockFour 排在近端的 two 后面, slice 砍掉, alpha-beta
    //   剪枝质量下降。改成"去重后保留前 N 个", 同优先级内按 board 遍历顺序
    //   (y*SIZE+x 升序), 足够稳定。
    const orderNear = (arr, n) => dedupe(arr).slice(0, n);
    // v46 Lazy SMP: stable shuffle —— 不同 worker 不同 jitterSeed,
    //   保留前 KEEP 个不动(已是 killer/ttMove 优先级最高段), 后段 Fisher-Yates
    //   让 worker 间走法顺序分散 → 谈合时选出更强解。
    // v47: KEEP 从 8 调到 3 —— 保留 ttMove + 头两个 killer 段, 后段充分
    //   Fisher-Yates 让 worker 间走法分散更明显, 谈合命中率上升。KEEP 太大
    //   会让 tail 段太短(原本 12-16 项列表只剩 4-8 项参与抖动), 多样性不足。
    const KEEP = 3;
    const applyJitter = (points) => {
      if (!jitterSeed || points.length <= KEEP) return points;
      const rnd = mulberry32(jitterSeed >>> 0);
      const tail = points.slice(KEEP);
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
      }
      return [...points.slice(0, KEEP), ...tail];
    };
    // v47.4: 段内距离排序 —— 同类别内按"距最后落子"切比雪夫距离升序,
    // 恢复 gobang 的局部性剪枝 (五子棋着法强局部性, 近点先搜剪枝效率高)。
    // 只在同一类别段内排序, 不跨类别 (类别优先级由拼接顺序保证)。
    const segSort = (arr) => {
      if (arr.length < 2) return arr;
      const opp = other(role);
      return arr.slice().sort((a, b) => {
        // v48.1: 同棋形等级先按双方点位战术分排序，再做候选截断。
        // 旧根节点 lastMove=null 时完全保留 y/x 扫描顺序，slice(0,N) 会系统性
        // 丢掉棋盘右下方的同级强点。点分排序消除方位偏置，也让强着先搜。
        const as = evaluator.pointScore(a[0], a[1], role) + evaluator.pointScore(a[0], a[1], opp);
        const bs = evaluator.pointScore(b[0], b[1], role) + evaluator.pointScore(b[0], b[1], opp);
        if (as !== bs) return bs - as;
        if (lastMove) {
          const ad = Math.max(Math.abs(a[0] - lastMove[0]), Math.abs(a[1] - lastMove[1]));
          const bd = Math.max(Math.abs(b[0] - lastMove[0]), Math.abs(b[1] - lastMove[1]));
          if (ad !== bd) return ad - bd;
        }
        // 稳定、旋转更中性的兜底：靠近天元优先，最后才按坐标。
        const ac = Math.max(Math.abs(a[0] - 7), Math.abs(a[1] - 7));
        const bc = Math.max(Math.abs(b[0] - 7), Math.abs(b[1] - 7));
        return (ac - bc) || (a[1] - b[1]) || (a[0] - b[0]);
      });
    };

    if (sets.five.length || sets.blockFive.length) return applyJitter(orderNear([...segSort(sets.five), ...segSort(sets.blockFive)], 8));
    if (onlyFour || sets.four.length) return applyJitter(orderNear([...segSort(sets.four), ...segSort(sets.blockFour)], 12));
    if (sets.fourFour.length) return applyJitter(orderNear([...segSort(sets.fourFour), ...segSort(sets.blockFour)], 12));
    if (sets.fourThree.length) return applyJitter(orderNear([...segSort(sets.fourThree), ...segSort(sets.blockFour), ...segSort(sets.three)], 14));
    if (sets.threeThree.length) return applyJitter(orderNear([...segSort(sets.threeThree), ...segSort(sets.blockFour), ...segSort(sets.three)], 14));
    if (onlyThree) return applyJitter(orderNear([...segSort(sets.blockFour), ...segSort(sets.three)], 14));
    return applyJitter(orderNear([...segSort(sets.blockFour), ...segSort(sets.three), ...segSort(sets.blockThree), ...segSort(sets.twoTwo), ...segSort(sets.two)], 16));
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
  const CACHE_MAX = 200000; // v47.4: 8000 → 200000 —— 深度 12-14 搜索百万节点,
  // 原缓存 8000 条在迭代前几轮就被挤光, TT 基本失效 → 跨迭代/跨分支重复搜索。

  // v45: history 启发 —— 走法按"历史剪枝分"降序排列, 让 alpha-beta 优先试
  //   历史上剪过枝的格子。同深度的 killer 只覆盖本层; history 跨深度累计,
  //   对深层搜索增益更显著(浅层 killer 已重置, history 保留累计经验)。
  //   用 to-square 单 key(而非 from→to 对), 225 格的 Int32Array 足够,
  //   数据局部性更好(L1 命中率高)。
  const HISTORY = new Int32Array(SIZE * SIZE);
  function resetHistory() { HISTORY.fill(0); }
  // v48: countermove history —— 记录"上次对方走了 X, 我最好用 Y 应"。
  //   之后遇到同样的 prevMove, 直接把 Y 提到第三位(在 killer/ttMove 之后)。
  //   Int16 即可 (move index < 225), SIZE*SIZE=225 项 ≈ 0.9 KB, 跨深度累计。
  //   注: 硬覆盖型 (latest wins), 不存分数。简单、有效、O(1) 更新/查询。
  const COUNTER_MOVE = new Int16Array(SIZE * SIZE);
  const NO_COUNTER = -1;
  function resetCounterMove() { COUNTER_MOVE.fill(NO_COUNTER); }

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
      // v45.1: 同时累加到外层 budget(若有 incOuter) —— 测试可观察总节点数
      if (budget.incOuter) budget.incOuter();
      if (budget.t0 && performance.now() - budget.t0 > budget.maxMs) throw BUDGET;
      const originalAlpha = alpha;
      const originalBeta = beta;

      // 静态搜索: 到达叶子(或接近叶子)时, 不立即评估 —— 继续搜强制走法
      // (冲四/活三), 避免"被一子反转"的假评估 (PentaZen quiescence)
      if (cDepth >= depth) {
        return [evaluator.evaluate(role), null, path];
      }
      // Razoring 仅用于常规搜索最后两层；根节点的精确强制防守不经过这里。
      if (!onlyThree && !onlyFour && cDepth >= depth - 2 && depth - cDepth <= 2) {
        const staticScore = evaluator.evaluate(role);
        if (staticScore + 45 * (depth - cDepth) <= alpha) {
          return [staticScore, null, path];
        }
      }

      // v47.4: 增量 Zobrist (O(1)) —— 原 boardHash 每节点全盘扫描 O(225)
      const [h1, h2] = evaluator.hash ? evaluator.hash() : boardHash(board);
      // v8: 缓存 key 含变体标志 —— VCT/VCF 与常规搜索的缓存不通用(gobang)
      // v11.5: 53 位 key —— 高 32 位 h2 纯位段(<<21) + 低 21 位 mix
      // (mix 把 role/深度/变体混合进 h1), 位段无重叠 → 无进位歧义。
      // 原 32 位 key 在几万节点的树里碰撞 ~1-5%, 误命中产生偶发错棋。
      // v48.1: TT key 只描述局面、行棋方和搜索变体，深度放在 entry.depth。
      // 旧 key 把剩余深度也混进去，导致迭代加深 d=2/4/6/... 之间完全无法
      // 复用上一层 TT，prev.depth 的深度判定形同虚设。移除深度后，浅层条目
      // 可继续提供 best-move 排序，足够深的条目才会用于剪枝/直接返回。
      const variant = (onlyThree ? 2 : 0) + (onlyFour ? 1 : 0);
      const mix = (h1 ^ Math.imul(role * 4 + variant, 0x9E3779B1)) >>> 0;
      const key = h2 * 2097152 + (mix >>> 11);
      const prev = cache.get(key);
      // v47.14 TT 边界标记修复: 缓存条目标记 flag(0=精确, 1=剪枝下界)。
      // 原实现无边界标记 —— fail-high 剪枝(alpha>=beta)时返回的是"最后着法的
      // 值", 对深度要求低的节点它是下界而非精确值; 被当精确值缓存后, 后续
      // 更深搜索命中该条目会把乐观值(可能含 LMR 减深误差)当作必胜传播,
      // 引擎下出"幻觉假杀"(实测 15s 自对弈白第 28 手 (8,4) 声称必胜实为败着,
      // 幻觉 PV 里黑方已五连仍标白胜)。
      if (prev && prev.onlyThree === onlyThree && prev.onlyFour === onlyFour) {
        const enough = prev.depth >= depth - cDepth;
        // flag: 0=精确, 1=下界(fail-high), -1=上界(fail-low)。边界值只有在
        // 能关闭当前窗口时才可直接使用；否则仍保留其 best move 用于排序。
        if ((prev.flag === 0 && (Math.abs(prev.value) >= FIVE || enough)) ||
            (enough && prev.flag === 1 && prev.value >= beta) ||
            (enough && prev.flag === -1 && prev.value <= alpha)) {
          return [prev.value, prev.move, [...path, ...prev.path]];
        }
      }
      // v45: 缓存命中(深度够/必胜)的已 early-return; 此处的 prev 不一定命中,
      //   但 TT 里仍可能存着"换变体/换深度没命中"的记录 —— 它的 best.move
      //   仍然是最优候选, 提取出来放进走法排序。
      const ttMove = prev && prev.move ? prev.move : null;

      // gobang_AI order: 离最后落子近的点优先搜索(Alpha-Beta 剪枝效率关键)
      // v46 Lazy SMP: jitterSeed 来自 budget(computeBest 设置), 让不同 worker
      //   在 getValuableMoves 尾段走不同 Fisher-Yates 顺序, 谈合时分散候选
      let points = getValuableMoves(evaluator, board, role, cDepth, onlyThree, onlyFour, lastMove, budget.jitterSeed);
      if (!points.length) return [evaluator.evaluate(role), null, path];

      // v10 杀手走法: 把剪枝成功的走法排到最前面(同深度优先试)。
      // 注意: killers 按 cDepth 索引(同深度节点), 只在剪枝时写入;
      // 排序是稳定的(只把杀手提到前面, 不重排其余)。
      const k1 = killers[cDepth] ? killers[cDepth][0] : NO_COUNTER;
      const k2 = killers[cDepth] ? killers[cDepth][1] : NO_COUNTER;
      const ttIdx = ttMove ? ttMove[0] * SIZE + ttMove[1] : NO_COUNTER;
      const cmIdx = lastMove
        ? COUNTER_MOVE[lastMove[0] * SIZE + lastMove[1]]
        : NO_COUNTER;
      // v48.1: 用一次复合排序兑现启发式优先级。
      // 旧实现先把 killer 拼到数组末尾（方向写反），随后 history sort 又会
      // 抹掉 TT/killer/countermove 的位置，三套启发式实际几乎不生效。
      // 顺序固定为 TT > killer > countermove > history > 局部距离。
      const priority = (p) => {
        const m = p[0] * SIZE + p[1];
        if (m === ttIdx) return 3;
        if (m === k1 || m === k2) return 2;
        if (m === cmIdx) return 1;
        return 0;
      };
      points.sort((a, b) => {
        const pa = priority(a), pb = priority(b);
        if (pa !== pb) return pb - pa;
        const ha = HISTORY[b[0] * SIZE + b[1]] - HISTORY[a[0] * SIZE + a[1]];
        if (ha !== 0 || !lastMove) return ha;
        const la = Math.max(Math.abs(a[0] - lastMove[0]), Math.abs(a[1] - lastMove[1]));
        const lb = Math.max(Math.abs(b[0] - lastMove[0]), Math.abs(b[1] - lastMove[1]));
        return la - lb;
      });

      let value = -MAX;
      let move = null;
      let bestPath = path;
      let bestDepth = 0;
      let didCut = false; // 剪枝退出 → 缓存标记下界

      // 迭代加深: 每轮记录该深度最优，更深的完整迭代覆盖浅层。
      for (let d = cDepth + 1; d <= depth; d += 1) {
        if (d % 2 !== 0) continue;
        let iterBest = -MAX, iterMove = null, iterPath = path, iterDepth = 0;
        let breakAll = false;
        // v48 LMR (Late Move Reduction) —— 已在下方 for(i) 内实施。
        //   原 v45.1 TODO 中提到的 "测试套件过 60/62 但基准对战强度下降" 问题,
        //   通过保守的 reduction 表 (max 3) + fail-low 重搜 + 跳过 VCT/VCF/PV/前 3
        //   等多重保护规避。
        // 旧 NMP 位于任何着法搜索之前，却要求 iterBest 已建立，因此条件永远
        // 不可能成立。删除这段死代码，避免以后误以为已有 null-move 保护。
        for (let i = 0; i < points.length; i++) {
          const [x, y] = points[i];
          evaluator.move(x, y, role);
          const newPath = [...path, [x, y]];
          // v48 LMR (Late Move Reduction): 排序靠后的着法减少搜索深度
          //   - 只在常规搜索启用 (跳过 VCT/VCF 变体, 它们只看 forcing 走法, 减深度风险大)
          //   - 跳过 PV 节点 (cDepth === 0 视为根 PV)
          //   - 跳过 i < 3 (前 3 个是 killer/ttMove/countermove, 优先级最高)
          //   - 跳过第一个 move (iterBest === -MAX 时尚无 PV)
          //   reduction 表: depth 大、index 大减得深 (Stockfish 风格)
          //   v47.13 重搜条件: reduced search 返回 cv > alpha (含 fail-high) 且
          //   r >= 2 时重搜完整窗口 (见下方修复注释)
          let lmrDepth = d;
          let lmrReduced = false;
          let lmrR = 0;
          if (!onlyThree && !onlyFour && cDepth > 0 && i >= 3 && d >= 4 && iterBest > -MAX) {
            lmrR = Math.min(3, Math.max(0, Math.floor((d - 3) * 0.5) - Math.floor((i - 3) * 0.15)));
            if (lmrR > 0) {
              lmrDepth = Math.max(cDepth + 1, d - lmrR);
              lmrReduced = true;
            }
          }
          // v47.4 (回退): PVS 实测 1:5 棋力退化 —— null-window 不写缓存导致
          // TT 复用率骤降, 低预算下完成的迭代深度反而变浅。恢复全窗口
          // alpha-beta (保留增量 hash/eval、CACHE_MAX、距离排序)。
          let [cv, , cp] = helper(evaluator, board, other(role), lmrDepth, cDepth + 1, newPath, -beta, -alpha, budget, cache, [x, y], bestSlot);
          cv = -cv;
          evaluator.undo(x, y);
          // v47.13 LMR 修复: 原条件 (cv < beta) 把 fail-high 排除在重搜外 ——
          // 减深度搜索的 fail-high 是乐观上界, 3 层减深度可能高估着法 (对手
          // 深层的防守没被看到), 直接截断会让根层候选错误地 cut, 引擎下出
          // 深度 9 的"假杀" (根层排序靠后的着法只搜到 d-3)。改为 cv > alpha
          // 即重搜 (含 fail-high), r >= 2 才重搜 (r=1 误差极小, 省节点)。
          if (lmrReduced && cv > alpha && lmrR >= 2) {
            evaluator.move(x, y, role);
            let [cv2, , cp2] = helper(evaluator, board, other(role), d, cDepth + 1, newPath, -beta, -alpha, budget, cache, [x, y], bestSlot);
            cv2 = -cv2;
            evaluator.undo(x, y);
            cv = cv2;
            cp = cp2;
          }

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
          alpha = Math.max(alpha, iterBest);
          // v10: Alpha-Beta 剪枝命中 → 记录杀手走法(PentaZen update_killers)
          if (alpha >= beta) {
            didCut = true; // 剪枝退出, 当前 value 是下界非精确值
            if (!killers[cDepth]) killers[cDepth] = [null, null];
            if (killers[cDepth][0] !== x * SIZE + y) {
              killers[cDepth][1] = killers[cDepth][0];
              killers[cDepth][0] = x * SIZE + y;
            }
            // v45: history 表累加 —— 剩余深度的平方(深层剪枝更值钱,
            //   加平方放大). 简单剪枝给 1, 深层导致整子树剪掉给 9-25.
            // v48: countermove history —— 记录 "prevMove → 这个走法" 应答
            //   只有非根层有意义 (cDepth > 0 时 lastMove 由 engine 传入)
            if (lastMove) {
              COUNTER_MOVE[lastMove[0] * SIZE + lastMove[1]] = x * SIZE + y;
            }
            // v45: history 表累加 —— 剩余深度的平方(深层剪枝更值钱,
            //   加平方放大). 简单剪枝给 1, 深层导致整子树剪掉给 9-25.
            HISTORY[x * SIZE + y] += (depth - cDepth) * (depth - cDepth);
            break;
          }
          if (alpha >= FIVE) { breakAll = true; break; } // 自己赢了就结束
        }
        // 迭代结束提交: 更深迭代(更准确)的结果优先, 覆盖浅层
        if (iterMove !== null) {
          value = iterBest;
          move = iterMove;
          bestPath = iterPath;
          bestDepth = iterDepth;
          // v11.2: budget.best 只从根层写入 —— 预算超时时返回部分搜索结果
          // v11.3 (gobang V3): VCT 变体(onlyThree)非胜值只在最终迭代提交 ——
          // 浅层"没杀"证明不了任何事; v11.4: 常规变体逐迭代写入 —— 浅层完整
          // 迭代(d=2/4)结果远好于纯启发式, 最终迭代超时也有真结果可用,
          // 不再整个搜索白跑后退化回启发式。
          if (bestSlot && cDepth === 0 && (!onlyThree || d === depth || iterBest >= FIVE)) {
            // v48.1: budget.best 表示“最后一个完整迭代”，而不是“历史最高分”。
            // 浅层估值天然更乐观；旧比较只在分数更高时覆盖，会让 d=2 的高分
            // 压住已经完成的 d=8/10 更准确结果，超时时等价于退回浅搜。
            bestSlot.best = {
              value: iterBest,
              move: iterMove,
              path: iterPath,
              depth: iterPath.length,
              completedDepth: d,
            };
          }
        }
        if (breakAll) break;
      }

      // v47.4 (回退): PVS 放弃后恢复无条件写缓存 (全窗口搜索的值精确)
      // v47.14: 剪枝退出(didCut)的值是下界, 标记 flag=1 防被当精确值复用
      const remainingDepth = depth - cDepth;
      const ttFlag = value <= originalAlpha ? -1 : (didCut || value >= originalBeta ? 1 : 0);
      if (cache.size < CACHE_MAX &&
          (!prev || prev.depth < remainingDepth ||
           (prev.depth === remainingDepth && prev.flag !== 0 && ttFlag === 0))) {
        cache.set(key, {
          depth: remainingDepth,
          value,
          move,
          path: bestPath.slice(cDepth),
          // v8: 缓存区分变体 —— VCT/VCF 与常规搜索的缓存不通用(gobang)
          onlyThree,
          onlyFour,
          flag: ttFlag,
        });
      }
      return [value, move, bestPath];
    }
    helper.resetKillers = resetKillers;
    helper.resetHistory = resetHistory;
    helper.resetCounterMove = resetCounterMove;
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
    const vctDepth = depth + 12;
    // v48: 阶段 3 防守 VCT 单独深度 —— 阶段 1 找自己的杀用 depth+8 已够,
    //   阶段 3 防守校验用更深的 depth+10, 让长链必杀 (对手 12+ 手 VCT) 更易识别。
    //   阶段 3 预算 25% 不变, 深度只 +2, 节点数 ~100x, 实测仍能完成常规残局。
    const vctDefDepth = depth + 10;

    // v45.1: 外层 budget 跟踪总节点数 —— 各阶段内部用独立 budget(避免共享
    //   evaluator 残留), 但每个 helper 调用时同时累加到外层 budget.nodes,
    //   让 computeBest 能看到"搜索实际跑了多少节点"。
    const incOuter = () => { budget.nodes++; };
    // v47.1: 各阶段节点数记录 —— 测试可断言"防守局面阶段 1 被跳过"(FIX1)
    budget.stageNodes = { s1: 0, s2: 0, s3: 0 };

    // v47.1 FIX1: 阶段 1 预检 —— 己方无活三+/冲四+ 进攻点时跳过 VCT。
    //   VCT 根节点只搜进攻方自己的活三+ 点, 没有点必然空转烧预算
    //   (实测防守局面白烧 1226ms/8177 节点一无所获), 预算转给阶段 3 防守校验。
    //   有进攻点时行为不变 (35% 找杀)。
    const hasAttack = getValuableMoves(evaluator, board, role, 0, true, false, lastMove, budget.jitterSeed).length > 0;

    // 阶段 1: VCT 找杀(预算 35%)
    // v11.4: 各阶段用独立 evaluator 副本 —— BUDGET 超时是异常抛出, 搜索树上
    // move/undo 不平衡, 共享 evaluator 会让下一阶段在残留棋子上搜索,
    // 误判假五连/假分数, 结果随超时点漂移(同一棋盘每次不同)。
    const b1 = hasAttack
      ? { nodes: 0, maxNodes: Math.floor(budget.maxNodes * 0.2), t0: performance.now(), maxMs: budget.maxMs * 0.2, incOuter }
      : null;
    let value, move, bestPath;
    if (b1) {
      try {
        const vBoard = board.slice();
        const vctEval = createEvaluator(vBoard);
        vctEval.init();
        [value, move, bestPath] = vct(vctEval, vBoard, role, vctDepth, 0, [], -MAX, MAX, b1, cache, lastMove, budget);
        budget.stageNodes.s1 = b1.nodes;
        // v47.9: 假杀验证 —— VCT 杀棋链假设对手必须回应, 但对手可能有更快
        // 杀 (实测: 白活三造点报假杀, 黑活三 2 步反杀更快)。己方走 move 后
        // 验证对手能否 VCT 杀; 对手杀链不短于己方 → 假杀, 落到阶段 2/3
        // 由防守校验改堵 (用户实战两局赢 AI 的破绽根因)。
        if (value >= FIVE && move) {
          let oppVal = 0, oppPathLen = 0, isFake = false;
          const vb = board.slice();
          vb[idx(move[0], move[1])] = role;
          const ve = createEvaluator(vb);
          ve.init();
          // v47.13: 验证预算自适应 —— 原固定 1s, 阶段 1 预算从 35% 降到 20% 后
          // VCT 在预算尾部找到杀时 (杀棋链找到得晚), 固定 1s 验证会把总耗时
          // 推到 dispatcher 超时线 (15.5s) 之外, 4 个 worker 同时超时 → 请求失败。
          // 改为吃阶段 1 剩余预算, 地板 150ms (实战杀棋链通常 <200ms 验证完)。
          const verifyMs = Math.min(1000, Math.max(150, b1.maxMs - (performance.now() - b1.t0)));
          const vbudget = { nodes: 0, maxNodes: 200000, t0: performance.now(), maxMs: verifyMs, incOuter: null };
          try {
            const [ov, , op] = vct(ve, vb, other(role), 18, 0, [], -MAX, MAX, vbudget, new Map(), move);
            oppVal = ov; oppPathLen = op.length;
          } catch (e) {
            if (e !== BUDGET) throw e;
          }
          if (oppVal >= FIVE && bestPath.length >= oppPathLen) isFake = true;
          if (!isFake) return { move, value, path: bestPath };
          if (budget.best && budget.best.move &&
              budget.best.move[0] === move[0] && budget.best.move[1] === move[1]) {
            budget.best = null; // 清掉假杀, 防止搜索无果时回退
          }
        }
      } catch (e) {
        if (e !== BUDGET) throw e;
        budget.stageNodes.s1 = b1.nodes;
      }
    }

    // 阶段 2: 常规 minmax(预算 55% —— v47.13 从 40% 上调: 阶段 1 VCT 35% → 20%,
    // 找不到杀时省下的时间转给深度 12 主战场。实测复杂中盘 40% 下深度 12 常
    // 跑不完只提交 d=10, 55% 下完成度显著提升, 且找杀/验证不受影响)
    // 阶段 1 的非必胜结果不能占用阶段 2 的 best slot。旧实现共用 budget.best，
    // 阶段 2 若在更深一轮中超时，局部 move/value 仍可能残留阶段 1 的着法，
    // 从而白算 55% 主搜索预算。阶段 2 从干净槽开始，只提交自己的完整迭代。
    budget.best = null;
    const remainingBeforeS2 = Math.max(50, budget.maxMs - (performance.now() - budget.t0));
    const b2 = {
      nodes: 0, maxNodes: Math.floor(budget.maxNodes * 0.55),
      t0: performance.now(), maxMs: Math.min(budget.maxMs * 0.55, remainingBeforeS2),
      incOuter,
    };
    try {
      const mBoard = board.slice();
      const minEval = createEvaluator(mBoard);
      minEval.init();
      [value, move, bestPath] = _minmax(minEval, mBoard, role, depth, 0, [], -MAX, MAX, b2, cache, lastMove, budget);
      budget.stageNodes.s2 = b2.nodes;
    } catch (e) {
      if (e !== BUDGET) throw e;
      budget.stageNodes.s2 = b2.nodes;
      if (budget.best && budget.best.move) {
        value = budget.best.value;
        move = budget.best.move;
        bestPath = budget.best.path;
      }
    }
    // v47.14: 阶段 2 的 FIVE 声称也必须假杀验证 —— 阶段 1 有验证, 阶段 2
    // (常规 minmax) 的必胜声称此前直接信任。TT 边界污染 (已修复) 与 LMR
    // 减深残差可能让阶段 2 报出幻觉假杀 (实测白 (8,4) 声称必胜, 黑活三
    // 3 手反杀更快)。验证逻辑与阶段 1 一致: 落子后查对手 VCT 杀, 对手杀
    // 链不短于己方 → 假杀, 清掉 best 提交, 落到阶段 3 改堵对手杀棋起点。
    if (move && value >= FIVE) {
      let oppVal = 0, oppPathLen = 0, isFake = false;
      const vb = board.slice();
      vb[idx(move[0], move[1])] = role;
      const ve = createEvaluator(vb);
      ve.init();
      // 验证预算 ≤400ms: 假杀必被杀链通常是短链(≤5 手), VCT 秒级找到;
      // 深度杀链由阶段 3 (depth+10) 兜底。预算受总墙钟约束, 防把总耗时
      // 推出 dispatcher 超时线 (15.5s)。
      const verifyMs = Math.min(400, Math.max(150, budget.maxMs - (performance.now() - budget.t0)));
      const vbudget = { nodes: 0, maxNodes: 150000, t0: performance.now(), maxMs: verifyMs, incOuter: null };
      try {
        const [ov, , op] = vct(ve, vb, other(role), 18, 0, [], -MAX, MAX, vbudget, new Map(), move);
        oppVal = ov; oppPathLen = op.length;
      } catch (e) {
        if (e !== BUDGET) throw e;
      }
      if (oppVal >= FIVE && bestPath.length >= oppPathLen) isFake = true;
      if (isFake) {
        if (budget.best && budget.best.move &&
            budget.best.move[0] === move[0] && budget.best.move[1] === move[1]) {
          budget.best = null; // 清掉假杀, 防止搜索无果时回退
        }
        value = 0; // 强制走阶段 3 防守校验 (改堵对手杀棋起点)
      }
    }
    if (!move) return null;

    // 阶段 3: 防守校验(预算: 有进攻点 25%, 无进攻点 45% —— 阶段 1 的预算转给这里)
    // v47.1 FIX2: 我落 move 后对手能否 VCT 杀? 能且己方无必胜 → 改堵对方杀棋
    // 起点(防守妙手)。原实现即此设计, v47.1 有两处增强:
    //   - VCT 防守节点补"安静防守点"(邻接 ≥2 对手子) —— 消除误报杀棋,
    //     验证结果可信;
    //   - FIX5 静态评估饱和 —— 只有真实五连产生 ±FIVE, 阶段 1/3 的杀棋
    //     判定不再被静态高分污染 (这是引擎"下出看似必胜实则必输"的根因)。
    // 单候选 + 全预算: 多候选切片实测预算碎片化, 深杀链在切片内找不到,
    // 验证失真; 单候选拿满预算, 堵杀棋起点本身已是最优防守。
    // v47.2: 无进攻点时阶段 3 预算 45% → 55% (阶段 1 跳过转来), 深杀链验证更充分
    // v47.13: 无进攻点时阶段 3 预算 55% → 45% (阶段 2 已从 40% 升到 55%,
    // 防守校验 45% + 阶段 2 的深度优势仍能覆盖长杀链; 三阶段总和回到 100%)
    const remainingBeforeS3 = Math.max(50, budget.maxMs - (performance.now() - budget.t0));
    const b3 = {
      nodes: 0, maxNodes: Math.floor(budget.maxNodes * (hasAttack ? 0.25 : 0.45)),
      t0: performance.now(),
      maxMs: Math.min(budget.maxMs * (hasAttack ? 0.25 : 0.45), remainingBeforeS3),
      incOuter,
    };
    if (value < FIVE) {
      try {
        const sBoard = board.slice();
        const sEval = createEvaluator(sBoard);
        sEval.init();
        sEval.move(move[0], move[1], role);
        const [value2, move2, path2] = vct(sEval, sBoard, other(role), vctDefDepth, 0, [], -MAX, MAX, b3, cache, move);
        sEval.undo(move[0], move[1]);
        budget.stageNodes.s3 = b3.nodes;
        // 己方未确认必胜 + 对手确认必胜 → 改堵对手杀棋起点
        if (value2 >= FIVE && move2) return { move: move2, value, path: path2 };
      } catch (e) {
        if (e !== BUDGET) throw e;
        budget.stageNodes.s3 = b3.nodes;
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
    // v49: 最高优先级战术不再依赖正则/启发式棋形。逐个合法空位真实落子，
    // 用与游戏规则一致的 winsAfter 判定；225 格全扫也只有常数级开销。
    // 这完整覆盖连续四、跳四、边界冲四和长连，任何搜索/评估都无权覆盖。
    for (let c = 0; c < board.length; c++) {
      if (board[c] !== EMPTY) continue;
      const x = c % SIZE, y = Math.floor(c / SIZE);
      board[c] = color;
      const wins = winsAfter(board, x, y, color);
      board[c] = EMPTY;
      if (wins) out.push({ x, y });
    }
    return out;
  }

  // 精确两手战术：当前方落 candidate 后，若对手没有立即成五，而当前方留下
  // 至少两个不同成五点，则对手一手最多封一个，当前方下一手必胜。
  function forcedWinInTwoPoints(board, color) {
    const out = [];
    const opp = other(color);
    for (const [x, y] of nearCells(board)) {
      const c = idx(x, y);
      if (board[c] !== EMPTY) continue;
      board[c] = color;
      const winsNow = winsAfter(board, x, y, color);
      if (!winsNow) {
        const oppImmediate = winPoints(board, opp);
        if (!oppImmediate.length) {
          const nextWins = winPoints(board, color);
          if (nextWins.length >= 2) out.push({ x, y, replies: nextWins.length });
        }
      }
      board[c] = EMPTY;
    }
    return out;
  }

  // 对方下一手能够制造至少一个“立即成五点”的位置。它精确覆盖连续三、
  // 眠三、边界三和跳三的成四点，不依赖容易漏形的正则棋形分类。
  // replies>=2 是两手必胜启动点；replies===1 也是必须高度重视的成四先手。
  function fourLaunchPoints(board, color) {
    const out = [];
    for (let c = 0; c < board.length; c++) {
      if (board[c] !== EMPTY) continue;
      const x = c % SIZE, y = Math.floor(c / SIZE);
      board[c] = color;
      if (!winsAfter(board, x, y, color)) {
        const replies = winPoints(board, color).length;
        if (replies > 0) out.push({ x, y, replies });
      }
      board[c] = EMPTY;
    }
    return out;
  }

  // v11.5: 一步杀扫描 —— 落子即成活四/双活三/冲四活三/双四 → 对手一步堵不完, 直接杀。
  // 原放在 2b 内(对手活三/双威胁时才查), 且"堵对手成五"在它之前 —— 对手只有
  // 冲四时先被迫堵棋, 漏掉必胜杀(杀棋链迫使对手全程应挡, 其冲四永远走不完)。
  // v11.6: 多个一步杀点时选最优 —— 原实现返回扫描到的第一个, 可能不是
  // 局面分最高的(比如一个成双活三、另一个成冲四活三, 前者通常更强)。
  function killInOne(board, color) {
    let best = null, bestScore = -Infinity;
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
        const s = evalBoardConn(b2, color);
        if (s > bestScore) { bestScore = s; best = { x, y }; }
      }
    }
    return best;
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

  // 对手连续聚子 → 返回所有开放端点。三连即使只有单开口也必须进入根节点
  // 安全层；旧版刻意忽略眠三，正是“对方三连了还继续进攻”的来源之一。
  function establishedThreeBlocks(board, opp) {
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
  // v45.1: 阶段化 DEF_RATIO —— 早期纯进攻, 中盘平衡, 残局防守更重要。
  // 借鉴: gobang_AI 一致认为防守系数是引擎强度的关键杠杆, 但 0.1 在所有
  // 阶段都偏攻 —— 残局每颗子都珍贵, 防守侧漏 1 颗就可能输。改成阶段化:
  //   开局 <8 子:  0.05 (纯进攻, 开局靠先手)
  //   中盘 8-190:  0.1  (平衡, 略偏攻)
  //   残局 >190:  0.2  (防守更重要, 残局漏失即败)
  // evalBoard 内部不直接调, 走 stageDefRatio(stoneCount), 让上层调用方按局面决定。
  const STAGE_DEF_RATIO = { OPENING: 0.05, MIDGAME: 0.1, ENDGAME: 0.2 };
  function stageDefRatio(stoneCount) {
    if (stoneCount < 8) return STAGE_DEF_RATIO.OPENING;
    if (stoneCount > 190) return STAGE_DEF_RATIO.ENDGAME;
    return STAGE_DEF_RATIO.MIDGAME;
  }
  // 评估: 己方模式分 - 对方模式分 × 攻防系数。
  // 借鉴 gobang_AI: 对手分只按 0.1 折算 —— 五子棋 AI 必须进攻压倒防守,
  // 防守偏差过大(如 1.08)会让引擎只会堵、不会攻("太蠢"的根因之一)。
  // v45.1: 默认 DEF_RATIO 保留为 0.1 (中盘值), 阶段化走 stageDefRatio().
  const DEF_RATIO = 0.1;

  // v45.1: 双活三威胁统计 —— 落 (x,y) 后在四个方向上若形成 ≥2 个 3+ 方向
  // (双活三/冲四+活三/双冲四), 视为"一子双威胁"。这类点是杀棋之源, 必须
  // 在评估函数里显著加权(原先只在 crossBonus 内对单点加分)。
  // 用法: countForcing(board, color) 返回全盘"若该点落 color 则形成威胁"的点数。
  function countForcing(board, color) {
    let count = 0;
    for (const [x, y] of nearCells(board)) {
      if (board[idx(x, y)] !== EMPTY) continue;
      const b2 = board.slice();
      b2[idx(x, y)] = color;
      let fourCnt = 0, threeCnt = 0, liveFour = false;
      for (const [dx, dy] of DIRS) {
        const l = dirThreat(b2, x, y, dx, dy, color);
        if (l >= 4) {
          fourCnt++;
          if (l === 4) { const s = scanLine(b2, x, y, dx, dy, color); if (s.n === 4 && s.open === 2) liveFour = true; }
        } else if (l >= 3) threeCnt++;
      }
      if (liveFour || fourCnt >= 2 || (fourCnt >= 1 && threeCnt >= 1) || threeCnt >= 2) count++;
    }
    return count;
  }

  function evalBoard(board, color, stoneCount) {
    const mc = patternCounts(board, color);
    const mo = patternCounts(board, other(color));
    const dr = (typeof stoneCount === 'number') ? stageDefRatio(stoneCount) : DEF_RATIO;
    let s = 0;
    for (const k in PW) s += PW[k] * (mc[k] - mo[k] * dr);
    // v45.1: cross-bonus 加权 —— 一子双威胁(双活三/冲四+活三)不仅在单点评分,
    //   在全盘静态评估里也加权, 让搜索里的浅层评估立即"看见"这类威胁。
    //   权重用 1e3 而不是更大值: 权重大会触发 2c 反推误判(最佳 oppBest 与
    //   myBest 之间 countForcing 差 1 时导致 2c 把进攻点误判为防守点)。
    //   1e3 是保守值 —— patternCounts 已经覆盖主要的双活三差异(3e6/格),
    //   cross-bonus 1e3/格只是"放大镜", 不抢主导。
    const crossMine = countForcing(board, color);
    const crossOpp = countForcing(board, other(color));
    s += (crossMine - crossOpp * dr) * 1e3;
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

  // v47.3 融合 v11.5: 防守候选的 VCT 安全验证 —— 按评分取前 3, 逐个摆子跑
  // 对手 VCT (深度 18), 第一个"对手杀不掉"的当选; 全被杀/预算耗尽 → 回退
  // 评分最高的候选。预算固定 1.2s/20 万节点 —— 杀链验证通常 <200ms。
  // 背景: 直接按评分返回可能选到被杀点 (实测 P6 局面 (8,9) 堵后黑仍可杀),
  // v11.5 时代预算小对手弱, 该问题不显; 现在对手会用多线集结杀。
  function safeDefensePick(board, color, scored, fallback) {
    const opp = other(color);
    const b = { nodes: 0, maxNodes: 200000, t0: performance.now(), maxMs: 1200, incOuter: null };
    for (let i = 0; i < Math.min(3, scored.length); i++) {
      const p = scored[i].p;
      const x = p[0] !== undefined ? p[0] : p.x;
      const y = p[1] !== undefined ? p[1] : p.y;
      const vb = board.slice();
      vb[idx(x, y)] = color;
      const ev = createEvaluator(vb);
      ev.init();
      try {
        const [value2] = vct(ev, vb, opp, 18, 0, [], -MAX, MAX, b, new Map(), [x, y]);
        if (value2 < FIVE) return { x, y };
      } catch (e) {
        if (e !== BUDGET) throw e;
        break;
      }
    }
    const f = fallback;
    return { x: f[0] !== undefined ? f[0] : f.x, y: f[1] !== undefined ? f[1] : f.y };
  }

  // 根节点防守统一决策：先去重，再用“堵后剩余的精确威胁数”排序，最后用
  // VCT 排除表面上堵住一条线、实际仍被另一条线杀掉的伪防守。
  function chooseForcedDefense(board, color, candidates, urgency = new Map(), verify = true) {
    const opp = other(color);
    const unique = new Map();
    for (const p of candidates) {
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) continue;
      unique.set(p.y * SIZE + p.x, p);
    }
    const scored = [...unique.values()].map((p) => {
      const b2 = board.slice();
      b2[idx(p.x, p.y)] = color;
      const immediate = winPoints(b2, opp).length;
      const forcedTwo = forcedWinInTwoPoints(b2, opp).length;
      const launches = fourLaunchPoints(b2, opp).length;
      let adjacent = 0;
      for (const [dx, dy] of DIRS) {
        for (const sign of [-1, 1]) {
          const nx = p.x + dx * sign, ny = p.y + dy * sign;
          if (inB(nx, ny) && b2[idx(nx, ny)] === opp) adjacent++;
        }
      }
      // 风险使用远大于局面评估的字典序权重：先消灭立即输/两手杀/成四点，
      // 再偏好贴住现有三连的直观堵点，最后才比较攻守兼备价值。
      const riskPenalty = immediate * 1e18 + forcedTwo * 1e15 + launches * 1e12;
      const priority = (urgency.get(p.y * SIZE + p.x) || 0) * 1e9;
      const s = priority + adjacent * 1e6 + evalBoardConn(b2, color) - riskPenalty;
      return { p, s };
    }).sort((a, b) => b.s - a.s);
    if (!scored.length) return null;
    if (!verify) return { x: scored[0].p.x, y: scored[0].p.y };
    return safeDefensePick(board, color, scored, scored[0].p);
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
  // v45.1: deep 模式跳过软启发式门(killInOne / 2b-SOFT / 2c), 强制走搜索
  //   上轮 v45 加入了 opts.deep, 但启发式门总是 return, 把搜索短路掉了 —
  //   benchmark 显示引擎很少真正跑搜索, deep 档浪费预算没回报。v45.1
  //   让 deep 档跳过这些门, 强制走搜索; 普通档行为不变(向后兼容)。
  // v46 Lazy SMP: workerId/jitterSeed 让多 worker 在搜索走法排序上分散 —
  //   getValuableMoves 用 jitterSeed 对候选段做 Fisher-Yates, dispatcher
  //   谈合后选全局最优。workerId=0(单跑/无 dispatcher) 不抖动, 保持确定。
  function computeBest(board, color, opts) {
    const computeStartedAt = performance.now();
    // v11.4: 跨请求重置杀手走法表 —— 引擎模块在 worker 里被缓存复用,
    // killers 不重置会让结果依赖请求历史(同一棋盘不同答案)。
    vct.resetKillers();
    _minmax.resetKillers();
    vct.resetHistory();
    _minmax.resetHistory();
    vct.resetCounterMove();
    _minmax.resetCounterMove();
    const workerId = (opts && typeof opts.workerId === 'number') ? opts.workerId : 0;
    const jitterSeed = (opts && typeof opts.jitterSeed === 'number')
      ? opts.jitterSeed >>> 0
      : 0;
    const skipHard = opts && opts.skipHardRules === true;
    // v45: 原生 deep 模式 —— 走 opts.deep=true, 深度预算大幅提升
    // (替代 hint-worker.cjs 的字符串替换 hack)。MAX_BUDGET 是 2^28,
    // 实际预算由 ONLY_THREE_THRESHOLD / move 生成层限制, 永不会触顶;
    // 保留 BUDGET throwable 用于边界保护(如递归异常时强制退出)。
    const isDeep = !!(opts && opts.deep === true);
    // v46 Lazy SMP: workerId=0(单跑/无 dispatcher) 不抖动, 保证确定
    const useJitter = isDeep && workerId > 0;
    const opp = other(color);

    // v45.1: 启发式候选缓存 —— 普通档在 1.5/2b-SOFT/2c 命中时立即返回;
    //   深档把这些点的启发式结果缓存, 用于搜索崩溃/无果时兜底(避免回退
    //   到完全不相关的 heuristicBest)。最终搜索结果 ≥ 启发式时优先用搜索。
    let heuristicPick = null;
    const setPick = (p) => { if (p && !heuristicPick) heuristicPick = p; };

    // v45.2: stoneCount 提前声明 —— 开局库 (在 2c 反推之前) 需要这个值,
    //   原版在搜索块才声明, 这里上移到启发式候选缓存旁边。
    let stoneCount = 0;
    for (let i = 0; i < board.length; i++) if (board[i] !== EMPTY) stoneCount++;

    // 1. 直接成五
    const wins = winPoints(board, color);
    if (wins.length) return wins[0];

    // 计算对手的"成五点"(下子即成五) —— winPoints 只看 n>=5
    const oppWins = winPoints(board, opp);

    // 2. 对手下一手成五 → 必堵(选堵点中对自己最好的)
    //   必先于 2b: 成五点比任何活四都紧迫(下一步就输)
    //   v45.1: 这一步 (硬性 1 步输) 在普通档 + 深档都立即返回 —— 1 步就输
    //   的局面不允许让搜索"看得更深"。
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

    // 3. 可证明的两手必胜优先于所有启发式/VCT。与旧 killInOne 的棋形近似
    // 不同，这里真实枚举双方成五点，不会把“看起来像双威胁”误报成必胜。
    const myForcedTwo = forcedWinInTwoPoints(board, color);
    if (myForcedTwo.length) {
      let best = myForcedTwo[0], bestScore = -Infinity;
      for (const p of myForcedTwo) {
        const b2 = board.slice();
        b2[idx(p.x, p.y)] = color;
        const score = p.replies * FIVE + evalBoardConn(b2, color);
        if (score > bestScore) { bestScore = score; best = p; }
      }
      return { x: best.x, y: best.y, value: FIVE, tactical: 'win-in-two' };
    }

    // 4. 对手若下一手能制造两个成五点，当前必须抢占该启动点。只有上面的
    // 己方立即/两手必胜可以合法反先；普通“做机会”不允许覆盖这个防守。
    const oppForcedTwo = forcedWinInTwoPoints(board, opp);
    if (oppForcedTwo.length) {
      let best = oppForcedTwo[0], bestScore = -Infinity;
      for (const p of oppForcedTwo) {
        const b2 = board.slice();
        b2[idx(p.x, p.y)] = color;
        const remaining = forcedWinInTwoPoints(b2, opp).length;
        const score = -remaining * MAX + evalBoardConn(b2, color);
        if (score > bestScore) { bestScore = score; best = p; }
      }
      return { x: best.x, y: best.y, tactical: 'block-win-in-two' };
    }

    // 5. 三连根节点安全层。旧结构只缓存堵点，随后仍允许主搜索覆盖；而且
    // 候选对象被误按数组读取，评分实际使用 undefined。现在统一做精确威胁
    // 枚举并立即返回，除非前面已经证明己方能在两手内获胜。
    const launches = fourLaunchPoints(board, opp);
    const establishedThree = establishedThreeBlocks(board, opp);
    if (establishedThree.length) {
      const cands = [...establishedThree, ...launches];
      const urgency = new Map();
      for (const p of establishedThree) {
        urgency.set(p.y * SIZE + p.x, 5);
      }
      for (const p of launches) {
        const k = p.y * SIZE + p.x;
        urgency.set(k, Math.max(urgency.get(k) || 0, 3 + Math.min(2, p.replies)));
      }
      const pick = chooseForcedDefense(board, color, cands, urgency);
      if (pick) return { ...pick, tactical: 'block-three-threat' };
    }

    // 跳三/多线局面仅凭一个成四点未必能挡住真正杀棋起点（实战中可能应
    // 先堵另一条集结线）。把精确成四点作为强引导，但仍让阶段 3 VCT 选择
    // 唯一安全防守；连续三连则已在上面无条件硬堵。
    if (launches.length) {
      const urgency = new Map(launches.map((p) => [p.y * SIZE + p.x, 3 + Math.min(2, p.replies)]));
      const pick = chooseForcedDefense(board, color, launches, urgency, false);
      if (pick) {
        setPick(pick);
        if (!isDeep) return { ...pick, tactical: 'block-four-launch' };
      }
    }

    // 尚未形成三连的“下一手双威胁”仍交给完整搜索验证。它只是潜在杀点，
    // 不能像已成形三连那样硬返回，否则会错过更深的唯一防守手。
    const double = oppDoubleThreatPoints(board, opp);
    if (double.length) {
      const urgency = new Map(double.map((p) => [p.y * SIZE + p.x, 2]));
      const pick = chooseForcedDefense(board, color, double, urgency, false);
      if (pick) {
        setPick(pick);
        if (!isDeep) return { ...pick, tactical: 'potential-defense' };
      }
    }

    // 己方近似一步杀仅作为搜索异常时的进攻兜底；它不再有权越过上面的
    // 对方三连安全层。
    const kill = killInOne(board, color);
    if (kill) {
      setPick(kill);
      if (!isDeep) return { x: kill.x, y: kill.y };
    }

    // v45.2: 开局定式库 —— 覆盖前 5 手常见定式 (~3KB 静态数据, 5 手内生效)
    //   旧版 (v11.7) 只处理"黑天元 + 白邻 + 黑 3"这一条线, 且硬编码 16 个
    //   dx,dy 表; 这里替换成静态 OPENING_BOOK 表 + 通用 boardKey() 编码:
    //   - 1-2 手: 黑白开局定式 (含原 16 种 + 黑非天元开局)
    //   - 3-5 手: 关键决策点的 B/W 推荐
    //   5 手之后落入深度 6/10 搜索。命中即返回 (与旧版语义一致),
    //   未命中继续走搜索 —— 完全是 ADDITIVE 行为。
    // v47.9: 深档跳过开局库 —— 用户要求每步相同深度思考, 开局也深算
    if (!isDeep && stoneCount >= 1 && stoneCount <= 5) {
      const blacks = [], whites = [];
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const v = board[idx(x, y)];
        if (v === BLACK) blacks.push([x, y]);
        else if (v === WHITE) whites.push([x, y]);
      }
      const cands = OPENING_BOOK[boardKey(blacks, whites)];
      if (cands) {
        for (const [x, y] of cands) {
          if (board[idx(x, y)] === EMPTY) return { x, y };
        }
      }
    }

    // 2c. 一步反推防守 (mumuy gobang 法):
    // 对手下步最优点如果威胁远超我方可选点 → 直接抢对手的点
    // (堵"潜在双威胁"比搜索更直接 —— 普通档预算小, 搜索内未必看到这个点)
    // v11.2: 深度档(skipHardRules)跳过 —— 深度档用满预算深算, 反推只信搜索结论
    // v47.3: 深档同样跳过 (v11.5 语义) —— 深档强制深算, 不需要启发式反推
    if (!skipHard && !isDeep) {
      const myBest = bestByEval(board, color);
      const oppBest = bestByEval(board, opp);
      if (oppBest.score > myBest.score + 4000 && oppBest.score !== -Infinity) {
        setPick({ x: oppBest.x, y: oppBest.y });
        if (!isDeep) return { x: oppBest.x, y: oppBest.y };
      }
    } // end skipHard(2c)
    // v11.2: 删除 5e6 启发式提前返回 —— 打分尺度下普通活三就超 5e6,
    // 该分支让 111 局面中 101 个 <30ms 直接返回, 搜索几乎从不运行,
    // 也看不见对手的 2-4 步强杀序列。双活三/冲四活三的采纳交给修复后的搜索。

    // 白 2 手兜底 (应对黑非中心开局) —— 白方贴近黑子, 找不到库时落入搜索
    //   v45.2: 这是 OPENING_BOOK 未命中时的 fallback, 让"黑开远端 + 白 2"的
    //   边角情况也有合理启发式 (贴邻而非跑搜索)。
    if (!isDeep && stoneCount === 1 && color === WHITE) {
      const stones = [];
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== EMPTY) stones.push([x, y, board[idx(x, y)]]);
      }
      const black = stones[0];
      if (black) {
        // 白 2: 贴黑子做活2/活3 基础, 距离黑子 1-2 格内
        const adj = [];
        for (let d = 1; d <= 2; d++) {
          for (const [dx, dy] of DIRS) {
            const nx = black[0] + dx * d, ny = black[1] + dy * d;
            if (inB(nx, ny) && board[idx(nx, ny)] === EMPTY) adj.push([nx, ny]);
          }
        }
        // 优先选斜邻(活2威胁)或正交邻(强活2)
        for (const [x, y] of adj) {
          if (Math.abs(x - black[0]) === 1 && Math.abs(y - black[1]) === 1) return { x, y };
        }
        for (const [x, y] of adj) {
          if (Math.abs(x - black[0]) + Math.abs(y - black[1]) === 1) return { x, y };
        }
        if (adj.length) return { x: adj[0][0], y: adj[0][1] };
      }
    }

    const searchBoard = board.slice();
    const evaluator = createEvaluator(searchBoard);
    evaluator.init();
    // lastMove 形参保留, 但当前 getValuableMoves.orderNear 实际用 distToNearestStone 排序
    // (历史遗留接口, 暂保留以兼容 v11.4 阶段 3 的 move 传参, 不再盲扫右下角)
    const lastMove = null;
    // 节点上限只作异常保护，实际由墙钟截止；budget.best 保留最后完整迭代。
    const MAX_BUDGET = 1 << 28;
    // v50: 14s 引擎硬预算 + 1s IPC/序列化余量，保证公网响应在 15s 内。
    // 预算从 computeBest 入口计时，前置棋形分析也计入总延迟。
    const DEEP_BUDGET_MS = 14000;
    const totalBudgetMs = isDeep ? DEEP_BUDGET_MS : 5000;
    const remainingBudgetMs = Math.max(50, totalBudgetMs - (performance.now() - computeStartedAt));
    const budget = {
      nodes: 0,
      maxNodes: isDeep ? MAX_BUDGET : (1 << 22),  // v45.1: 普通档 1.5s/400k → 5s/4M
      t0: performance.now(),
      maxMs: remainingBudgetMs,
      visited: null,
      best: null,
      // v46 Lazy SMP: jitterSeed 透传到 helper → getValuableMoves 尾段 Fisher-Yates
      jitterSeed: useJitter ? jitterSeed : 0,
    };
    // v45.2: depth 沿用 v11 参数化 (v45 普通 6, deep 10-12)
    // v47.6: deep 12 → 10 (用户指定)
    // v47.10: 深度统一 10 (用户指定)
    const depth = isDeep
      ? 12
      : (stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6));
    try {
      const res = minmaxSearch(evaluator, searchBoard, color, depth, budget, lastMove);
      if (res && res.move) {
        // v47: 透传 value/path —— dispatcher 谈合 (pickBest) 据此比较 worker
        //   间走法质量; 否则谈合协议只能拿到 workerId, 退化为确定性选 workerId=0
        const r = { x: res.move[0], y: res.move[1], value: res.value, path: res.path };
        return useJitter ? { ...r, jitterUsed: true } : r;
      }
    } catch (e) {
      if (e !== BUDGET) throw e;
    }
    // v11.2: 预算耗尽(阶段超时)或搜索无果, 但已有部分搜索结果 → 用它, 而非纯启发式
    if (budget.best && budget.best.move) {
        // v47: 同上, 预算截断后用 budget.best —— 必须带 value/path
      const r = { x: budget.best.move[0], y: budget.best.move[1], value: budget.best.value, path: budget.best.path };
      return useJitter ? { ...r, jitterUsed: true } : r;
    }

    // v45.1: 兜底 —— 搜索无果(无节点预算 / 完全没跑), 用启发式候选(若有)
    //   普通档不会到这里(前面的门已经 return), 深档可能到这里(跳过软门后
    //   搜索没产出, 比如过于复杂的局面)。
    if (heuristicPick) {
      return useJitter ? { ...heuristicPick, jitterUsed: true } : heuristicPick;
    }

    // 4. 启发式保底(做棋/防守, 预算超时或搜索无结果)
    const fallback = heuristicBest(board, color);
    return useJitter ? { ...fallback, jitterUsed: true } : fallback;
  }

  // v45.1: test hook —— 测试通过 __test__ 访问内部状态(evalBoard / stageDefRatio / 预算)。
  //   生产代码不应使用, 仅供测试。挂到模块导出上, 不污染 computeBest 签名。
  const __test__ = {
    evalBoard,            // 阶段化评估
    stageDefRatio,        // 阶段化 DEF_RATIO
    countForcing,         // 双活三威胁统计
    immediateWinningMoves: winPoints,
    forcedWinInTwoPoints,
    fourLaunchPoints,
    // runWithBudget —— 直接跑搜索并返回 budget 节点数, 不走启发式门。
    //   测试用它验证"深档真的跑了搜索"(节点数 > 0)。
    runWithBudget(board, color, opts) {
      const MAX_BUDGET = 1 << 28;
      const isDeep = !!(opts && opts.deep === true);
      const searchBoard = board.slice();
      const evaluator = createEvaluator(searchBoard);
      evaluator.init();
      const budget = {
        nodes: 0,
        maxNodes: (opts && opts.maxNodes) || (isDeep ? MAX_BUDGET : (1 << 22)),
        t0: performance.now(),
        maxMs: (opts && opts.maxMs) || (isDeep ? 14000 : 5000),
        visited: null,
        best: null,
      };
      let stoneCount = 0;
      for (let i = 0; i < board.length; i++) if (board[i] !== EMPTY) stoneCount++;
      const depth = (opts && opts.depth) || (isDeep
        ? 12
        : (stoneCount < 8 ? 2 : (stoneCount > 190 ? 4 : 6)));
      try {
        minmaxSearch(evaluator, searchBoard, color, depth, budget, null);
      } catch (e) {
        if (e !== BUDGET) throw e;
      }
      return { nodes: budget.nodes, best: budget.best, stageNodes: budget.stageNodes };
    },
    // v47.2: 评估钩子 —— 返回 (x,y) 落 color 后该点的搜索评估潜力分
    evalPoint(board, x, y, color) {
      const searchBoard = board.slice();
      const evaluator = createEvaluator(searchBoard);
      evaluator.init();
      return evaluator.pointScore(x, y, color);
    },
    // v47.4: 增量一致性钩子 —— 验证增量 hash/evaluate 与全盘重算一致
    incrementalConsistency(board) {
      const vb = board.slice();
      const ev = createEvaluator(vb);
      ev.init();
      const eqHash = () => {
        const h = boardHash(vb);
        const g = ev.hash();
        return g[0] === h[0] && g[1] === h[1];
      };
      let ok = eqHash();
      // 走 5 手 (找空位)
      const placed = [];
      for (let i = 0; i < 5; i++) {
        let done = false;
        for (let c = 0; c < vb.length && !done; c++) {
          if (vb[c] !== EMPTY) continue;
          const x = c % SIZE, y = Math.floor(c / SIZE);
          const role = (i % 2) + 1;
          ev.move(x, y, role);
          vb[c] = role;
          placed.push([x, y]);
          done = true;
        }
        if (!eqHash()) ok = false;
        // evaluate 增量 vs 全盘求和
        const e1 = ev.evaluate(1);
        let sum = 0;
        for (let c = 0; c < vb.length; c++) {
          if (vb[c] !== EMPTY) continue;
          sum += ev.pointScore(c % SIZE, Math.floor(c / SIZE), 1) - ev.pointScore(c % SIZE, Math.floor(c / SIZE), 2);
        }
        if (e1 !== Math.max(-(FIVE - 1), Math.min(FIVE - 1, sum))) ok = false;
      }
      // undo 全部后 hash 应复原
      for (const [x, y] of placed.reverse()) {
        ev.undo(x, y);
        vb[idx(x, y)] = EMPTY;
      }
      if (!eqHash()) ok = false;
      return ok;
    },
    // v47.1: 对手 color 是否有 VCT 强制杀 (阶段 3 防守校验同款搜索)
    // 预算内未确认杀返回 false (与阶段 3 语义一致: 宁可不堵也不乱堵)
    hasVCTKill(board, color, opts) {
      const MAX_BUDGET = 1 << 28;
      const maxMs = (opts && opts.maxMs) || 2500;
      const searchBoard = board.slice();
      const evaluator = createEvaluator(searchBoard);
      evaluator.init();
      const b = { nodes: 0, maxNodes: MAX_BUDGET, t0: performance.now(), maxMs, incOuter: null };
      try {
        const [value, move, path] = vct(evaluator, searchBoard, color, 18, 0, [], -MAX, MAX, b, new Map(), null, null);
        const kill = value >= FIVE;
        return (opts && opts.withPath) ? { kill, value, path, move } : kill;
      } catch (e) {
        if (e !== BUDGET) throw e;
        return (opts && opts.withPath) ? { kill: false, value: null, path: [], move: null } : false;
      }
    },
  };

  return { computeBest, __test__ };
});
