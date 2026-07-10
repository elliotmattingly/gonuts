// Go Nuts! service worker — network-first navigations, NO build-time stamping (DESIGN.md §9).
// index.html is the only asset that changes per deploy, and navigations always hit the
// network first — so deployed fixes arrive on the next online load with zero version
// stamping, and the deployed files stay byte-identical to the repo. Offline (bad party
// wifi) serves the cached shell.
const CACHE = 'gonuts-static-v1';   // bump MANUALLY only when the PRECACHE list changes — never per deploy
const PRECACHE = ['./', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  // skipWaiting? NO — never swap the app mid-game; a new worker waits for all tabs to close.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigation requests → NETWORK-FIRST: fetch, cache.put('./', clone) on success;
  // catch → caches.match('./') (the offline shell).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('./', res.clone());
        }
        return res;
      } catch {
        return (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Everything else → stale-while-revalidate: serve the cache hit, refresh in background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const refresh = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached || Response.error());
    event.waitUntil(refresh);   // keep the worker alive until the background refresh lands
    return cached || refresh;
  })());
});
