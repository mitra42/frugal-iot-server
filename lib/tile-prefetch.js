/*
 * Fetching, while online, the tiles a Pi will need once it is not (frugal-iot-client
 * docs/MAPPING_PLAN.md M-21, M-30). For each source without bounds, three layers:
 *  - each organization's devices' bounding box, at every zoom while it needs no more than
 *    organizationtiles - so zooming out always finds a map;
 *  - the same for each project, with projecttiles;
 *  - a square deviceradius metres around each device, down to devicezoom.
 * An organization, or even a project, can span the world, so the boxes are bounded by tiles, not
 * zoom: the whole world stops at zoom 3, a district goes to about 12.
 *
 * A source with bounds - imagery for one state, say - gets only the device squares inside them, from
 * its minzoom: the box layers are what an unbounded map is for.
 *
 * Locations are what the logger last heard - it keeps the current value of every topic, retained
 * ones included - so this needs no subscription of its own.
 */

import { eachLimit } from 'async';
import { tileInSource, tileKey, tileX, tileY } from './tiles.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 10 * 60 * 1000;          // how soon a moved device's area is fetched
const FIRST_CHECK_MS = 2 * 60 * 1000;     // retained locations arrive just after the logger connects
const BOX_MAX_ZOOM = 16;                  // OSM's policy: deep tiles only in the small device squares
const METRES_PER_DEGREE = 111320;

export const PREFETCH_DEFAULTS = {
  organizationtiles: 64,
  projecttiles: 256,
  deviceradius: 250,
  devicezoom: 19,
};

function boxRange(box, z) {
  return { z, x0: tileX(box.west, z), x1: tileX(box.east, z), y0: tileY(box.north, z), y1: tileY(box.south, z) };
}
const rangeCount = (r) => ((r.x1 - r.x0) + 1) * ((r.y1 - r.y0) + 1);

function addRange(tiles, src, r) {
  for (let x = r.x0; x <= r.x1; x++) {
    for (let y = r.y0; y <= r.y1; y++) {
      const t = { z: r.z, x, y };
      if (tileInSource(t, src)) tiles.set(tileKey(src.id, t), { source: src.id, t });
    }
  }
}

// Each zoom from 0 while the box fits in budget tiles
export function boxRanges(box, budget, maxzoom = BOX_MAX_ZOOM) {
  const ranges = [];
  for (let z = 0; z <= maxzoom; z++) {
    const r = boxRange(box, z);
    if (rangeCount(r) > budget) break;
    ranges.push(r);
  }
  return ranges;
}

export function deviceSquare({ lat, lon }, radius) {
  const dLat = radius / METRES_PER_DEGREE;
  const dLon = radius / (METRES_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

function bounds(locs) {
  return {
    south: Math.min(...locs.map((l) => l.lat)), north: Math.max(...locs.map((l) => l.lat)),
    west: Math.min(...locs.map((l) => l.lon)), east: Math.max(...locs.map((l) => l.lon)),
  };
}

const insideBounds = (l, b) => !b || ((l.lat >= b[0][0]) && (l.lat <= b[1][0]) && (l.lon >= b[0][1]) && (l.lon <= b[1][1]));

// locations: [{ org, project, node, lat, lon }], sources: enabledSources() ->
// Map 'source/z/x/y' -> { source, t: { z, x, y } }
export function wantedTiles(locations, settings, sources) {
  const s = { ...PREFETCH_DEFAULTS, ...settings };
  const tiles = new Map();
  const groups = (keyOf) => locations.reduce((g, l) => { (g[keyOf(l)] = g[keyOf(l)] || []).push(l); return g; }, {});
  Object.values(sources).forEach((src) => {
    if (!src.bounds) {
      Object.values(groups((l) => l.org)).forEach((locs) =>
        boxRanges(bounds(locs), s.organizationtiles).forEach((r) => addRange(tiles, src, r)));
      Object.values(groups((l) => `${l.org}/${l.project}`)).forEach((locs) =>
        boxRanges(bounds(locs), s.projecttiles).forEach((r) => addRange(tiles, src, r)));
    }
    locations.filter((l) => insideBounds(l, src.bounds)).forEach((l) => {
      const square = deviceSquare(l, s.deviceradius);
      for (let z = src.minzoom; z <= Math.min(s.devicezoom, src.maxzoom); z++) addRange(tiles, src, boxRange(square, z));
    });
  });
  return tiles;
}

// As the client decides it (core.js MqttTopicNode.location): a GPS with a fix wins over a set location
export function locationOf({ location, latitude, longitude, satellites }) {
  let lat; let lon;
  if ((Number(satellites) > 0) && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    lat = Number(latitude); lon = Number(longitude);
  } else if (typeof location === 'string') {
    [lat, lon] = location.split(',').map(Number);
  }
  return (Number.isFinite(lat) && Number.isFinite(lon) && (Math.abs(lat) <= 90) && (Math.abs(lon) <= 180))
    ? { lat, lon } : null;
}

export function loggerLocations(mqttLogger) {
  const out = [];
  Object.entries(mqttLogger.reportNodes()).forEach(([org, projects]) => {
    Object.entries(projects).forEach(([project, nodes]) => {
      Object.keys(nodes).forEach((node) => {
        const v = (field) => mqttLogger.getPropertyValue(org, project, node, field);
        const loc = locationOf({ location: v('frugal_iot/location'), latitude: v('gps/latitude'),
          longitude: v('gps/longitude'), satellites: v('gps/satellites') });
        if (loc) out.push({ org, project, node, ...loc });
      });
    });
  });
  return out;
}

// locations() is asked at each check. Runs when the locations change, and daily to refresh; a run
// with failures (offline, most likely) is tried again at the next check.
export function createPrefetch(cache, settings, locations, now = Date.now) {
  const s = { ...PREFETCH_DEFAULTS, ...settings };
  let wanted = new Map();
  let done = { signature: null, at: 0 };
  let running = false;
  cache.setKeep((key) => wanted.has(key));

  function check(cb = () => {}) {
    if (running) return cb(null, null);
    const locs = locations();
    const tiles = wanted = wantedTiles(locs, s, cache.sources);
    const signature = locs.map((l) => `${l.org}/${l.project}/${l.node}=${l.lat},${l.lon}`).sort().join(';');
    if ((signature === done.signature) && ((now() - done.at) < DAY_MS)) return cb(null, null);
    if (!Object.keys(cache.sources).some((id) => cache.online(id))) return cb(null, null);
    running = true;
    const counts = { kept: 0, fetched: 0, failed: 0 };
    // Two at a time, so the stat calls stay few and a view never queues behind a thousand tiles
    eachLimit([...tiles.values()], 2, (w, cb1) => cache.prefetch(w.source, w.t, (err, result) => { counts[result] += 1; cb1(); }), () => {
      running = false;
      if (!counts.failed) done = { signature, at: now() };
      if (counts.fetched || counts.failed) {
        console.log('Tile prefetch:', tiles.size, 'wanted,', counts.fetched, 'fetched,', counts.failed, 'failed');
      }
      cb(null, counts);
    });
  }
  return { check };
}

export function startPrefetch(cache, settings, locations) {
  const p = createPrefetch(cache, settings, locations);
  setTimeout(() => p.check(), FIRST_CHECK_MS).unref();
  setInterval(() => p.check(), CHECK_MS).unref();
  return p;
}
