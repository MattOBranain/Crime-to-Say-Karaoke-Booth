// TEMPORARY offline-caching service worker — added for offline festival use,
// intended to be reverted from the live site shortly after use. See
// README's "Offline festival mode" note for the full story.
//
// Once a device installs this (by loading the page while online), every
// asset the app needs — including the MP4-conversion library normally
// fetched from a CDN — is stored in this cache and served from it first,
// so the app keeps working with zero network from then on. Reverting the
// site later (removing the registration call) does NOT remove this cache
// from a device that already installed it — that only happens if the
// device's browser is told to clear the site's data, or (Safari) if the
// site goes unvisited for 7+ days.

const CACHE_NAME = 'crime2say-offline-v7';

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './Crime2Say-wintro.mp3',
  './crime-2-say-oke-shortest.lrc',
  './favicon.ico',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((e) => console.warn('[sw] precache failed for', url, e))
        )
      );
      const clientsList = await self.clients.matchAll();
      clientsList.forEach((c) => c.postMessage({ type: 'OFFLINE_CACHE_READY' }));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      try {
        const response = await fetch(event.request);
        if (response && response.status === 200) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (e) {
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
