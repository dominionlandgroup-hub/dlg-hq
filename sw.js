// DLG HQ app shell: always tries the network first so you get the newest version,
// and falls back to the last copy if you're offline. Data calls are never cached.
// The shell is the page at this worker's own folder ("/" on landiq.land, "/dlg-hq/" on GitHub Pages), or its index.html.
const C = 'dlghq-shell-v2';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./', './manifest.webmanifest', './icons/icon-192.png']))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== location.origin) return;
  const base = new URL('./', self.registration.scope).pathname;
  const shell = u.pathname === base || u.pathname === base + 'index.html';
  if (r.mode === 'navigate' && shell) {
    e.respondWith(fetch(r.url, { cache: 'no-store', credentials: 'same-origin' }).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put('./', cp)); } return res; }).catch(() => caches.match('./')));
  }
});
