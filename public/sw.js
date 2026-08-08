/* Service Worker — 缓存策略:
 * - HTML/JS/CSS: network-first（不缓存，永远拿最新，缓存问题彻底消失）
 * - 图标/manifest: cache-first（资源固定，缓存加速）
 * - WebSocket: 不拦截
 */
const CACHE = 'gomoku-v3';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // 强制清理所有旧缓存
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // WebSocket 不拦截
  if (e.request.headers.get('upgrade')) return;

  // HTML/JS/CSS: network-first（绝不缓存，确保永远用最新版）
  if (url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // 图标等静态: cache-first
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached || fetch(e.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return resp;
      })
    )
  );
});
