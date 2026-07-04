/* AI Usage service worker — precaches the app shell for full offline use. */
'use strict';

const CACHE_NAME = 'aiusage-v11';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/plugins/claude.js',
  './js/plugins/copilot.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 'reload' bypasses the HTTP cache so a new version never precaches
      // stale copies of the shell.
      .then((cache) => cache.addAll(APP_SHELL.map(
        (url) => new Request(url, { cache: 'reload' })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/*
 * Cache-first for everything in scope, with a background refresh so a new
 * deploy is picked up on the next visit (stale-while-revalidate).
 * Splash screens are cached lazily on first fetch.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const refresh = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => cached);

      return cached || refresh;
    })
  );
});
