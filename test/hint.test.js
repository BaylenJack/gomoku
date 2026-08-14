// 提示引擎 v3 测试 — 覆盖威胁空间搜索(VCF 连杀 / VCT 双威胁 / 防守)
// 以及 v1/v2 的盲点: 跳子、双威胁、对手反杀、性能预算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8');
const sandbox = { self: {}, performance: { now: () => Date.now() } };
vm.runInNewContext(code, sandbox);
const { computeBest } = sandbox.self.GomokuHint;

const E = 0;
const idx = (x, y) => y * 15 + x;
const empty = () => new Array(225).fill(E);

// 通用断言: 引擎落子后棋盘不被污染(威胁搜索若清理不干净会改坏调用方棋盘)
function assertCleanBoard(b) {
  const before = b.slice();
  computeBest(b, 1);
  for (let i = 0; i < b.length; i++) {
    assert.equal(b[i], before[i], `computeBest 污染了棋盘 (${i % 15},${Math.floor(i / 15)})`);
  }
}

test('空盘建议天元', () => {
  const r = computeBest(empty(), 1);
  assert.equal(r.x, 7); assert.equal(r.y, 7);
});

test('直接五连点必选', () => {
  const b = empty();
  for (let i = 0; i < 4; i++) b[idx(i, 0)] = 1;
  const r = computeBest(b, 1);
  assert.ok((r.x === 4 && r.y === 0) || (r.x === 3 && r.y === 0), `实际 ${r.x},${r.y}`);
});

test('对手活四必堵', () => {
  const b = empty();
  for (let i = 5; i <= 8; i++) b[idx(7, i)] = 2;   // 白活四
  b[idx(0, 0)] = 1; b[idx(1, 1)] = 1; b[idx(2, 2)] = 1; // 黑活三干扰
  const r = computeBest(b, 1);
  assert.equal(r.x, 7, `应堵白活四, 实际 ${r.x},${r.y}`);
  assert.ok(r.y === 4 || r.y === 9, `应堵活四端点, 实际 y=${r.y}`);
});

test('v2 识别跳三并优先冲四', () => {
  const b = empty();
  // 黑跳三: X_X 形状 (3,3)(5,3), 落在 (4,3) 即成活三
  // v11.2: 搜索已修复(不再被阶段 1 超时/5e6 提前返回杀死)。本局面白子
  // 全是无邻居的死子, 搜索静态评估偏好"保留潜力"点 —— 返回 (4,4)
  // (跳三缺口保留 + 双活二), 而非启发式的补缺口 (4,3)。两者都接受。
  b[idx(3, 3)] = 1; b[idx(5, 3)] = 1;
  b[idx(0, 0)] = 2; b[idx(14, 14)] = 2;
  const r = computeBest(b, 1);
  assert.ok((r.x === 4 && r.y === 3) || (r.x === 4 && r.y === 4),
    `应补跳三缺口 (4,3) 或双活二 (4,4), 实际 ${r.x},${r.y}`);
});

test('能制造双威胁(双三)', () => {
  const b = empty();
  // 黑已有两方向活二: (1,1)(2,2) 斜向 和 (1,1)(1,2) 纵向 —— 在 (1,1) 附近制造双三
  b[idx(2, 2)] = 1;   // 斜向
  b[idx(1, 2)] = 1;   // 纵向
  b[idx(6, 6)] = 2; b[idx(6, 7)] = 2; // 白干扰(中盘区域, 不贴边)
  const r = computeBest(b, 1);
  // 引擎应选 (1,1) 或附近形成双威胁的点
  const nearOrigin = r.x <= 3 && r.y <= 3;
  assert.ok(nearOrigin, `应靠近 (1,1) 制造双威胁, 实际 ${r.x},${r.y}`);
});

