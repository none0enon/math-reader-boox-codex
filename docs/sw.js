// Minimal Service Worker — PWA 安装必需，不缓存任何内容。
// 更新 index.html 后立即生效，无需手动清缓存。

// Cache Storage is shared by every GitHub Pages app on the same origin.
// Only this application's namespace may ever be removed here.
const CACHE_NAMESPACE_PREFIX = 'math-reader-boox-codex:v1:cache:';

// 安装时跳过等待，立即激活
self.addEventListener('install', () => self.skipWaiting());

// 激活时仅清除本应用自己的旧缓存，然后接管页面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith(CACHE_NAMESPACE_PREFIX)).map(key => caches.delete(key))
    ))
      .then(() => self.clients.claim())
  );
});

// 不拦截任何请求——全部走网络
// （如果将来需要离线功能，可以在这里加回来）
