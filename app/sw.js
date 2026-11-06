// Service worker: offline app shell + routes you have opened + map tiles you have viewed.
// Network-first for app/data files (so updates show up), cache-first for map tiles.
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const DATA = 'data-v1';
const TILES = 'tiles-v2'; // v1 held opaque (no-cors) tiles, which can't answer CORS requests
const MAX_TILES = 4000;

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'css/base.css', 'css/viewer.css',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'js/viewer.js', 'js/store.js',
  'js/core/model.js', 'js/core/geo.js', 'js/core/osrm.js', 'js/core/osm.js', 'js/core/roundabout.js',
  'js/core/analyze.js', 'js/core/timeline.js', 'js/core/instructions.js', 'js/core/exporters.js', 'js/core/rules.js',
  'js/ui/icons.js', 'js/ui/util.js', 'js/ui/mapkit.js', 'js/ui/rbdiagram.js', 'js/ui/detail.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if ((k.startsWith('shell-') && k !== SHELL) || (k.startsWith('tiles-') && k !== TILES)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req, TILES)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;
  e.respondWith(networkFirst(req, url.pathname.includes('/data/') ? DATA : SHELL));
});

async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

let putCount = 0;
async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit && !(hit.type === 'opaque' && req.mode === 'cors')) return hit;
  const res = await fetch(req);
  if (res.ok) { // never cache opaque responses (huge quota padding)
    c.put(req, res.clone()).catch(() => {});
    if (++putCount % 200 === 0) trim(c);
  }
  return res;
}

async function trim(c) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}
