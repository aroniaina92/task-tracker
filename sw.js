// Service worker: makes the app installable and opens it instantly from cache.
// Bump VERSION after each change you push, so phones pick up the new files.
const VERSION = 'tt-v10';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'bg/reef.webp', 'bg/reef.jpg', 'icons/logo.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png', 'book.html', 'book.js',
  'lib/supabase.min.js', 'supa.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files: show the cached copy at once, refresh it in the background.
// Data calls (to supabase.co) are never cached.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin;
  const isFont = url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com');
  const isLib = url.hostname === 'cdn.jsdelivr.net';      // calendar library
  if (!isShell && !isFont && !isLib) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: isShell });
    const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});
