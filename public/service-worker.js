// Changing this version is what makes an already installed PWA fetch the app again instead of
// serving what it cached. It follows the version of frugal-iot-client this release installs, and
// "npm run prerelease" sets it - so there is normally no reason to edit it by hand.
const CACHE_NAME = 'frugal-iot-cache-1.3.14';
const urlsToCache = [
    '/',
    '/index.html',
    '/images/icon-192x192.png',
    '/images/icon-512x512.png',
    '/node_modules/html-element-extended/htmlelementextended.js',
    '/node_modules/mqtt/dist/mqtt.esm.js',
    '/node_modules/js-yaml/dist/js-yaml.mjs',
    '/node_modules/async/dist/async.mjs',
    '/node_modules/csv-parse/dist/esm/index.js',
    '/node_modules/chart.js/dist/chart.js',
    '/node_modules/dial-gauge/dial-gauge.js',
    '/node_modules/luxon/src/luxon.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => Promise.all(urlsToCache.map(url =>
                // 'reload' bypasses the HTTP cache, which serves /node_modules immutable for a day -
                // without it a same-day release caches the library it was meant to replace
                fetch(new Request(url, {cache: 'reload'}))
                    .then(response => response.ok
                        ? cache.put(url, response)
                        : Promise.reject(new Error(url + ' -> ' + response.status))))))
            // Without this the new worker waits until every tab of the origin is closed at once.
            // Reloading does not release the old one, so a release can stay invisible for days.
            .then(() => self.skipWaiting())
    );
});

// Delete old caches during activation
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(cacheNames => Promise.all(
                cacheNames.filter(cacheName => cacheName !== CACHE_NAME)
                    .map(cacheName => caches.delete(cacheName))))
            // Take over the pages that are already open, rather than only ones opened from now on
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        // Scoped to CACHE_NAME: a bare caches.match searches every cache in the origin, so a
        // leftover older cache answers first and the version bump achieves nothing
        caches.match(event.request, {cacheName: CACHE_NAME})
            .then(response => response || fetch(event.request))
    );
});
