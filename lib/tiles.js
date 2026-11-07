/*
 * Map tiles kept on this server (frugal-iot-client docs/MAPPING_PLAN.md, M-19 to M-30).
 *
 * The map asks for /tiles/<source>/z/x/y. A tile kept here is served from disk; one that is not is
 * fetched from that source's upstream while it is reachable, and is a 404 at once while it is not.
 * So a Pi that goes offline still shows whatever was looked at while it was online.
 *
 * A file's mtime is when the tile was last known to be current, so a check that finds it unchanged
 * costs one metadata write, not a rewrite. Last use is kept in memory, never read from atime: a Pi
 * is often mounted noatime to spare its card, and where it is not, atime is a write per view.
 */

import fs from 'fs';
import path from 'path';
import { priorityQueue } from 'async';

const DAY_MS = 24 * 60 * 60 * 1000;
// Waiting on a timeout for every tile would freeze the map, so one failure stands for a minute
const OFFLINE_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const CONCURRENT_FETCHES = 2;     // OSM's tile usage policy
const VIEW = 0;                   // someone is looking - ahead of any prefetch
const PREFETCH = 1;
const MIN_REFRESH_DAYS = 7;       // OSM's tile usage policy: never re-ask sooner than this
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const CACHE_DEFAULTS = {
  dir: './tiles',
  refreshdays: 30,
  maxmb: 200,
  userAgent: `frugal-iot-server/${version} (+https://github.com/mitra42/frugal-iot-server)`,
};
// What a mapping.yaml with no sources gets: the map as it always was
export const DEFAULT_SOURCES = {
  osm: {
    name: 'Map',
    enabled: true,
    upstream: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
};

// The enabled sources, by id. The id becomes a directory and a URL segment, so it is held to letters
// and digits.
export function enabledSources(mapping) {
  const sources = (mapping && mapping.sources) || DEFAULT_SOURCES;
  const out = {};
  Object.entries(sources).forEach(([id, src]) => {
    if (!src || (src.enabled === false) || !/^[a-z0-9_-]{1,32}$/i.test(id) || !src.upstream) return;
    out[id] = { id, name: src.name || id, minzoom: 0, maxzoom: 19, ...src };
  });
  return out;
}

// What the map is told about each source (M-27): through this server while it keeps tiles,
// straight from upstream while it does not
export function sourcesForBrowser(mapping) {
  const cached = !!(mapping && mapping.cache && mapping.cache.enabled);
  return Object.values(enabledSources(mapping)).map((s) => ({
    id: s.id, name: s.name, attribution: s.attribution, minzoom: s.minzoom, maxzoom: s.maxzoom,
    url: cached ? `/tiles/${s.id}/{z}/{x}/{y}` : s.upstream,
    ...(s.bounds ? { bounds: s.bounds } : {}),
  }));
}

const clamp = (v, z) => Math.min(Math.max(v, 0), (2 ** z) - 1);
export function tileX(lon, z) {
  return clamp(Math.floor(((lon + 180) / 360) * (2 ** z)), z);
}
export function tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return clamp(Math.floor(((1 - (Math.log(Math.tan(r) + (1 / Math.cos(r))) / Math.PI)) / 2) * (2 ** z)), z);
}

// Within the source's zooms, and touching its bounds (bounds: [[south, west], [north, east]])
export function tileInSource(t, src) {
  if ((t.z < src.minzoom) || (t.z > src.maxzoom)) return false;
  if (!src.bounds) return true;
  const [[south, west], [north, east]] = src.bounds;
  return (t.x >= tileX(west, t.z)) && (t.x <= tileX(east, t.z))
    && (t.y >= tileY(north, t.z)) && (t.y <= tileY(south, t.z));
}

