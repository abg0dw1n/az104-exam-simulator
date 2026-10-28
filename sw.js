// Offline support: network-first for everything (so updates show up immediately),
// falling back to the cached copy when there's no connection.
const CACHE = 'examsim-v37';
// Exam files are cached the first time each exam is opened.
const CORE = ['/', '/css/styles.css', '/js/app.js', '/js/auth.js', '/js/learn.js', '/js/theme.js', '/exams/index.json',
  '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

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
  // Narration audio streams with Range requests (206 responses can't be cached), so let the
  // browser handle media directly instead of copying multi-MB files into the cache.
  if (request.headers.has('range') || request.destination === 'audio' || request.destination === 'video') return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      // Offline: serve the cached copy; exam pages like /az-104 fall back to the app shell.
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((hit) => hit || (request.mode === 'navigate' ? caches.match('/') : Response.error()))),
  );
});
