// v11.5: 服务端超时扫描器回归测试
// 客户端关闭 / AFK 时, 服务端 5s 扫描应独立判负, 不再依赖客户端上报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, claimSeat, tryMove, newGame } from '../src/room.js';

test('turnStartedAt: createRoom 初始为 null', () => {
  const r = createRoom('t1');
  assert.equal(r.turnStartedAt, null);
});

test('两人到齐开局后 turnStartedAt 跟随 timer.enabled', () => {
  // 默认 timer.enabled = false → turnStartedAt 应为 null
  const r = createRoom('t2a');
  claimSeat(r, 'tokA1111111111');
  claimSeat(r, 'tokB2222222222');
  assert.equal(r.status, 'playing');
  assert.equal(r.turnStartedAt, null);

  // 开启计时器 → 下一局 turnStartedAt 应被设置
  const r2 = createRoom('t2b');
  r2.timer = { enabled: true, perMoveSec: 60 };
  claimSeat(r2, 'tokA1111111111');
  claimSeat(r2, 'tokB2222222222');
  assert.equal(r2.status, 'playing');
  assert.equal(typeof r2.turnStartedAt, 'number');
});

test('applyMove 后 turnStartedAt 重置为 now (新回合开始)', () => {
  const r = createRoom('t3');
  claimSeat(r, 'tokA1111111111');
  claimSeat(r, 'tokB2222222222');
  const before = r.turnStartedAt;
  // 至少等 5ms 让 now 推进
  const future = Date.now() + 5;
  // 直接覆盖 board 模拟推进时间
  while (Date.now() < future) { /* spin */ }
  tryMove(r, 'tokA1111111111', 7, 7);
  assert.ok(r.turnStartedAt >= before, `新 turnStartedAt ${r.turnStartedAt} 应 >= 旧值 ${before}`);
});

test('applyMove 成五后 turnStartedAt 重置为 null', () => {
  const r = createRoom('t4');
  claimSeat(r, 'tokA1111111111');
  claimSeat(r, 'tokB2222222222');
  // 必须交替落子 (五子棋规则)
  for (let i = 0; i < 4; i++) {
    tryMove(r, 'tokA1111111111', i, 0);     // 黑 (0,0)..(3,0)
    tryMove(r, 'tokB2222222222', i, 5);     // 白 (0,5)..(3,5)
  }
  tryMove(r, 'tokA1111111111', 4, 0);       // 黑 (4,0) — 成五
  assert.equal(r.status, 'won');
  assert.equal(r.turnStartedAt, null, '终局后计时停止');
});

test('计时器关闭时不设置 turnStartedAt', () => {
  const r = createRoom('t5');
  r.timer = { enabled: false, perMoveSec: 60 };
  claimSeat(r, 'tokA1111111111');
  claimSeat(r, 'tokB2222222222');
  assert.equal(r.status, 'playing');
  assert.equal(r.turnStartedAt, null, '计时器关闭时不计时');
});

test('newGame 后 turnStartedAt 跟随 timer.enabled', () => {
  const r = createRoom('t6');
  r.timer = { enabled: true, perMoveSec: 60 };
  claimSeat(r, 'tokA1111111111');
  claimSeat(r, 'tokB2222222222');
  assert.ok(r.turnStartedAt > 0);
  // 关闭计时器再开新局 → turnStartedAt 应为 null
  r.timer.enabled = false;
  r.status = 'won'; // 模拟一局已结束
  newGame(r);
  assert.equal(r.turnStartedAt, null, '新局计时器关闭时 turnStartedAt 应为 null');
});