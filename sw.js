// Offline shell: online, files always come fresh from the server (so an update shows on the
// very next load, not the one after); offline, or when the network is slow, from the cache
// filled by earlier visits. After one online visit the app opens with no network at all.
const CACHE = 'knot-v2';
const PATIENCE_MS = 4000; // a slower network than this falls back to the cached copy

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
    try {
      const signal = AbortSignal.timeout(PATIENCE_MS);
      const res = await fetch(request, { cache: 'no-cache', signal });
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return (await cache.match(request)) ?? Response.error();
    }
  })());
});