// z, x and y straight from the URL. Digits only, so none of it can name a path elsewhere.
export function parseTile(z, x, y, maxzoom = 22) {
  const m = /^(\d{1,7})(\.(png|jpg|jpeg|webp))?$/.exec(String(y));
  if (!m || !/^\d{1,2}$/.test(String(z)) || !/^\d{1,7}$/.test(String(x))) return null;
  const t = { z: Number(z), x: Number(x), y: Number(m[1]) };
  const n = 2 ** t.z;
  return ((t.z <= maxzoom) && (t.x < n) && (t.y < n)) ? t : null;
}

export const tileKey = (id, t) => `${id}/${t.z}/${t.x}/${t.y}`;

// The network edge, replaced in tests. cb(err) only when upstream could not be reached at all.
function fetchUpstream(url, { since, userAgent }, cb) {
  const headers = { 'User-Agent': userAgent };
  if (since) headers['If-Modified-Since'] = since.toUTCString();
  fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .then((r) => (r.ok
      ? r.arrayBuffer().then((b) => ({ status: r.status, type: r.headers.get('content-type'), body: Buffer.from(b) }))
      : { status: r.status }))
    .then((res) => cb(null, res), (err) => cb(err));
}

export function createTileCache(options = {}) {
  const o = { ...CACHE_DEFAULTS, ...options };
  const sources = o.sources ? enabledSources({ sources: o.sources }) : enabledSources(null);
  const fetchTile = o.fetchTile || fetchUpstream;
  const now = o.now || Date.now;
  const refreshMs = Math.max(o.refreshdays, MIN_REFRESH_DAYS) * DAY_MS;
  let keep = o.keep || (() => false);     // keys the prefetch still wants are never evicted
  const lastUsed = new Map();             // file -> ms
  const waiting = new Map();              // key -> [cb], so two views of one tile fetch it once
  const offlineUntil = {};                // by source: NSW being down does not stop OSM
  const lastExt = {};                     // by source, so a kept tile is usually found in one stat

  const base = (id, t) => path.join(o.dir, id, String(t.z), String(t.x), String(t.y));
  const urlOf = (src, t) => src.upstream.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  const online = (id) => now() >= (offlineUntil[id] || 0);

  const fetches = priorityQueue((job, cb) => fetchTile(job.url, { since: job.since, userAgent: o.userAgent }, cb),
    CONCURRENT_FETCHES);

  // cb(null, {file, st}) for the kept file, whichever type it was stored as, or cb(null, null)
  function find(id, t, cb) {
    const exts = [...new Set([lastExt[id] || '.png', ...Object.values(EXTENSIONS)])];
    let i = 0;
    const next = () => {
      if (i >= exts.length) return cb(null, null);
      const file = base(id, t) + exts[i++];
      fs.stat(file, (err, st) => {
        if (err) return next();
        lastExt[id] = path.extname(file);
        cb(null, { file, st });
      });
    };
    next();
  }

  function store(id, t, res, cb) {
    const ext = EXTENSIONS[String(res.type).split(';')[0].trim()] || '.png';
    const file = base(id, t) + ext;
    const tmp = `${file}.tmp`;   // renamed into place, so a half-written tile is never served
    fs.mkdir(path.dirname(file), { recursive: true }, (err) => {
      if (err) return cb(err);
      fs.writeFile(tmp, res.body, (err1) => (err1 ? cb(err1) : fs.rename(tmp, file, (err2) => {
        if (!err2) lastExt[id] = ext;
        cb(err2, file);
      })));
    });
  }

  // cb(null, file) when the tile is now current, cb(null, null) when it is not
  function refresh(src, t, kept, priority, cb) {
    const key = tileKey(src.id, t);
    if (!online(src.id)) return cb(null, null);
    if (waiting.has(key)) { waiting.get(key).push(cb); return; }
    waiting.set(key, [cb]);
    const done = (err, file) => {
      const cbs = waiting.get(key);
      waiting.delete(key);
      if (err) console.log('Tile', key, 'not kept:', err.message);
      cbs.forEach((c) => c(null, err ? null : file));
    };
    fetches.push({ url: urlOf(src, t), since: kept && kept.st.mtime }, priority, (err, res) => {
      if (err || (res.status === 429) || (res.status >= 500)) {
        offlineUntil[src.id] = now() + OFFLINE_RETRY_MS;
        return done(null, null);
      }
      if ((res.status === 304) && kept) {
        const d = new Date(now());
        return fs.utimes(kept.file, d, d, (err1) => done(err1, kept.file));
      }
      if (res.status === 200) return store(src.id, t, res, done);
      done(null, null);   // e.g. 404: upstream has no such tile
    });
  }

  // cb(null, file) to serve, or cb(null, null) for a 404. A kept tile is served at once even when
  // due a check - the check runs behind it, and offline a stale tile beats none.
  function get(id, t, cb) {
    const src = sources[id];
    if (!src || !tileInSource(t, src)) return cb(null, null);
    find(id, t, (err, kept) => {
      if (kept) {
        lastUsed.set(kept.file, now());
        if ((now() - kept.st.mtimeMs) > refreshMs) refresh(src, t, kept, VIEW, () => {});
        return cb(null, kept.file);
      }
      refresh(src, t, null, VIEW, (err1, file) => {
        if (file) lastUsed.set(file, now());
        cb(null, file);
      });
    });
  }

  // Fetch a tile nobody is looking at yet, if it is missing or due. cb(null, 'kept' | 'fetched' | 'failed')
  function prefetch(id, t, cb) {
    const src = sources[id];
    if (!src || !tileInSource(t, src)) return cb(null, 'failed');
    find(id, t, (err, kept) => {
      if (kept && ((now() - kept.st.mtimeMs) <= refreshMs)) return cb(null, 'kept');
      refresh(src, t, kept, PREFETCH, (err1, file) => cb(null, file ? 'fetched' : 'failed'));
    });
  }

  function listFiles(cb) {
    const found = [];
    const walk = (d, cb1) => fs.readdir(d, { withFileTypes: true }, (err, entries) => {
      if (err) return cb1(err.code === 'ENOENT' ? null : err);
      let i = 0;
      const next = (err1) => {
        if (err1 || (i >= entries.length)) return cb1(err1);
        const e = entries[i++];
        const full = path.join(d, e.name);
        if (e.isDirectory()) return walk(full, next);
        fs.stat(full, (err2, st) => {
          if (!err2) found.push({ file: full, size: st.size, used: lastUsed.get(full) || st.mtimeMs });
          next();
        });
      };
      next();
    });
    walk(o.dir, (err) => cb(err, found));
  }
  // dir/osm/15/26000/16900.png -> osm/15/26000/16900
  const keyOfFile = (file) => path.relative(o.dir, file).split(path.sep).join('/').replace(/\.[a-z]+$/, '');

  // Least recently used first, until under maxmb, across every source. After a restart, a tile not
  // yet viewed counts as last used when it was last known current.
  function evict(cb) {
    listFiles((err, files) => {
      if (err) return cb(err);
      let total = files.reduce((s, f) => s + f.size, 0);
      const limit = o.maxmb * 1024 * 1024;
      const victims = [];
      files.sort((a, b) => a.used - b.used);
      for (const f of files) {
        if (total <= limit) break;
        if (keep(keyOfFile(f.file))) continue;
        victims.push(f.file);
        total -= f.size;
      }
      let i = 0;
      const next = () => {
        if (i >= victims.length) return cb(null, { removed: victims.length, bytes: total });
        const file = victims[i++];
        lastUsed.delete(file);
        fs.unlink(file, () => next());
      };
      next();
    });
  }

  return { get, prefetch, evict, online, sources, setKeep: (fn) => { keep = fn; }, dir: o.dir };
}

// Once a day, like the readings' housekeeping - first pass delayed past the busy startup
export function startTileHousekeeping(cache) {
  const run = () => cache.evict((err, r) => {
    if (err) console.error('Tile housekeeping:', err.message);
    else if (r.removed) console.log('Tile housekeeping:', r.removed, 'tiles dropped');
  });
  setTimeout(run, 5 * 60 * 1000).unref();
  const timer = setInterval(run, DAY_MS);
  timer.unref();
  return timer;
}
