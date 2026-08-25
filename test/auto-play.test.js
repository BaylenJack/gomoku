/* 自动落子功能 —— 与手动提示分开的独立按钮。
 * 开启后每个回合用提示引擎算落点, 静默发 move 落子, 不显示建议圈/不弹提示。
 * 这里用静态断言校验 app.js 的关键接线, 与项目现有 hint 测试风格一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (url) => fs.readFileSync(new URL(url, import.meta.url), 'utf8');
const app = read('../public/app.js');
const style = read('../public/style.css');

test('自动落子有独立开关状态与独立按钮', () => {
  assert.match(app, /let autoPlay = false;/);
  assert.match(app, /autoPlayBtn/);
  assert.match(app, /function toggleAutoPlay\(\)/);
  assert.match(app, /function updateAutoPlayBtn\(\)/);
  // 自动按钮单独成行, 插在提示栏之后, 不放进可折叠的 hint-row
  assert.match(app, /const autoRow = document\.createElement\('div'\);\s*autoRow\.className = 'auto-row';/);
  assert.match(app, /row\.after\(autoRow\);/);
});

test('自动落子默认引擎与引擎复用逻辑存在', () => {
  assert.match(app, /AUTO_DEFAULT_MODE = 'deep'/);
  assert.match(app, /const mode = hintMode \|\| AUTO_DEFAULT_MODE/);
});

test('自动落子静默发 move 而不是显示提示圈', () => {
  assert.match(app, /send\(\{ type: 'move', x, y \}\)/);
  // showHint 的成功路径在 autoPlay 时直接落子而不是画建议圈
  assert.match(app, /if \(autoPlay && state\.turn === myColor\)\s*\{\s*send\(\{ type: 'move', x, y \}\)/);
  // draw 在 autoPlay 时不渲染建议圈
  assert.match(app, /hintMark && !autoPlay && performance\.now\(\) < hintHighlightUntil/);
});

test('自动落子接管自动刷新, 弃用建议圈展示路径', () => {
  assert.match(app, /if \(autoPlay\) \{ autoPlayMove\(\); return; \}/);
  assert.match(app, /async function autoPlayMove\(\)/);
});

test('自动落子请求仍校验棋盘快照, 计算期间变化则不落子', () => {
  // 复刻 showHint 的防串结果校验, 自动落子同样有
  assert.match(app, /state\.board\.some\(\(v, i\) => v !== boardSnapshot\[i\]\)/);
});

test('点击隐藏按钮时自动落子按钮一起隐藏(状态不变)', () => {
  // toggleHintVisibility 同步折叠 hint-row 与 auto-row
  assert.match(app, /autoRow\.classList\.toggle\('collapsed', hintUiHidden\)/);
  // 折叠时 auto 按钮隐形不可点
  assert.match(style, /\.auto-row\.collapsed \.btn-auto \{ opacity: 0; pointer-events: none; \}/);
});
