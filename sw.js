// オフライン対応：同一オリジンの静的ファイルをキャッシュ（ネットワーク優先）
const CACHE = 'shunei-v1';
const ASSETS = [
  './',
  "./css/style.css",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./index.html",
  "./js/ai.js",
  "./js/app.js",
  "./js/data/index.js",
  "./js/data/scenes/customer.js",
  "./js/data/scenes/daily.js",
  "./js/data/scenes/email.js",
  "./js/data/scenes/management.js",
  "./js/data/scenes/meeting.js",
  "./js/data/scenes/negotiation.js",
  "./js/data/scenes/office.js",
  "./js/data/scenes/phone.js",
  "./js/data/scenes/presentation.js",
  "./js/data/scenes/travel.js",
  "./js/data/scenes/trip.js",
  "./js/grader.js",
  "./js/speech.js",
  "./js/srs.js",
  "./js/store.js",
  "./manifest.webmanifest",
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))),
  );
});
