// Service worker: makes the app installable and opens it instantly from cache.
// Bump VERSION after each change you push, so phones pick up the new files.
const VERSION = 'tt-v19';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'bg/reef.webp', 'bg/reef.jpg', 'icons/logo.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png', 'book.html', 'book.js',
  'lib/supabase.min.js', 'supa.js'];

self.addEventListener('install', e => {
  // each file on its own: one missing file must not break offline use of the others
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.allSettled(SHELL.map(f => fetch(f, { cache: 'reload' }).then(r => { if (r.ok) return c.put(f, r); }))))
    .then(() => self.skipWaiting()));
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
  if (!isShell && !isFont) return;                       // data calls (supabase.co) are never cached
  e.respondWith(caches.open(VERSION).then(async cache => {
    let cached = await cache.match(req, { ignoreSearch: isShell });
    if (!cached && req.mode === 'navigate') cached = await cache.match(url.pathname.endsWith('book.html') ? 'book.html' : 'index.html');
    const fresh = fetch(req).then(res => { if (res.ok && !url.search) cache.put(req, res.clone()); return res; });
    if (cached) { fresh.catch(() => {}); return cached; }  // show the saved copy at once, update it in the background
    return fresh.catch(() => cached || Response.error());
  }));
});
