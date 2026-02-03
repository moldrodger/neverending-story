const VERSION = "v7";
const CACHE = `nes-${VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    self.skipWaiting();
    const cache = await caches.open(CACHE);
    // Cache the shell. app.js has ?v=7 so it updates.
    await cache.addAll([
      "./",
      "./index.html",
      "./manifest.json",
      "./app.js?v=7",
    ]);
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

// Network-first for HTML/JS so PWA actually updates
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  const isHTML = req.headers.get("accept")?.includes("text/html");
  const isJS = url.pathname.endsWith(".js");

  if (isHTML || isJS) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Cache-first for everything else
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});
