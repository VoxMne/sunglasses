// Offline support. App files: network first (so updates show up), cache as fallback.
// Text-reader files from the CDN: cache first (they are versioned and large).
//
// Also adds the cross-origin isolation headers (COOP/COEP) to the app's own files.
// They unlock SharedArrayBuffer, which the text model needs to use several CPU cores.
// GitHub Pages can't send custom headers, so the service worker does it; they take
// effect from the page load after this worker takes control (app.js reloads once).

const CACHE = 'sunglasses-v4';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/camera.js',
  'js/capture.js',
  'js/detector-worker.js',
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
    event.respondWith(cacheFirst(request).then(isolate)); // big files that rarely change
  } else if (url.origin === location.origin) {
    event.respondWith(networkFirst(request).then(isolate));
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

function isolate(res) {
  // Errors, opaque responses and redirects can't (and needn't) be rewrapped.
  if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
