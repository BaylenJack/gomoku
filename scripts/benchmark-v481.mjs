// 固定墙钟对比当前工作树与 HEAD 引擎；不生成基线副本，不修改生产配置。
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const budgetMs = Number(process.argv[2] || 750);
const nodeArg = process.argv.find((arg) => arg.startsWith('--nodes='));
const nodeBudget = nodeArg ? Number(nodeArg.slice('--nodes='.length)) : 0;
const SIZE = 15;
const idx = (x, y) => y * SIZE + x;

function load(source) {
  source = source.replace(/const DEEP_BUDGET_MS = \d+;/g, `const DEEP_BUDGET_MS = ${nodeBudget ? 60000 : budgetMs};`);
  if (nodeBudget) {
    source = source.replace(/maxNodes: isDeep \? MAX_BUDGET : \(1 << 22\),/g,
      `maxNodes: isDeep ? ${nodeBudget} : (1 << 22),`);
  }
  const sandbox = { self: {}, performance: { now: () => performance.now() } };
  vm.runInNewContext(source, sandbox);
  return sandbox.self.GomokuHint;
}

function board(stones) {
  const value = new Array(SIZE * SIZE).fill(0);
  for (const [x, y, color] of stones) value[idx(x, y)] = color;
  return value;
}

const positions = [
  ['攻防中盘-白', 2, [[7,7,1],[7,8,1],[8,8,1],[9,6,1],[6,5,1],[6,7,1],[5,6,1],[5,5,1],[7,10,1],[4,7,1],[7,6,2],[8,7,2],[6,6,2],[9,8,2],[8,5,2],[6,8,2],[8,9,2],[4,5,2]]],
  ['平静中盘-黑', 1, [[7,7,1],[8,7,1],[6,6,1],[9,9,1],[5,8,1],[9,6,1],[7,6,2],[8,8,2],[6,7,2],[5,5,2],[8,5,2],[10,8,2]]],
  ['相互活三-白', 2, [[5,6,1],[6,5,1],[7,4,1],[4,3,2],[4,4,2],[4,5,2]]],
  ['结构中盘-黑', 1, [[7,7,1],[6,7,2],[8,7,1],[7,6,2],[8,8,1],[6,8,2],[9,8,1],[5,6,2],[9,6,1],[5,8,2],[7,9,1],[8,5,2]]],
];

const baseline = load(execFileSync('git', ['show', 'HEAD:public/hint.js'], { encoding: 'utf8' }));
const current = load(fs.readFileSync(new URL('../public/hint.js', import.meta.url), 'utf8'));

for (const [name, color, stones] of positions) {
  const b = board(stones);
  const row = [];
  for (const [label, engine] of [['HEAD', baseline], ['current', current]]) {
    const t0 = performance.now();
    const result = engine.computeBest(b.slice(), color, { deep: true, workerId: 0 });
    row.push(`${label} ${(performance.now() - t0).toFixed(0)}ms (${result.x},${result.y}) v=${result.value ?? '-'} pv=${result.path?.length ?? '-'}`);
  }
  console.log(`${name}: ${row.join(' | ')}`);
}

if (process.argv.includes('--battle')) {
  function winsAt(b, x, y, color) {
    for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
      let count = 1;
      for (const sign of [-1, 1]) {
        for (let step = 1; step < 5; step++) {
          const nx = x + dx * step * sign, ny = y + dy * step * sign;
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || b[idx(nx, ny)] !== color) break;
          count++;
        }
      }
      if (count >= 5) return true;
    }
    return false;
  }

  function play(black, white, opening = []) {
    const b = board(opening);
    for (let ply = opening.length; ply < 120; ply++) {
      const color = ply % 2 + 1;
      const engine = color === 1 ? black : white;
      const result = engine.computeBest(b.slice(), color, { deep: true, workerId: 0 });
      if (!result || b[idx(result.x, result.y)] !== 0) return { winner: color === 1 ? 2 : 1, plies: ply, illegal: result };
      b[idx(result.x, result.y)] = color;
      if (winsAt(b, result.x, result.y, color)) return { winner: color, plies: ply + 1 };
    }
    return { winner: 0, plies: 120 };
  }

  const openings = [
    [[7,7,1],[7,8,2],[8,7,1],[6,7,2],[8,8,1],[6,8,2]],
    [[7,7,1],[8,8,2],[6,8,1],[8,6,2],[6,6,1],[7,9,2],[9,7,1],[5,7,2]],
    positions[1][2],
  ];
  let game = 0;
  for (let openingIndex = 0; openingIndex < openings.length; openingIndex++) {
    for (let side = 0; side < 2; side++) {
      game++;
      const currentBlack = side === 0;
      const result = play(currentBlack ? current : baseline, currentBlack ? baseline : current, openings[openingIndex]);
      const winner = result.winner === 0 ? '和棋' :
        ((result.winner === 1) === currentBlack ? 'current' : 'HEAD');
      console.log(`对局${game}/开局${openingIndex + 1}: current${currentBlack ? '执黑' : '执白'}，${winner}胜，${result.plies}手`);
    }
  }
}
