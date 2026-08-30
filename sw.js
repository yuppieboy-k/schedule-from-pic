/* =========================================================
   Schedule from Pic — Service Worker
   Cache-first strategy so the app shell works offline.
   Bump CACHE_VERSION when shipping new assets.
   Tesseract.js is NOT pre-cached; it loads on demand only
   when the user is offline.
   ========================================================= */

const CACHE_VERSION = 'schedule-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './providers.js',
  './prompt.js',
  './export.js',
  './parser.js',
  './ocr.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never cache API calls to LLM providers.
  const url = new URL(request.url);
  if (
    url.host.endsWith('googleapis.com') ||
    url.host.endsWith('groq.com') ||
    url.host.endsWith('huggingface.co') ||
    url.host.endsWith('cdn.jsdelivr.net') ||  // Tesseract.js worker
    url.host.endsWith('unpkg.com')
  ) {
    return;  // let the network handle it
  }

  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
