// Offline support. App files: network first (so updates show up), cache as fallback.
// Text-reader files from the CDN: cache first (they are versioned and large).

const CACHE = 'sunglasses-v3';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/camera.js',
  'js/capture.js',
  'js/effects.js',
  'js/messages.js',
  'js/motion.js',
  'js/scanner.js',
  'js/tracker.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'demo/belgrade.jpg',
  'models/text-det.onnx',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === location.origin && /\/(models|demo)\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request)); // big files that rarely change
  } else if (url.origin === location.origin) {
    event.respondWith(networkFirst(request));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}
