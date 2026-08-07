// 端到端测试: 双客户端真实 WebSocket 对战
// 覆盖: 座位分配、实时同步、非法落子拦截、悔棋协商、断线重连、持久化、胜负判定

import { WebSocket } from 'ws';

const PORT = process.env.PORT || 8899;
const URL = process.env.E2E_URL || `ws://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

class Client {
  constructor(token) {
    this.token = token;
    this.msgs = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        const idx = this.msgs.length;
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(m)) { w.resolve(m, idx); return false; }
          return true;
        });
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 3000) {
    // 只匹配调用之后到达的消息 —— 扫历史会命中陈旧消息导致"假通过"
    const from = this.msgs.length;
    const hit = this.msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('等待消息超时')), ms);
      this.waiters.push({
        pred,
        // 只响应位置 >= from 的新消息
        resolve: (m, idx) => { if (idx >= from) { clearTimeout(t); res(m); } },
      });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOM = 'e2e' + Math.random().toString(36).slice(2, 8);

console.log('\n[1] 座位分配与实时同步');
const a = new Client('tokenAAAAAAAA1111');
const b = new Client('tokenBBBBBBBB2222');
await a.connect();
a.send({ type: 'join', roomId: ROOM, token: a.token, name: '阿巢' });
const aJoin = await a.wait((m) => m.type === 'joined');
ok(aJoin.color === 1, '先进入者执黑');
ok(aJoin.state.status === 'waiting', '仅一人时处于等待状态');

await b.connect();
b.send({ type: 'join', roomId: ROOM, token: b.token, name: '女朋友' });
const bJoin = await b.wait((m) => m.type === 'joined');
ok(bJoin.color === 2, '后进入者执白');
const bPlaying = await b.wait((m) => m.type === 'state' && m.state.status === 'playing');
ok(!!bPlaying, '两人到齐后自动开局');

console.log('\n[2] 落子与规则校验');
a.send({ type: 'move', x: 7, y: 7 });
const bSaw = await b.wait((m) => m.type === 'state' && m.event === 'move');
ok(bSaw.state.board[7 * 15 + 7] === 1, '对方实时看到黑棋落子');
ok(bSaw.state.turn === 2, '落子后轮到白方');

a.msgs.length = 0;
a.send({ type: 'move', x: 5, y: 5 });
const notTurn = await a.wait((m) => m.type === 'error');
ok(/轮到/.test(notTurn.error), '未轮到时落子被拒绝');

b.msgs.length = 0;
b.send({ type: 'move', x: 7, y: 7 });
const occupied = await b.wait((m) => m.type === 'error');
ok(/已有棋子/.test(occupied.error), '重复落子被拒绝');

b.msgs.length = 0;
b.send({ type: 'move', x: 99, y: 3 });
const oob = await b.wait((m) => m.type === 'error');
ok(/超出棋盘/.test(oob.error), '越界落子被拒绝');

console.log('\n[3] 断线重连保持身份与棋局');
a.close();
await sleep(200);
const a2 = new Client(a.token);
await a2.connect();
a2.send({ type: 'join', roomId: ROOM, token: a.token, name: '阿巢' });
const back = await a2.wait((m) => m.type === 'joined');
ok(back.color === 1, '重连后仍是黑方(凭 token 认领原座位)');
ok(back.state.board[7 * 15 + 7] === 1, '重连后棋盘状态完整保留');

console.log('\n[4] 悔棋需对方同意');
b.msgs.length = 0;
b.send({ type: 'move', x: 8, y: 8 });
await b.wait((m) => m.type === 'state' && m.event === 'move');

a2.msgs.length = 0; b.msgs.length = 0;
a2.send({ type: 'undo-request' });
const req = await b.wait((m) => m.type === 'state' && m.event === 'undo-request');
ok(req.state.undoRequest.by === 1, '白方收到黑方的悔棋请求');

b.send({ type: 'undo-reply', accept: false });
const rej = await a2.wait((m) => m.type === 'state' && m.event === 'undo-rejected');
ok(rej.state.moves === 2, '拒绝后棋子数不变');

a2.msgs.length = 0; b.msgs.length = 0;
a2.send({ type: 'undo-request' });
await b.wait((m) => m.type === 'state' && m.event === 'undo-request');
b.send({ type: 'undo-reply', accept: true });
const acc = await a2.wait((m) => m.type === 'state' && m.event === 'undo-accepted');
ok(acc.state.moves === 0, '同意后回退两手(对方一手+自己一手)');
ok(acc.state.turn === 1, '悔棋后落子权回到请求方');

console.log('\n[5] 五连判胜与比分');
// 黑 (0,0)-(4,0) 连成五; 白在第 5 行落子避让。
// 每步都等到"己方这一手已被服务端接受"再走下一步, 避免抢跑。
async function moveAndSettle(cli, x, y, label) {
  cli.send({ type: 'move', x, y });
  try {
    // 精确等待"这一手已被服务端接受并广播"——用 moves 计数做屏障会因
    // 双方广播到达延迟不同而错位, 导致抢跑
    await cli.wait(
      (m) => m.type === 'state' && m.event === 'move' && m.at && m.at.x === x && m.at.y === y,
      2000
    );
  } catch (e) {
    const s = cli.msgs.filter((m) => m.type === 'state').pop()?.state;
    const errs = cli.msgs.filter((m) => m.type === 'error').map((m) => m.error);
    console.error(`    !! [5] ${label}(${x},${y}) 卡住: moves=${s?.moves} turn=${s?.turn} status=${s?.status} errs=${errs.join('|')}`);
    throw e;
  }
}
for (let i = 0; i < 4; i++) {
  await moveAndSettle(a2, i, 0, 'A');
  await moveAndSettle(b, i, 5, 'B');
}
a2.msgs.length = 0;
a2.send({ type: 'move', x: 4, y: 0 });
let won;
try {
  won = await a2.wait((m) => m.type === 'state' && m.state.status === 'won', 2000);
} catch (e) {
  const s = a2.msgs.filter((m) => m.type === 'state').pop()?.state;
  console.error(`    !! [5] 终局等待超时: moves=${s?.moves} turn=${s?.turn} status=${s?.status}`);
  console.error(`    !! a2 收到: ${a2.msgs.map((m) => m.type + (m.state ? `:m${m.state.moves}/${m.state.status}` : m.error ? `:${m.error}` : '')).join(', ')}`);
  throw e;
}
ok(won.state.winner === 1, '黑方五连判胜');
ok(won.state.winLine && won.state.winLine.length === 5, '返回五子连线用于高亮');
ok(won.state.score[1] === 1, '胜方比分 +1');

console.log('\n[6] 新局交换先手');
a2.msgs.length = 0; b.msgs.length = 0;
a2.send({ type: 'new-game' });
const ng = await a2.wait((m) => m.type === 'state' && m.event === 'new-game');
ok(ng.state.you === 2, '原黑方在新局改执白(先手已交换)');
ok(ng.state.board.every((v) => v === 0), '新局棋盘清空');
ok(ng.state.status === 'playing', '新局直接开始');

console.log('\n[7] 观战者不能落子');
const c = new Client('tokenCCCCCCCC3333');
await c.connect();
c.send({ type: 'join', roomId: ROOM, token: c.token, name: '路人' });
const cJoin = await c.wait((m) => m.type === 'joined');
ok(cJoin.color === null, '第三人进入为观战者');
c.msgs.length = 0;
c.send({ type: 'move', x: 1, y: 1 });
const spectErr = await c.wait((m) => m.type === 'error');
ok(/观战者/.test(spectErr.error), '观战者落子被拒绝');

console.log('\n[8] 非法输入防护');
const d = new Client('x');
await d.connect();
d.send({ type: 'join', roomId: '../etc', token: 'tokenDDDDDDDD4444' });
const badRoom = await d.wait((m) => m.type === 'error');
ok(/房间号不合法/.test(badRoom.error), '非法房间号被拒绝');
d.msgs.length = 0;
d.send({ type: 'join', roomId: 'okroom', token: 'sh' });
const badTok = await d.wait((m) => m.type === 'error');
ok(/身份标识不合法/.test(badTok.error), '过短的 token 被拒绝');

a2.close(); b.close(); c.close(); d.close();
await sleep(300);

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