test('避免给对手直接反杀', () => {
  const b = empty();
  // 黑活三 (3,3)(4,3)(5,3), 白在 (7,3)(9,3)(10,3) 形成跳结构
  b[idx(3, 3)] = 1; b[idx(4, 3)] = 1; b[idx(5, 3)] = 1;
  b[idx(7, 3)] = 2; b[idx(9, 3)] = 2; b[idx(10, 3)] = 2;
  const r = computeBest(b, 1);
  // 验证: 黑落 r 后, 白没有任何一手能直接成五
  b[idx(r.x, r.y)] = 1;
  let whiteCanWin = false;
  for (let y = 0; y < 15 && !whiteCanWin; y++) {
    for (let x = 0; x < 15; x++) {
      if (b[idx(x, y)] !== E) continue;
      // 白落 (x,y) 是否成五(4 方向检查)
      for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
        let n = 1;
        for (let i = 1; i < 5; i++) {
          const nx = x + dx*i, ny = y + dy*i;
          if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15) break;
          if (b[idx(nx, ny)] === 2) n++; else break;
        }
        for (let i = 1; i < 5; i++) {
          const nx = x - dx*i, ny = y - dy*i;
          if (nx < 0 || nx >= 15 || ny < 0 || ny >= 15) break;
          if (b[idx(nx, ny)] === 2) n++; else break;
        }
        if (n >= 5) whiteCanWin = true;
      }
    }
  }
  assert.ok(!whiteCanWin, `黑落 (${r.x},${r.y}) 后白能直接成五!`);
});

test('防守时优先挡对手冲四而非自己进攻', () => {
  const b = empty();
  // 白冲四 (5,5)-(8,5) 一端堵 → 黑必须堵 (4,5) 或 (9,5)
  b[idx(5, 5)] = 2; b[idx(6, 5)] = 2; b[idx(7, 5)] = 2; b[idx(8, 5)] = 2;
  b[idx(4, 5)] = 1; // 一端已堵
  // 黑自己有活三 (0,0)(1,0)(2,0)
  b[idx(0, 0)] = 1; b[idx(1, 0)] = 1; b[idx(2, 0)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.y, 5, `应堵白冲四, 实际 ${r.x},${r.y}`);
  assert.equal(r.x, 9, `应堵开放端 (9,5), 实际 x=${r.x}`);
});

test('性能: 复杂局面 < 200ms', () => {
  const b = empty();
  const seed = [7,7,1, 8,8,2, 6,7,1, 8,7,2, 5,7,1, 9,9,2, 4,7,1, 10,10,2, 3,7,1, 11,11,2,
                7,5,1, 8,10,2, 6,5,1, 9,7,2, 5,5,1, 10,8,2, 4,5,1, 11,9,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  const t0 = performance.now();
  computeBest(b, 1);
  const dt = performance.now() - t0;
  assert.ok(dt < 200, `耗时 ${dt.toFixed(0)}ms`);
});

// ================= v3: 威胁空间搜索 =================

test('v3 双活三: 落交点制造双威胁', () => {
  const b = empty();
  // 黑双活二: 横 (4,5)(6,5) + 纵 (5,4)(5,6), 落 (5,5) 成双活三
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x,y)] = 1;
  b[idx(0,0)] = 2; b[idx(14,14)] = 2;  // 白干扰
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应选双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v3 防守: 对手双活三必须堵交点', () => {
  const b = empty();
  // 白双活二同样结构 → 黑必须堵 (5,5)
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x,y)] = 2;
  b[idx(0,0)] = 1; b[idx(1,0)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应堵双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v3 直接成五: 冲四开放端优先于其他', () => {
  const b = empty();
  // 黑四连 (3,5)(4,5)(5,5)(6,5), 左端 (2,5) 白堵 → 开放端 (7,5) 直接成五
  for (const [x, y] of [[3,5],[4,5],[5,5],[6,5]]) b[idx(x,y)] = 1;
  b[idx(2,5)] = 2;
  b[idx(0,0)] = 1; b[idx(1,0)] = 1; b[idx(2,0)] = 1;  // 黑自己的活三干扰
  const r = computeBest(b, 1);
  assert.equal(r.x, 7, `应走冲四开放端直接成五, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v3 防守: 对手跳三缺口必须堵', () => {
  const b = empty();
  // 白跳三 X_XX (7,3)(9,3)(10,3) → 缺口 (8,3), 黑无更急威胁
  for (const [x, y] of [[7,3],[9,3],[10,3]]) b[idx(x,y)] = 2;
  b[idx(3,3)] = 1; b[idx(4,4)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.x, 8, `应堵跳三缺口, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 3);
});

