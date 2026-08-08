// 五子棋 AI 搜索 Worker — 后台线程跑搜索, 主线程不卡
// 接收: { board, color }  返回: { x, y, ms }
// 通过 importScripts 加载引擎(浏览器 Worker 里无 module, UMD 正确绑定 self.GomokuHint)
importScripts('/hint.js');
self.onmessage = (e) => {
  const { board, color } = e.data || {};
  if (!board || !color || typeof self.GomokuHint === 'undefined') {
    self.postMessage({ error: '引擎未加载或参数错误' }); return;
  }
  const t0 = Date.now();
  try {
    const r = self.GomokuHint.computeBest(board, color);
    self.postMessage({ x: r.x, y: r.y, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
