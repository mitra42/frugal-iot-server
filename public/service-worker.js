// Changing this version is what makes an already installed PWA fetch the app again instead of
// serving what it cached. It follows the version of frugal-iot-client this release installs, and
// "npm run prerelease" sets it - so there is normally no reason to edit it by hand.
//
// The suffix is here because urlsToCache below CHANGED without the client version changing. Without
// it, an installed browser keeps serving the files it already cached - and since the list now covers
// the dashboard's own code, that means old JS behind freshly fetched HTML. Any edit to the list
// needs this bumped, or it does not reach anyone who already has the old one.
const CACHE_NAME = 'frugal-iot-cache-1.3.15-2';
/*
 * Everything the app needs, so that a phone on a poor or expensive link fetches it once.
 *
 * The dashboard's OWN code was missing from this list, which was most of the point of having one:
 * eight files - the entry point, five modules and the stylesheet - were fetched from the network on
 * every visit while the libraries beside them came from the cache.
 *
 * Two rules for anything added here:
 *
 * 1. It must return 200 WITHOUT a session. install() rejects the whole cache if any single entry
 *    fails, so one 404 or one redirect-to-login means this PWA has no cache at all - and the app
 *    goes on working online, so nothing announces it. /dashboard/*.js and the stylesheet do serve
 *    unauthenticated; /dashboard/index.html does NOT (it 307s to the login page).
 * 2. It must not be a session-gated PAGE. Beyond breaking install, a cached /dashboard/index.html
 *    would be served to a logged-out visitor - which is the "accessing from service worker which
 *    has /dashboard cached" case admin.js already had to handle.
 *
 * Deliberately absent:
 *   /dashboard/index.html          session-gated, see above
 *   /node_modules/esptool-js/*     ~1MB, wanted on one screen, and not by the phone users this list
 *                                  exists for
 *
 * Every URL below was checked against a running server. Two entries in index.html's importmap were
 * not, and are dead: "chart.js" points at dist/Chart.js, which does not exist (the file is
 * lowercase, and graph.js imports the full path anyway), and "chartjs-adapter-luxon" points into a
 * package that is not installed at all - its code was copied into core.js instead. Neither is
 * reachable today; both would 404 the moment somebody used the bare specifier.
 */
const urlsToCache = [
    // The public landing page and the PWA's own furniture
    '/',
    '/index.html',
    '/manifest.json',
    '/favicon.ico',
    '/images/icon-192x192.png',
    '/images/icon-512x512.png',
    // The dashboard: its stylesheet, its entry point, and the modules dashboard.js imports
    '/dashboard/frugaliot.css',
    '/dashboard/dashboard.js',
    '/dashboard/core.js',
    '/dashboard/widgets.js',
    '/dashboard/graph.js',
    '/dashboard/admin.js',
    '/dashboard/flash.js',
    '/dashboard/cards.js',
    // Logging in - the page a visitor lands on when the session has gone
    '/dashboard/login.html',
    '/dashboard/login.js',
    // Libraries, at the paths index.html's importmap and the modules actually use
    '/node_modules/html-element-extended/htmlelementextended.js',
    '/node_modules/mqtt/dist/mqtt.esm.js',
    '/node_modules/js-yaml/dist/js-yaml.mjs',
    '/node_modules/async/dist/async.mjs',
    '/node_modules/csv-parse/dist/esm/index.js',
    '/node_modules/chart.js/dist/chart.js',
    '/node_modules/@kurkle/color/dist/color.esm.js',   // chart.js needs it; was missing
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
