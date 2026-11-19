// オフラインでも開けるよう、アプリ本体だけをキャッシュする。
// 記録データ(IndexedDB)はここでは扱わず、外部への通信も行わない。
const CACHE = 'otomo-v4';
const FILES = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/db.js', 'js/calendar.js', 'js/backup.js', 'js/calendar-parse.js', 'js/vendor/pdfjs/pdf.min.mjs', 'js/vendor/pdfjs/pdf.worker.min.mjs',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // 新しい版があれば取得し、通信できなければキャッシュを使う
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
