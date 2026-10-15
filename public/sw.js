/* HomeClip's offline shell. The shell (its markup, scripts, styles and
 * icons) is precached so a launch with no connection still opens the app;
 * the cached reads (the feed, a drama) come from app.js's localStorage
 * cache, and every write always reaches the network. This worker never
 * serves /api/* and never touches the platform's own /usernode-* paths.
 */
'use strict';

var VERSION = 'hc-v1';
var SHELL = [
  '/tracker',
  '/app.js',
  '/i18n.js',
  '/screens.css',
  '/tailwind.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/vendor/hls.min.js',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // Each entry on its own: one missing icon (a build that has not
      // rendered it yet, say) must not stop the whole shell from caching.
      return Promise.all(SHELL.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // Same-origin GET only. Writes and platform paths pass through untouched.
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/usernode-')) return;

  // A page load: network first (so a signed-in launch gets its fresh
  // shell), falling back to the cached shell when the network is gone.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put('/tracker', copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('/tracker').then(function (hit) {
          return hit || Response.error();
        });
      })
    );
    return;
  }

  // Everything else: cache first, refreshed in the background.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var fetching = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit || Response.error();
      });
      return hit || fetching;
    })
  );
});
