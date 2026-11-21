/* Grenzgang – Service Worker: App offline starten, Kartenkacheln im Hintergrund merken */
const SHELL = 'grenzgang-shell-v2';
const LIBS = 'grenzgang-libs-v1';
const TILES = 'grenzgang-tiles-v1';
const MAX_TILES = 4000;
const SHELL_FILES = ['./', 'index.html', 'app.js', 'geo.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const LIB_FILES = [
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js',
  'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.2/proj4.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_FILES.map((u) => libs.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, LIBS, TILES].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isTile = (u) => /tile\.openstreetmap\.org|elevation-tiles-prod|wms_geosn_dop-rgb/.test(u.href);

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) { // erst Netz, bei Ausfall gemerkte Kachel
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); if (Math.random() < 0.02) trim(cache); }
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }
  if (url.hostname === 'cdnjs.cloudflare.com' || url.origin === location.origin) { // erst Zwischenspeicher
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: false });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(url.origin === location.origin ? SHELL : LIBS)).put(req, res.clone());
        return res;
      } catch (err) {
        if (req.mode === 'navigate') return caches.match('index.html');
        throw err;
      }
    })());
  }
});
