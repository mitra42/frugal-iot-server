// Change this version number if want existing installs of PWA to refresh their cache
// TODO-28 - probably make this the same as the app version in frugal-iot-client
const CACHE_NAME = 'frugal-iot-cache-1.3.3';
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
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});

// Delete old caches during activation
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
