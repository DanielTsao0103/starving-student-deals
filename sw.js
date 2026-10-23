/* Account requests never enter CacheStorage. Each published build owns its shell. */
const PREFIX = 'deals-shell-' + self.registration.scope + '-';
const CACHE = PREFIX + '41dc5bd6599a4513a8d1b2df8225f145';
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./config.js", "./adapter.js", "./admin-invites.js", "./catalog.js", "./cuisine-v2.js", "./icon-192.png", "./icon-512.png", "./icon-maskable.png", "./apple-touch-icon.png", "./favicon.png"];
const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
const shellURLs = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // Local mode and the app shell must work even when the CDN is unreachable.
    try { await cache.add(SDK); } catch {}
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const navigation = request.mode === 'navigate' && (url.pathname === new URL('./', self.registration.scope).pathname || url.pathname === new URL('./index.html', self.registration.scope).pathname);
  // All other requests, including Supabase REST, auth and realtime, stay network-only.
  if (!navigation && !shellURLs.has(url.href) && url.href !== SDK) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = navigation ? new URL('./index.html', self.registration.scope).href : request;
    const saved = await cache.match(key);
    if(navigation || url.pathname.endsWith('/index.html')){
      const update=fetch(request).then(async response=>{if(response.ok)await cache.put(key,response.clone());return response;});
      event.waitUntil(update.catch(()=>{}));return saved||update;
    }
    if (saved) return saved;
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  })());
});
