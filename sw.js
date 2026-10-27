// Offline support: network-first for everything (so updates show up immediately),
// falling back to the cached copy when there's no connection.
const CACHE = 'az104-sim-v1';
const CORE = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/js/domains.js',
  '/data/questions.json', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((hit) => hit || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
