// 五子棋提示引擎 v4 — 威胁空间搜索 + 模式计数评估
//
// 理论依据 (Allis 1993 "Go-Moku Solved by New Search Techniques"):
//   - 五子棋的胜负由"强制威胁链"决定, 威胁空间搜索只搜这些链
//   - 冲四(VCF)是"绝对先手": 对方只能堵, 链可以全深度展开
//   - 活三/双威胁(VCT)推进: 制造"对方挡不住两个方向"的强制胜势
//   - 依赖原则: 新威胁必须与最后一步相关, 否则是独立威胁(可组合)
//
// v3 → v4 升级:
//   1. 转换表 (Zobrist 哈希 + 增量维护): 消除重复局面, 长链搜索不再烧预算
//   2. 预算分配: 每个候选走法独立预算(节点+时间), 搜索能在深度内完成,
//      而不是整棵树在深链完成前耗尽预算回退启发式 (v3 的根因)
//   3. 全局模式计数评估: 活四/冲四/活三/跳三/眠三/活二的精确计数加权,
//      替代局部 dirValue 打分, 稀疏局面的落子更像人类"经营多线"
//   4. 威胁阶梯完整实现: 成五 > 活四 > 冲四 > 活三 > 双威胁 > 眠三
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

  // 预算超限信号(威胁搜索内部抛出, computeBest 捕获后回退启发式)
  const BUDGET = Symbol('budget');

  // ---------- Zobrist 哈希 (确定性种子, 增量维护) ----------
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

  // ---------- 棋形扫描 ----------
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
      if (inB(e1x - dx, e1y - dy) && board[idx(e1x - dx, e1y - dy)] === color) jump++;
      if (inB(e2x + dx, e2y + dy) && board[idx(e2x + dx, e2y + dy)] === color) jump++;
    }
    return { n, open, jump };
  }

  // 方向威胁级别: 5=成五, 4=四连(活四/冲四/跳四), 3=活三/跳三, 2=活二, 0=无
  function dirThreat(board, x, y, dx, dy, color) {
    const { n, open, jump } = scanLine(board, x, y, dx, dy, color);
    if (n >= 5) return 5;
    if (n === 4 && open >= 1) return 4;
    if (n === 3 && open === 2) return 3;                     // 活三
    if (n === 3 && open === 1 && jump >= 1) return 3;        // 一端封但有跳子(近似跳三)
    if (open === 2 && jump >= 1 && n === 2) return 3;        // XX_X / X_XX 跳三
    if (n === 2 && open === 2) return 2;
    return 0;
  }

  // 落子 (x,y) 后: 威胁方向数与最高级别
  function threatDirs(board, x, y, color) {
    let count = 0, max = 0;
    for (const [dx, dy] of DIRS) {
      const l = dirThreat(board, x, y, dx, dy, color);
      if (l > max) max = l;
      if (l >= 3) count++;
    }
    return { count, max };
  }

  // ---------- 候选点 ----------
  // 所有棋子周围 2 格内的空位(五连点/四连点必然紧贴己方棋子, 2 格内足够)
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

  // 仅某色棋子周围的候选点
  function nearCellsOf(board, color) {
    const set = new Set();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (inB(nx, ny) && board[idx(nx, ny)] === EMPTY) set.add(ny * SIZE + nx);
          }
        }
      }
    }
    return [...set].map((i) => [i % SIZE, Math.floor(i / SIZE)]);
  }

  // 依赖原则的候选点: 中心(最近落子)附近某色棋子周围的空位。
  // Allis 论文: 威胁链上每步新威胁必须与上一步相关, 搜索只在局部展开。
  // center=null 时回退全盘。
  function cellsNear(board, color, center, r) {
    if (!center) return nearCellsOf(board, color);
    const R = r + 2;
    const x0 = Math.max(0, center.x - R), x1 = Math.min(SIZE - 1, center.x + R);
    const y0 = Math.max(0, center.y - R), y1 = Math.min(SIZE - 1, center.y + R);
    const set = new Set();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (inB(nx, ny) && board[idx(nx, ny)] === EMPTY) set.add(ny * SIZE + nx);
          }
        }
      }
    }
    return [...set].map((i) => [i % SIZE, Math.floor(i / SIZE)]);
  }

  // 成五点: 落子后直接五连(含跳四缺口)。center 限定时只搜依赖威胁(±3)
  function winPoints(board, color, center) {
    const out = [];
    for (const [x, y] of cellsNear(board, color, center, 2)) {
      if (center && Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) > 3) continue;
      for (const [dx, dy] of DIRS) {
        if (dirThreat(board, x, y, dx, dy, color) >= 5) { out.push({ x, y }); break; }
      }
    }
    return out;
  }

  // 四连点: 落子后形成四连(活四/冲四/跳四)。center 限定时只搜依赖威胁(±3)
  function fourPoints(board, color, center) {
    const out = [];
    for (const [x, y] of cellsNear(board, color, center, 2)) {
      if (center && Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) > 3) continue;
      for (const [dx, dy] of DIRS) {
        if (dirThreat(board, x, y, dx, dy, color) >= 4) { out.push({ x, y }); break; }
      }
    }
    return out;
  }

  // 棋盘上已有的四连(连续 4 子): 返回 'open'(活四, 挡不住) 或堵点列表。
  // center: 依赖原则 —— 对方刚形成的四连必然在最近落子附近, 局部扫描即可
  function existingFourBlocks(board, color, center) {
    const blocks = new Set();
    const [x0, x1] = center
      ? [Math.max(0, center.x - 4), Math.min(SIZE - 1, center.x + 4)]
      : [0, SIZE - 1];
    const [y0, y1] = center
      ? [Math.max(0, center.y - 4), Math.min(SIZE - 1, center.y + 4)]
      : [0, SIZE - 1];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && board[idx(px, py)] === color) continue; // 只从连续段起点扫
          let n = 0, cx = x, cy = y;
          while (inB(cx, cy) && board[idx(cx, cy)] === color) { n++; cx += dx; cy += dy; }
          if (n !== 4) continue;
          const o1 = inB(x - dx, y - dy) && board[idx(x - dx, y - dy)] === EMPTY;
          const o2 = inB(cx, cy) && board[idx(cx, cy)] === EMPTY;
          if (o1 && o2) return 'open';                       // 活四: 挡不住
          if (o1) blocks.add((y - dy) * SIZE + (x - dx));
          if (o2) blocks.add(cy * SIZE + cx);
        }
      }
    }
    return [...blocks].map((i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }));
  }

  // 棋盘上已有的活三(连续 3 子且两端开放): 返回堵点列表。
  // center: 同上, 局部扫描
  function liveThreeBlocks(board, color, center) {
    const blocks = new Set();
    const [x0, x1] = center
      ? [Math.max(0, center.x - 4), Math.min(SIZE - 1, center.x + 4)]
      : [0, SIZE - 1];
    const [y0, y1] = center
      ? [Math.max(0, center.y - 4), Math.min(SIZE - 1, center.y + 4)]
      : [0, SIZE - 1];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && board[idx(px, py)] === color) continue; // 只从连续段起点扫
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

  // ---------- 威胁棋 ----------
  // 落子后形成 >= 活三级威胁的点, 按威胁强度排序
  //   level 4 = 成四(活四 > 冲四 > 跳四), dbl = 双威胁(两个活三+), level 3 = 活三/跳三
  // center: 依赖原则 —— 只搜最近落子附近的威胁; null = 全盘(根节点)
  function threatMoves(board, color, center) {
    const out = [];
    for (const [x, y] of cellsNear(board, color, center, 2)) {
      if (center && Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) > 3) continue;
      const { count, max } = threatDirs(board, x, y, color);
      if (max >= 4) {
        // 区分活四(直接胜势)与冲四(强制链)
        let open = 0;
        for (const [dx, dy] of DIRS) {
          const s = scanLine(board, x, y, dx, dy, color);
          if (s.n === 4) open = Math.max(open, s.open);
        }
        out.push({ x, y, level: 4, s: open === 2 ? 4.6 : 4.3 + count * 0.01 });
      } else if (count >= 2 && max >= 3) {
        out.push({ x, y, level: 3, dbl: true, s: 3.7 + count * 0.01 });
      } else if (max >= 3) {
        out.push({ x, y, level: 3, s: 3.1 + count * 0.01 });
      }
    }
    out.sort((a, b) => b.s - a.s);
    return out;
  }

  // 对方回应集: 堵我方的四连/活三(必要) + 对方自己的反击(成四或双威胁), 按必要度排序。
  // center=null 时全盘(防守必须看到所有威胁); center 限定时只搜依赖威胁(进攻)
  function repliesOf(board, me, opp, center) {
    const map = new Map();
    const add = (x, y, d) => {
      const k = y * SIZE + x;
      if (!map.has(k) || d > map.get(k).d) map.set(k, { x, y, d });
    };
    for (const p of fourPoints(board, me, center)) add(p.x, p.y, 3);       // 必须堵我的四
    for (const p of liveThreeBlocks(board, me, center)) {
      if (center && Math.max(Math.abs(p.x - center.x), Math.abs(p.y - center.y)) > 2) continue;
      add(p.x, p.y, 2);                                                     // 必须堵我的活三
    }
    for (const m of threatMoves(board, opp)) {
      if (center && Math.max(Math.abs(m.x - center.x), Math.abs(m.y - center.y)) > 2) continue;
      if (m.level >= 4) add(m.x, m.y, 1);                                   // 对方可反杀
      else if (m.dbl) add(m.x, m.y, 0);                                     // 对方可双威胁
    }
    const arr = [...map.values()];
    arr.sort((a, b) => b.d - a.d);
    return arr.slice(0, 8);
  }

  // ---------- 威胁空间搜索 ----------
  // 交替攻防, 双方都只走"威胁棋"或被迫堵:
  //   - 对方刚形成四连 → 必堵(活四挡不住直接输)
  //   - 对方刚形成活三 → 必堵端点(不堵下步对方成活四/双威胁)
  //   - 无被迫应对 → 只能走威胁棋(成四 > 双威胁 > 活三), 且走完必须
  //     让对方有必须回应的威胁, 否则这手不算威胁棋
  // 返回 turn 能否强制获胜。预算超限抛出 BUDGET。
  // hash 为增量维护的 Zobrist 值; center 为最近落子(依赖原则, 局部搜索)。
  function threatWin(board, turn, depth, budget, hash, center) {
    if (++budget.nodes > budget.maxNodes) throw BUDGET;
    if (budget.t0 && performance.now() - budget.t0 > budget.maxMs) throw BUDGET;
    const opp = other(turn);

    // 转换表: 相同局面(含深度与轮次)只搜索一次
    const key = (hash + turn * 2654435761 + depth * 4101842887) >>> 0;
    const hit = budget.visited.get(key);
    if (hit !== undefined) return hit;

    let res;
    if (winPoints(board, turn, center).length) {
      res = true;                                    // 现在就能成五
    } else if (winPoints(board, opp, center).length) {
      res = false;                                   // 对方已成五
    } else {
      // 被迫应对: 先堵对方刚形成的四连, 再堵活三(局部扫描, 必在上一步附近)
      const oppFours = existingFourBlocks(board, opp, center);
      if (oppFours === 'open') {
        res = false;                                 // 对方活四, 挡不住
      } else {
        const oppThrees = oppFours.length ? [] : liveThreeBlocks(board, opp, center);
        const moves = oppFours.length ? oppFours : (oppThrees.length ? oppThrees : null);
        let free = null;
        if (!moves) {
          const tms = threatMoves(board, turn, center);
          free = tms.filter((m) => m.level >= 4 || m.dbl || depth > 4).slice(0, 4);
        }
        if (!moves && !free) {
          res = false;
        } else {
          res = false;
          for (const m of moves || free) {
            board[idx(m.x, m.y)] = turn;
            const h2 = (hash ^ zOf(idx(m.x, m.y), turn)) >>> 0;
            const mc = { x: m.x, y: m.y };
            let oppSurvives = false;
            if (free) {
              // 自由威胁棋: 必须让对方有必须回应的威胁。
              // 依赖原则只限制进攻方(新威胁贴近自己的上一步);
              // 防守候选必须全盘(对手的威胁可以在任何地方)。
              const replies = repliesOf(board, turn, opp, null);
              if (replies.length && depth > 1) {
                for (const r of replies) {
                  board[idx(r.x, r.y)] = opp;
                  let inner;
                  try {
                    inner = threatWin(board, turn, depth - 1, budget, (h2 ^ zOf(idx(r.x, r.y), opp)) >>> 0, mc);
                  } catch (e) {
                    board[idx(r.x, r.y)] = EMPTY;
                    board[idx(m.x, m.y)] = EMPTY;
                    throw e;
                  }
                  board[idx(r.x, r.y)] = EMPTY;
                  if (!inner) { oppSurvives = true; break; }   // 对方找到活路
                }
              } else {
                oppSurvives = true;                  // 深度到头或没造出威胁
              }
              board[idx(m.x, m.y)] = EMPTY;
            } else {
              // 被迫堵: 堵完让对方走; 对方还能强制赢则本手失败
              let inner;
              try {
                inner = threatWin(board, opp, depth - 1, budget, h2, mc);
              } catch (e) {
                board[idx(m.x, m.y)] = EMPTY;
                throw e;
              }
              board[idx(m.x, m.y)] = EMPTY;
              if (!inner) oppSurvives = true;
            }
            if (!oppSurvives) { res = true; break; } // 这个走法对方怎么都挡不住
          }
        }
      }
    }
    if (budget.visited.size < 4000) budget.visited.set(key, res);
    return res;
  }

  // 找强制胜的第一手: 候选威胁棋 → 对方所有必要回应 → 都能强制赢 → 返回该手。
  // 节点预算按候选重置: 每个候选有完整的搜索树预算, 第一个候选耗尽
  // 预算不会饿死后面可能藏着必胜手的候选; 时间预算全局共享, 总耗时受控。
  // 候选宽度 8 → 5 (Allis: 黑方只取 N 个最优威胁, 提高搜索深度)
  function forcingMove(board, me, budget, rootHash) {
    const opp = other(me);
    const cands = threatMoves(board, me, null).slice(0, 5);
    for (const m of cands) {
      const b = {
        nodes: 0,
        maxNodes: budget.maxNodes,
        t0: budget.t0,
        maxMs: budget.maxMs,
        visited: budget.visited, // 转换表跨候选共享(局面重叠时白赚)
      };
      board[idx(m.x, m.y)] = me;
      const h2 = (rootHash ^ zOf(idx(m.x, m.y), me)) >>> 0;
      const mc = { x: m.x, y: m.y };
      const replies = repliesOf(board, me, opp, mc);
      let wins = true;
      for (const r of replies) {
        board[idx(r.x, r.y)] = opp;
        let res;
        try {
          res = threatWin(board, me, m.level >= 4 ? 26 : 12, b, (h2 ^ zOf(idx(r.x, r.y), opp)) >>> 0, mc);
        } catch (e) {
          board[idx(r.x, r.y)] = EMPTY;
          board[idx(m.x, m.y)] = EMPTY;
          throw e;
        }
        board[idx(r.x, r.y)] = EMPTY;
        if (!res) { wins = false; break; }
      }
      board[idx(m.x, m.y)] = EMPTY;
      if (wins && replies.length) return { x: m.x, y: m.y };
    }
    return null;
  }

  // 防守: 对方有强制胜, 找一手棋让对方的强制胜失效(化解其威胁或自己更快)
  function parry(board, me, opp, budget, rootHash) {
    // 化解点 = 对方的威胁点(四连点/活三跳三延伸点) + 我方的反击点
    const threats = new Map();
    for (const p of fourPoints(board, opp)) {
      threats.set(p.y * SIZE + p.x, { x: p.x, y: p.y });
    }
    for (const m of threatMoves(board, opp)) {
      if (m.level >= 3) {
        const k = m.y * SIZE + m.x;
        if (!threats.has(k)) threats.set(k, { x: m.x, y: m.y });
      }
    }
    for (const m of threatMoves(board, me)) {
      const k = m.y * SIZE + m.x;
      if (!threats.has(k)) threats.set(k, { x: m.x, y: m.y });
    }
    const cands = [...threats.values()].slice(0, 12);

    for (const c of cands) {
      board[idx(c.x, c.y)] = me;
      const h2 = (rootHash ^ zOf(idx(c.x, c.y), me)) >>> 0;
      const mc = { x: c.x, y: c.y };
      const oppWins = winPoints(board, opp, mc);
      let ok = oppWins.length === 0;
      if (ok) {
        try {
          ok = !threatWin(board, opp, 8, budget, h2, mc);  // 对方还能强制胜吗?
        } catch (e) {
          board[idx(c.x, c.y)] = EMPTY;
          throw e;
        }
      }
      board[idx(c.x, c.y)] = EMPTY;
      if (ok) return { x: c.x, y: c.y };
    }
    return null;
  }

  // ---------- 全局模式评估 ----------
  // 扫描棋盘上某色的所有棋段, 精确计数模式。
  // 这是"局面评估"而非"落点评分" —— 捕捉多线经营、威胁密度等全局性质。
  function patternCounts(board, color) {
    const c = { five: 0, open4: 0, rush4: 0, live3: 0, jump3: 0, sleep3: 0, live2: 0 };
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (board[idx(x, y)] !== color) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && board[idx(px, py)] === color) continue; // 只从段起点扫
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
            if (open >= 1 && (jump1 || jump2)) c.jump3++;   // XX_X / X_XX 跳三
          }
          // 注意: 孤子+隔一格有己方子 (X_X) 只是跳二, 不是跳三, 不计入 jump3
        }
      }
    }
    return c;
  }

  // 模式权重: 按威胁阶梯递减。防守侧略重(1.05), 因为漏防比漏攻致命。
  const PW = { five: 1e9, open4: 5e8, rush4: 1e8, live3: 2e6, jump3: 3e5, sleep3: 3e4, live2: 8e3 };
  function evalBoard(board, color) {
    const mc = patternCounts(board, color);
    const mo = patternCounts(board, other(color));
    let s = 0;
    for (const k in PW) s += PW[k] * (mc[k] - mo[k] * 1.05);
    return s;
  }

  // 对手"落子即成活四/冲四"的点(必要防守的候选)
  function oppOpenFourPoints(board, opp) {
    const pts = new Set();
    for (const [x, y] of nearCellsOf(board, opp)) {
      for (const [dx, dy] of DIRS) {
        const s = scanLine(board, x, y, dx, dy, opp);
        if (s.n === 4 && s.open === 2) { pts.add(y * SIZE + x); break; }
      }
    }
    return [...pts].map((i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) }));
  }

  // 对手"落子即形成双威胁"(双活三/活三+冲四等)的点 —— 必争点。
  // 对手在这里落子后, 我方只能堵一个方向, 必输; 必须自己占住或提前化解。
  function oppDoubleThreatPoints(board, opp) {
    const pts = [];
    for (const m of threatMoves(board, opp, null)) {
      if (m.dbl) pts.push({ x: m.x, y: m.y });
    }
    return pts;
  }

  // ---------- 启发式保底(全局模式评估) ----------
  function heuristicBest(board, color) {
    const opp = other(color);

    // 硬性防守 1: 对手存在"落子即成活四"的点 → 必须堵, 否则对方下一手必胜
    const urgent = oppOpenFourPoints(board, opp);
    // 硬性防守 2: 对手存在"落子即形成双威胁"的点 → 必争(堵不住, 只能占住)
    const double = oppDoubleThreatPoints(board, opp);
    if (urgent.length || double.length) {
      const cands = [...urgent, ...double];
      let best = cands[0], bestScore = -Infinity;
      for (const b of cands) {
        const b2 = board.slice();
        b2[idx(b.x, b.y)] = color;
        let s = evalBoard(b2, color);
        if (s > bestScore) { bestScore = s; best = b; }
      }
      return { x: best.x, y: best.y };
    }

    // 对手活三 → 必要防守, 只在堵点里选(带自己威胁的堵点优先)
    const oppLive3 = liveThreeBlocks(board, opp);
    const cands = oppLive3.length ? oppLive3 : nearCells(board);

    let best = null, bestScore = -Infinity;
    for (const [x, y] of cands) {
      const b2 = board.slice();
      b2[idx(x, y)] = color;
      let s = evalBoard(b2, color);

      // 做势奖励: 落子后形成 >=2 个活二级方向, 是双活三的伏笔。
      // 奖励弱于真活三(live3 权重 2e6): 双活二只是"潜在", 活三才是"必应"
      let d2 = 0;
      for (const [dx, dy] of DIRS) {
        const l = dirThreat(b2, x, y, dx, dy, color);
        if (l >= 2) d2++;
      }
      if (d2 >= 2 && s < PW.live3 * 4) s += 4e5;

      // 落子后对手能直接成五 → 重罚(不下送死的棋)
      if (winPoints(b2, opp).length) s -= 1e10;

      // 中心偏好(弱, 只在稀疏局面起作用)
      s += (7 - Math.max(Math.abs(x - 7), Math.abs(y - 7))) * 200;

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
        const s = evalBoard(b2, color);
        if (s > bestScore) { bestScore = s; best = b; }
      }
      return { x: best.x, y: best.y };
    }

    const rootHash = boardHash(board);
    const t0 = performance.now();

    // 只有存在"高水平威胁"(成四/双威胁)候选时才值得全深度强制搜索;
    // 全是活三级候选的局面, 深度搜索大概率烧预算却找不到必胜手。
    // VCF(有冲四候选, 分支小, 强制链可全深度)与 VCT(双威胁试探)分开预算:
    // VCT 试探预算小, 快速失败回到启发式 —— 提示引擎要快。
    const myThreats = threatMoves(board, color, null);
    const oppThreats = threatMoves(board, opp, null);
    const myHasFour = myThreats.some((m) => m.level >= 4);
    const oppHasFour = oppThreats.some((m) => m.level >= 4);
    const hasHighThreat = (arr) => arr.some((m) => m.level >= 4 || m.dbl);
    const cheap = !hasHighThreat(myThreats) && !hasHighThreat(oppThreats);

    // 3. 我方强制胜搜索
    if (!cheap && (myHasFour || hasHighThreat(myThreats))) {
      try {
        const budget = {
          nodes: 0,
          maxNodes: myHasFour ? 90000 : 40000,
          t0: performance.now(),
          maxMs: myHasFour ? 120 : 70,
          visited: new Map(),
        };
        const fm = forcingMove(board, color, budget, rootHash);
        if (fm) return fm;
      } catch (e) {
        if (e !== BUDGET) throw e;
      }
    }

    // 4. 对方强制胜 → 防守(化解其威胁)
    if (!cheap && oppHasFour) {
      try {
        const budget = { nodes: 0, maxNodes: 60000, t0: performance.now(), maxMs: 90, visited: new Map() };
        const oppFm = forcingMove(board, opp, budget, rootHash);
        if (oppFm) {
          const pb = { nodes: 0, maxNodes: 40000, t0: performance.now(), maxMs: 80, visited: new Map() };
          const d = parry(board, color, opp, pb, rootHash);
          if (d) return d;
          // 找不到完美防守, 至少堵住对方强制胜的第一手威胁
          const firstThreat = threatMoves(board, opp)[0];
          if (firstThreat) return { x: firstThreat.x, y: firstThreat.y };
        }
      } catch (e) {
        if (e !== BUDGET) throw e;
      }
    }

    // 5. 启发式保底(全局模式评估)
    return heuristicBest(board, color);
  }

  return { computeBest };
});
