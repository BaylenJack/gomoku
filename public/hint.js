// 五子棋提示引擎 v2 — 纯本地计算, 不发送任何数据到服务器
//
// v2 相对 v1 的升级:
//   1. 跳子识别: 能识别 XX_X / X_XX 这类跳三, 以及跳四 —— v1 完全看不到这些威胁
//   2. 双威胁(双三/活三+冲四)检测: 会主动制造对手只能挡一个的局面
//   3. 威胁优先级: 己方成五 > 堵对手成五 > 己方活四 > 堵对手活四 > 双威胁 > 前瞻
//   4. 两层前瞻 + 对"对手反杀"的惩罚
//
// 隐私: 只在浏览器本地运行, 结果只画在本地 canvas, 不经 WebSocket。

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

  // ---------- 方向扫描 ----------
  // 在 (x,y) 放置 color 后, 沿 (dx,dy) 方向的棋形:
  //   n    = 连续段长度
  //   open = 连续段两端中为空的数量
  //   jump = 连续段外"隔一格空再有一子"的数量(跳子结构)
  function scanLine(board, x, y, dx, dy, color) {
    let n1 = 0;
    for (let p = 1; p < 5; p++) {
      const nx = x - dx * p, ny = y - dy * p;
      if (!inB(nx, ny)) break;
      if (board[idx(nx, ny)] === color) n1++;
      else break;
    }
    let n2 = 0;
    for (let p = 1; p < 5; p++) {
      const nx = x + dx * p, ny = y + dy * p;
      if (!inB(nx, ny)) break;
      if (board[idx(nx, ny)] === color) n2++;
      else break;
    }
    const n = n1 + 1 + n2;
    const e1x = x - dx * (n1 + 1), e1y = y - dy * (n1 + 1);
    const e2x = x + dx * (n2 + 1), e2y = y + dy * (n2 + 1);
    let open = 0;
    if (inB(e1x, e1y) && board[idx(e1x, e1y)] === EMPTY) open++;
    if (inB(e2x, e2y) && board[idx(e2x, e2y)] === EMPTY) open++;
    let jump = 0;
    if (open > 0) {
      const j1x = e1x - dx, j1y = e1y - dy;
      const j2x = e2x + dx, j2y = e2y + dy;
      if (inB(j1x, j1y) && board[idx(j1x, j1y)] === color) jump++;
      if (inB(j2x, j2y) && board[idx(j2x, j2y)] === color) jump++;
    }
    return { n: Math.min(n, 5), open, jump };
  }

  // 连续段基础分
  function baseScore(n, open) {
    if (n >= 5) return 10000000;                 // 成五
    if (n === 4) return open === 2 ? 600000 : (open === 1 ? 60000 : 100);
    if (n === 3) return open === 2 ? 20000 : (open === 1 ? 1500 : 20);
    if (n === 2) return open === 2 ? 600 : (open === 1 ? 60 : 5);
    return open >= 1 ? 8 : 0;
  }

  // 方向总价值(含跳子修正)
  function dirValue(board, x, y, dx, dy, color) {
    const { n, open, jump } = scanLine(board, x, y, dx, dy, color);
    let s = baseScore(n, open);
    if (jump >= 1) {
      if (n === 3 && open >= 1) s = Math.max(s, 16000);  // 跳三 ≈ 活三威胁
      if (n === 2 && open >= 1) s = Math.max(s, 700);    // 跳二
      if (n === 1 && open >= 1) s = Math.max(s, 120);
    }
    return s;
  }

  // 落子价值: 进攻(己方) + 防守(对方落此的威胁)
  function evaluate(board, x, y, color) {
    let atk = 0;
    for (const [dx, dy] of DIRS) atk += dirValue(board, x, y, dx, dy, color);
    let def = 0;
    const opp = other(color);
    for (const [dx, dy] of DIRS) def += dirValue(board, x, y, dx, dy, opp);
    return { atk, def, total: atk + def * 0.6, win: atk >= 10000000 };
  }

  // 落子后形成的"活三及以上"方向数 —— 双威胁检测的基础
  function threatCount(board, x, y, color) {
    let c = 0;
    for (const [dx, dy] of DIRS) {
      if (dirValue(board, x, y, dx, dy, color) >= 16000) c++;
    }
    return c;
  }

  // 候选点: 有子位置周围 2 格内的空位
  function candidates(board) {
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
    if (!any) return [[7, 7]];
    return [...set].map((i) => [i % SIZE, Math.floor(i / SIZE)]);
  }

  /**
   * 计算最佳落点
   * @param {number[]} board 扁平 15x15 棋盘
   * @param {number} color BLACK=1 | WHITE=2
   * @returns {{x:number, y:number}}
   */
  function computeBest(board, color) {
    const opp = other(color);
    const t0 = performance.now();
    const cands = candidates(board);
    if (cands.length === 1) return { x: 7, y: 7 };

    const scored = cands.map(([x, y]) => {
      const e = evaluate(board, x, y, color);
      // 双活二伏笔: 落子后形成 >=2 个活二级方向, 下步可成双活三
      // 直接计入总分, 让这类点能进入前瞻候选池
      const b2 = board.slice();
      b2[idx(x, y)] = color;
      let d2 = 0;
      for (const [dx, dy] of DIRS) {
        if (dirValue(b2, x, y, dx, dy, color) >= 60) d2++;
      }
      const double2Bonus = d2 >= 2 && e.atk < 20000 ? 30000 : 0;
      return { x, y, atk: e.atk, def: e.def, win: e.win, total: e.total + double2Bonus };
    });

    // 1. 直接成五
    for (const s of scored) if (s.win) return { x: s.x, y: s.y };

    // 2. 对手下一手成五 → 必须堵
    for (const s of scored) if (s.def >= 10000000) return { x: s.x, y: s.y };

    // 3. 己方活四 → 走(对手只能挡, 挡了也挡不住下一手)
    for (const s of scored) if (s.atk >= 600000) return { x: s.x, y: s.y };

    // 4. 对手活四 → 堵
    for (const s of scored) if (s.def >= 600000) return { x: s.x, y: s.y };

    // 5. 前瞻: 双威胁 + 对手反杀惩罚
    scored.sort((a, b) => b.total - a.total);
    const top = scored.slice(0, 18);

    let best = top[0], bestVal = -Infinity;
    for (const t of top) {
      if (performance.now() - t0 > 600) break; // 时间预算, 不卡浏览器

      const b2 = board.slice();
      b2[idx(t.x, t.y)] = color;

      // 己方双威胁: 对手一步只能挡一个方向
      const myThreats = threatCount(b2, t.x, t.y, color);

      // 对手最佳应对
      let oppBest = -Infinity;
      let oppCounterWin = false;
      let oppCounterLive4 = false;
      const oppCands = candidates(b2);
      const limit = Math.min(oppCands.length, 40);
      for (let i = 0; i < limit; i++) {
        const [ox, oy] = oppCands[i];
        const e = evaluate(b2, ox, oy, opp);
        if (e.win) oppCounterWin = true;
        if (e.atk >= 600000) oppCounterLive4 = true;
        if (e.total > oppBest) oppBest = e.total;
      }

      // 己方形成活四/冲四或活三 → 对手必须应对, 主动权价值不该被对手威胁惩罚
      // 注: atk >= 20000 表示活三及以上; atk >= 600000 表示活四/冲四
      const myForcing = t.atk >= 20000 || myThreats >= 2;
      let v = myForcing ? t.atk + 100000 : t.total - oppBest * 0.4;

      // 双活二价值: 下步可成双活三(对手挡不住), 是重要伏笔
      // 判断: 落子后形成 >=2 个"活二级"(>=600)的方向
      let myDouble2 = 0;
      for (const [dx, dy] of DIRS) {
        if (dirValue(b2, t.x, t.y, dx, dy, color) >= 600) myDouble2++;
      }
      if (myDouble2 >= 2 && t.atk < 20000) v += 30000;

      if (oppCounterWin) v -= 500000;      // 给了对手直接反杀 → 重罚
      if (oppCounterLive4) v -= 80000;

      if (v > bestVal) { bestVal = v; best = t; }
    }
    return { x: best.x, y: best.y };
  }

  return { computeBest };
});
