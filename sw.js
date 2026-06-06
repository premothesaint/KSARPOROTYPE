/**
 * HoloPlace AR — Service Worker
 * Provides offline installation and caching
 */

const CACHE_NAME = 'holoplace-ar-v1.0.0';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap',
];

// ── INSTALL ──────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing HoloPlace AR cache...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Cache core assets (must succeed)
      await cache.addAll(CORE_ASSETS);
      // Cache CDN assets (best effort)
      for (const url of CDN_ASSETS) {
        try {
          const response = await fetch(url, { mode: 'cors' });
          if (response.ok) await cache.put(url, response);
        } catch (e) {
          console.warn('[SW] Could not cache CDN asset:', url, e.message);
        }
      }
      console.log('[SW] Cache complete');
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser-extension requests
  if (request.method !== 'GET') return;
  if (!['http:', 'https:'].includes(url.protocol)) return;

  // Camera/XR API calls — never cache
  if (url.pathname.includes('/xr') || url.pathname.includes('/camera')) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      // Network with fallback
      return fetch(request)
        .then(response => {
          // Cache fresh copies of app assets
          if (
            response.ok &&
            (url.origin === self.location.origin ||
             url.hostname.includes('cdnjs.cloudflare.com') ||
             url.hostname.includes('fonts.googleapis.com') ||
             url.hostname.includes('fonts.gstatic.com'))
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback for navigation
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
    })
  );
});

// ── MESSAGE ───────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0].postMessage({ success: true });
    });
  }
});