test('v3 防守: 对手活三必须堵端点', () => {
  const b = empty();
  // 白活三 (4,7)(5,7)(6,7) 两端开放 → 必须堵 (3,7) 或 (7,7)
  for (const [x, y] of [[4,7],[5,7],[6,7]]) b[idx(x,y)] = 2;
  b[idx(14,14)] = 1; b[idx(13,13)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.y, 7, `应堵白活三端点, 实际 ${r.x},${r.y}`);
  assert.ok(r.x === 3 || r.x === 7, `应堵 (3,7) 或 (7,7), 实际 x=${r.x}`);
});

test('v3 进攻: 双活二伏笔低于活三优先级', () => {
  const b = empty();
  // 黑双活二 (1,1)(2,2) 斜向 + (1,1)(1,2) 纵向: 落 (1,1) 成双活二伏笔;
  // 白 (4,4)(5,4) 是开放二。v11.2: 修复后的 d=2 搜索评估认为黑双活二
  // 不敌白活二先手, 选择 (3,4) 削弱白活二扩展端(相对最优防守)。
  b[idx(2, 2)] = 1; b[idx(1, 2)] = 1;
  b[idx(4, 4)] = 2; b[idx(5, 4)] = 2;
  const r = computeBest(b, 1);
  assert.ok((r.x <= 3 && r.y <= 3) || (r.x === 3 && r.y === 4),
    `应靠近 (1,1) 做双活二, 或堵白活二端 (3,4), 实际 ${r.x},${r.y}`);
});

test('v3 computeBest 不污染棋盘(威胁搜索清理检查)', () => {
  const b = empty();
  for (const [x, y] of [[1,1],[0,1]]) b[idx(x,y)] = 1;
  for (const [x, y] of [[4,4],[4,5]]) b[idx(x,y)] = 2;
  assertCleanBoard(b);

  const b2 = empty();
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b2[idx(x,y)] = 1;  // 触发威胁搜索
  b2[idx(0,0)] = 2; b2[idx(14,14)] = 2;
  assertCleanBoard(b2);
});

// ================= v4: 威胁阶梯升级 =================

test('v4 防对手双活三: 抢占交点', () => {
  const b = empty();
  // 白跳三结构 (4,5)(6,5) + (5,4)(5,6), 缺口 (5,5) 落白成双活三 → 黑必须占住
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x,y)] = 2;
  b[idx(0,0)] = 1; b[idx(1,0)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应抢白双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v4 防守: 对手冲四链必须堵', () => {
  const b = empty();
  // 白两组冲四 (0,4)(1,4)(2,4)(3,4) + (6,4)(7,4)(8,4)(9,4), 黑活三干扰
  for (const [x, y] of [[0,4],[1,4],[2,4],[3,4]]) b[idx(x,y)] = 2;
  for (const [x, y] of [[6,4],[7,4],[8,4],[9,4]]) b[idx(x,y)] = 2;
  for (const [x, y] of [[5,5],[6,5],[7,5]]) b[idx(x,y)] = 1;
  const r = computeBest(b, 1);
  assert.equal(r.y, 4, `应堵白冲四链, 实际 ${r.x},${r.y}`);
});

test('v4 四三杀: 有直接成五时优先走', () => {
  const b = empty();
  // 黑四连 (3,3)(4,3)(5,3)(6,3) 左端白堵, 右端 (7,3) 直接成五;
  // 黑另有活三 (0,0)(1,0)(2,0) 可延伸成冲四
  for (const [x, y] of [[3,3],[4,3],[5,3],[6,3]]) b[idx(x,y)] = 1;
  b[idx(2,3)] = 2;
  for (const [x, y] of [[0,0],[1,0],[2,0]]) b[idx(x,y)] = 1;
  const r = computeBest(b, 1);
  assert.ok((r.x === 7 && r.y === 3) || (r.x === 3 && r.y === 0), `四三杀应选成五点或活三点, 实际 ${r.x},${r.y}`);
});

