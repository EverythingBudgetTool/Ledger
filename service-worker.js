const CACHE_NAME = "the-ledger-v51";

// Files we control directly — cached immediately on install.
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  // Prebuilt stylesheet (replaced the Tailwind CDN as of build 39). MUST be
  // cached: it's now the app's only source of styling, and unlike the CDN it's
  // ours to cache — which is what finally makes the PWA genuinely offline.
  "./styles.css",
  "./main.js",
  "./storage-shim.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// App-shell files: cache-first, since they only change when the app itself
// is updated (new version = new CACHE_NAME).
// Everything else (Tailwind CDN, React/Recharts/lucide-react/papaparse from
// esm.sh, fonts): ALSO cache-first, not network-first. These are
// version-pinned CDN URLs (e.g. react@18.3.1) — the content at a given URL
// never changes, so there's no staleness risk, and serving from cache
// immediately (instead of waiting on a full round-trip for React, Recharts,
// and its own several sub-dependencies on every single load) is what
// actually makes repeat opens fast instead of hanging on a weak connection.
// The cache is still refreshed quietly in the background for next time.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchAndCache = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);

      // Serve the cached copy instantly if we have one; otherwise wait on
      // the network (first-ever load, or a truly new/uncached request).
      return cached || fetchAndCache;
    })
  );
});
