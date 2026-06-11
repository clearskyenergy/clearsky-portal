// ClearSky Builders LLC — Site Map Designer Pro
// Service Worker v1 — cache CDN libs for offline use

const CACHE = 'clearsky-pro-v1';

const PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600;700&display=swap',
];

// Install — pre-cache CDN libs
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(PRECACHE.map(u => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// Activate — purge old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fall back to network
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never intercept: Anthropic API, Firebase, Google Maps live tiles
  if (url.includes('anthropic.com') ||
      url.includes('firebaseapp.com') ||
      url.includes('firebasestorage.googleapis.com') ||
      url.includes('gstatic.com/firebasejs') ||
      url.includes('googleapis.com/maps') ||
      url.includes('maps.googleapis.com') ||
      url.includes('maps.gstatic.com')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Cache successful GET responses from CDN hosts
        if (e.request.method === 'GET' && res.ok && (
          url.includes('cdnjs.cloudflare.com') ||
          url.includes('cdn.jsdelivr.net') ||
          url.includes('fonts.googleapis.com') ||
          url.includes('fonts.gstatic.com')
        )) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || new Response('Offline — check your connection', { status: 503 }));
    })
  );
});
