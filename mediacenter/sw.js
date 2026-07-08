// A deliberately minimal service worker (same shape as the webapp demo's). The
// browser only allows registration in a secure context - a Tor .onion counts, a
// plain http:// LAN link does not - so this is a quiet nicety, never a dependency.
//
// It intentionally has NO 'fetch' handler and does NO caching: a media library
// changes underneath the app (files added, posters swapped, the LAN editor), and a
// stale cached shell would be worse than none. It just takes control of open pages.
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
