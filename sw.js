// Offline shell: serve same-origin files from cache first, refresh them in the background.
// After one online visit the app opens with no network at all.
const CACHE = 'knot-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const refresh = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; });
    return cached ?? refresh.catch(() => Response.error());
  })());
});