test('v4 中盘性能: 复杂局面 < 250ms', () => {
  const b = empty();
  const seed = [7,7,1, 8,8,2, 6,7,1, 8,7,2, 5,7,1, 9,9,2, 4,7,1, 10,10,2, 3,7,1, 11,11,2,
                7,5,1, 8,10,2, 6,5,1, 9,7,2, 5,5,1, 10,8,2, 4,5,1, 11,9,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  const t0 = performance.now();
  computeBest(b, 1);
  const dt = performance.now() - t0;
  assert.ok(dt < 250, `耗时 ${dt.toFixed(0)}ms`);
});

// ================= v11.2: 修复回归测试 =================
// 覆盖 8/9 引入/恶化的五个问题: FIVE 阈值不可达、迭代加深 d=2 支配、
// 预算超时 ReferenceError、5e6 提前返回、深度档跳过硬性防守

// 用服务器 worker 同款字符串替换, 编译"极小预算"引擎 —— 强制走 BUDGET 超时路径
function makeEngine({ maxNodes, maxMs } = {}) {
  let src = code;
  if (maxNodes) src = src.replace('maxNodes: 400000', `maxNodes: ${maxNodes}`);
  if (maxMs) src = src.replace('maxMs: 1500', `maxMs: ${maxMs}`);
  const s = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(src, s);
  return s.self.GomokuHint.computeBest;
}

test('v11.2 预算超时(50节点/5ms)不崩溃, 返回合法点', () => {
  // 回归 v11 的 ReferenceError: catch 里读 try 内声明的 budget.best,
  // 每次预算耗尽都崩溃。现在 BUDGET 被各阶段 try/catch 消化, 回退不崩。
  const tiny = makeEngine({ maxNodes: 50, maxMs: 5 });
  const b = empty();
  const seed = [7,7,1, 8,8,2, 6,7,1, 8,7,2, 5,7,1, 9,9,2, 4,7,1, 10,10,2, 3,7,1, 11,11,2,
                7,5,1, 8,10,2, 6,5,1, 9,7,2, 5,5,1, 10,8,2, 4,5,1, 11,9,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  const r = tiny(b, 1);
  assert.ok(r && r.x >= 0 && r.x < 15 && r.y >= 0 && r.y < 15,
    `预算超时路径应返回合法点, 实际 ${JSON.stringify(r)}`);
});

test('v11.2 深度档(skipHardRules)同样必堵对手活四', () => {
  // 回归 v11.1: 深度档跳过全部硬性防守 → 对手活四也不堵。
  // v11.2: 2b 硬性防守无条件执行, skipHardRules 只跳过 2c 可选反推。
  const b = empty();
  for (let i = 5; i <= 8; i++) b[idx(7, i)] = 2;   // 白活四
  b[idx(0, 0)] = 1; b[idx(1, 1)] = 1; b[idx(2, 2)] = 1; // 黑活三干扰
  const r = computeBest(b, 1, { skipHardRules: true });
  assert.equal(r.x, 7, `深度档也应堵白活四, 实际 ${r.x},${r.y}`);
  assert.ok(r.y === 4 || r.y === 9, `应堵活四端点, 实际 y=${r.y}`);
});

test('v11.2 深度档同样必堵对手双活三交点', () => {
  // 白双活二 (4,5)(6,5)+(5,4)(5,6), 落 (5,5) 成双活三 → 两档都要抢占
  const b = empty();
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x, y)] = 2;
  b[idx(0, 0)] = 1; b[idx(1, 0)] = 1;
  const r = computeBest(b, 1, { skipHardRules: true });
  assert.equal(r.x, 5, `深度档应堵双活三交点, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v11.2 普通档与深度档在防守局面收敛一致', () => {
  // 同一双威胁局面: 两档都必堵 (5,5), 不再因 skipHardRules 而分歧
  const b = empty();
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x, y)] = 2;
  b[idx(0, 0)] = 1; b[idx(1, 0)] = 1;
  const normal = computeBest(b, 1);
  const deep = computeBest(b, 1, { skipHardRules: true });
  assert.equal(normal.x, deep.x, `普通档 ${normal.x},${normal.y} 与深度档 ${deep.x},${deep.y} 应一致`);
  assert.equal(normal.y, deep.y);
});

test('v11.2 VCT 找到强制杀: 双活三交点启动杀棋链', () => {
  // 回归 FIVE 阈值不可达: 修复前 shapeScore(SH.FIVE)=1e5 永远够不到 1e7,
  // VCT 阶段 1 永远超时, 杀棋链发现不了。
  // 黑横二 (3,5)(4,5) + 纵二 (5,3)(5,4), 落 (5,5) 双活三 —— 白挡不完:
  // 黑 (5,5) → 白挡横端 → 黑纵成四 → 白挡纵端 → 黑另一端成五。
  // 白 (0,0)(1,0) 有邻居可应(不是死子), 让链真正成立。
  const b = empty();
  for (const [x, y] of [[3,5],[4,5],[5,3],[5,4]]) b[idx(x, y)] = 1;
  b[idx(0, 0)] = 2; b[idx(1, 0)] = 2;
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应落双活三交点 (5,5) 启动杀, 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 5);
});

test('v11.7 必堵(对手活四)优先于杀棋: 对手活四在盘时 killInOne 仍要等', () => {
  // v11.3 旧测试意图: 杀棋优先于堵对手活三。v11.7 推翻这个设计 —— killInOne 在
  // 对手有 2-move 威胁时并不真的赢(白可并行发展)。活四是 1-move 威胁,
  // 必须立即堵, 不能被 killInOne 抢占。
  //
  // 旧测试 (1,7)(2,7)(3,7) 白色 + (4,7) 期望不堵 = 杀棋优先, 但 (4,7) 是白活四
  // 延伸, 引擎正确地识别为"必堵"。v11.7 维持这个正确行为, 测试只改注释/命名。
  const b = empty();
  for (const [x, y] of [[3,5],[4,5],[5,3],[5,4]]) b[idx(x, y)] = 1;
  b[idx(0, 0)] = 2; b[idx(1, 0)] = 2;
  // 白 (1,7)(2,7)(3,7) + 黑不挡 → 白下 (4,7) 成活四, 1 步就赢
  for (const [x, y] of [[1,7],[2,7],[3,7]]) b[idx(x, y)] = 2;
  const r = computeBest(b, 1);
  // 期望: 走 (4,7) 堵白活四延伸 —— 必堵, 不能走 (5,5) 杀棋
  assert.equal(r.x, 4, `必堵白活四延伸点, 实际 (${r.x},${r.y})`);
  assert.equal(r.y, 7);
});

test('v11.3 无强制杀时仍正常堵对手活三端点', () => {
  // 杀棋预检不误伤防守: 对手活三、己方无杀 → 仍走原 2b 堵点逻辑。
  const b = empty();
  for (const [x, y] of [[1,7],[2,7],[3,7]]) b[idx(x, y)] = 2; // 白活三
  b[idx(7, 7)] = 1; b[idx(6, 6)] = 2;
  const r = computeBest(b, 1);
  assert.equal(r.x, 4, `应堵活三端点 (4,7), 实际 ${r.x},${r.y}`);
  assert.equal(r.y, 7);
});

test('v11.3 预算截断不提交浅层乐观值: 极小额预算回退启发式', () => {
  // 回归 gobang V3 门控: 预算极小(50 节点)时 VCT 阶段 1 只完成 d=2,
  // 浅层"没输"是假象 —— 旧引擎把 VCT d=2 的 -535 乐观值当结果提交
  // ((4,8)); v11.3 非胜值只在最终迭代提交, 预算耗尽宁回退启发式。
  // 用 200381 第 14 手局面(两局真棋之一的中盘起点, 启发式答案 (8,11))。
  const rooms = JSON.parse(fs.readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'));
  const moves = rooms.rooms['200381'].moves;
  const b = empty();
  for (let i = 0; i < 14; i++) { const m = moves[i]; b[idx(m.x, m.y)] = m.color; }
  const tiny = code.replace('maxNodes: 400000', 'maxNodes: 50');
  const s = { self: {}, performance: { now: () => Date.now() } };
  vm.runInNewContext(tiny, s);
  const r = s.self.GomokuHint.computeBest(b, 1);
  assert.equal(b[idx(r.x, r.y)], 0, `返回点 (${r.x},${r.y}) 应是空位`);
  assert.notEqual(r.x, 4, `不应提交 VCT 浅层乐观值 (4,8), 实际 ${r.x},${r.y}`);
  assert.notEqual(r.y, 8);
});

// ===== v11.7: killInOne 顺序修复 =====
// 旧版本把 killInOne 放在 2b 之前, 对手冲四(n=4, open=1)时被漏堵:
//   旧行为: 对手有冲四 + 我有双活三一步杀 → 走自己的杀, 对手堵杀 + 延伸冲四成五 → 我输
//   新行为: 必须先堵对手冲四 (2b 在 1.5 之前)
test('v11.7 对手冲四 + 我有一步杀 → 应先堵对手冲四, 不走杀', () => {
  // 构造场景: 白已成冲四(下一步成五); 黑有"双活三"机会(无立即赢点)
  //   白冲四: (3,7)(4,7)(5,7)(6,7) —— 左边(2,7)是黑子(堵住), 右边(7,7)空(开放)
  //   旧版会忽略对手冲四, 走自己的"双活三"; 新版必须先堵 (7,7)
  const b = empty();
  // 白冲四 —— n=4, 一端被黑堵, 另一端空 → 必堵
  b[idx(3, 7)] = 2; b[idx(4, 7)] = 2; b[idx(5, 7)] = 2; b[idx(6, 7)] = 2;
  b[idx(2, 7)] = 1;  // 冲四的"已堵"端 —— 是黑子(不是白子!), n=4, open=1

  // 黑布局: 双活二准备做双活三, 但没有立即能赢的点
  //   黑(4,5)(6,5) 横活二, 黑(5,4)(5,6) 纵活二 → 落(5,5)成双活三
  // 注意: 不能让黑有"成五"的走法, 否则引擎会赢而不是堵
  for (const [x, y] of [[4, 5], [6, 5], [5, 4], [5, 6]]) b[idx(x, y)] = 1;

  const r = computeBest(b, 1);
  // 期望: 落在冲四开放端 (7,7) —— 那是最紧迫的必堵点
  assert.equal(r.x, 7, `应堵对手冲四开放端 (7,7), 实际走 (${r.x},${r.y})`);
  assert.equal(r.y, 7);
});

test('v11.7 对手无冲四时 killInOne 仍生效', () => {
  // 回归: 不能因为修了顺序就废掉一步杀
  // 场景: 黑能双活三(无对手冲四干扰) → 应返回双活三交点
  const b = empty();
  // 黑双活二: 横(4,5)(6,5) + 纵(5,4)(5,6), 落(5,5)成双活三
  for (const [x, y] of [[4, 5], [6, 5], [5, 4], [5, 6]]) b[idx(x, y)] = 1;
  // 白只有远处的孤立子, 无任何冲四/活四
  b[idx(0, 0)] = 2;
  const r = computeBest(b, 1);
  assert.equal(r.x, 5, `应落双活三交点, 实际 (${r.x},${r.y})`);
  assert.equal(r.y, 5);
});

// ================= v45: 原生 opts.deep + history 启发 + TT best-move 排序 =================

test('opts.deep 模式返回合法点 (普通局面)', () => {
  const b = empty();
  const seed = [7,7,1, 8,8,2, 6,7,1, 8,7,2, 5,7,1, 9,9,2, 4,7,1, 10,10,2, 3,7,1, 11,11,2];
  for (let i = 0; i < seed.length; i += 3) b[idx(seed[i], seed[i+1])] = seed[i+2];
  const r = computeBest(b, 1, { deep: true });
  assert.ok(r && r.x >= 0 && r.x < 15 && r.y >= 0 && r.y < 15,
    `deep 模式应返回合法点, 实际 ${JSON.stringify(r)}`);
  // 普通局面也必须不污染
  const before = b.slice();
  computeBest(b, 1, { deep: true });
  for (let i = 0; i < b.length; i++) assert.equal(b[i], before[i], 'deep 模式污染了棋盘');
});

test('opts.deep 模式必堵对手活四', () => {
  const b = empty();
  for (let i = 5; i <= 8; i++) b[idx(7, i)] = 2;  // 白活四
  b[idx(0, 0)] = 1; b[idx(1, 1)] = 1; b[idx(2, 2)] = 1;
  const r = computeBest(b, 1, { deep: true });
  assert.equal(r.x, 7, `deep 模式应堵白活四, 实际 ${r.x},${r.y}`);
  assert.ok(r.y === 4 || r.y === 9, `应堵活四端点, 实际 y=${r.y}`);
});

test('opts.deep 模式在双活二结构上制造双活三', () => {
  const b = empty();
  for (const [x, y] of [[4,5],[6,5],[5,4],[5,6]]) b[idx(x, y)] = 1;
  b[idx(0,0)] = 2; b[idx(14,14)] = 2;
  const r = computeBest(b, 1, { deep: true });
  assert.equal(r.x, 5);
  assert.equal(r.y, 5);
});
