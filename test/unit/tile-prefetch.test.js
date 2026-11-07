/*
 * What the tile prefetch asks for. All numbers - no network, no disk: the cache is a stand-in that
 * records what it was asked to fetch.
 */
import { describe, it, expect } from 'vitest';
import { boxRanges, deviceSquare, locationOf, loggerLocations, wantedTiles, createPrefetch } from '../../lib/tile-prefetch.js';
import { enabledSources, tileX, tileY } from '../../lib/tiles.js';

const OSM = enabledSources(null);
const WITH_NSW = enabledSources({ sources: {
  osm: { name: 'Map', upstream: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxzoom: 19 },
  nsw: { name: 'Imagery', upstream: 'https://maps.six.nsw.gov.au/tile/{z}/{y}/{x}', bounds: [[-38.4, 138.4], [-26.5, 159.3]], minzoom: 15, maxzoom: 21 },
} });

const lotus = (node, lat, lon, project = 'lotus') => ({ org: 'dev', project, node, lat, lon });
const of = (tiles, source = 'osm') => [...tiles.values()].filter((w) => w.source === source).map((w) => w.t);
const zooms = (tiles, source) => [...new Set(of(tiles, source).map((t) => t.z))].sort((a, b) => a - b);
const atZoom = (tiles, z, source) => of(tiles, source).filter((t) => t.z === z);
const want = (locs, sources = OSM) => wantedTiles(locs, {}, sources);

describe('tile numbers', () => {
  it('match the slippy map scheme', () => {
    // Jakarta, as fetched from OSM during development: zoom 10 tile 815/529
    expect(tileX(106.8, 10)).toBe(815);
    expect(tileY(-6.2, 10)).toBe(529);
    expect([tileX(-180, 0), tileY(85, 0)]).toEqual([0, 0]);
  });
  it('stay inside the world at its edges', () => {
    expect(tileX(180, 3)).toBe(7);
    expect(tileY(-89.9, 3)).toBe(7);
    expect(tileY(89.9, 3)).toBe(0);
  });
});

describe('a box is bounded by tiles, not zoom', () => {
  it('the whole world stops at zoom 3', () => {
    const world = { south: -80, north: 80, west: -179, east: 179 };
    expect(boxRanges(world, 64).map((r) => r.z)).toEqual([0, 1, 2, 3]);
  });
  it('a district goes much deeper', () => {
    const district = { south: -6.3, north: -6.1, west: 106.7, east: 106.9 };
    const deepest = boxRanges(district, 64).pop().z;
    expect(deepest).toBeGreaterThanOrEqual(10);
    expect(deepest).toBeLessThanOrEqual(13);
  });
  it('and never past zoom 16, however small - deep tiles are only for device squares', () => {
    expect(boxRanges({ south: -6.2, north: -6.2, west: 106.8, east: 106.8 }, 256).pop().z).toBe(16);
  });
});

describe('what is wanted', () => {
  it('a device: about a hundred tiles, down to zoom 19 around it', () => {
    const square = deviceSquare({ lat: -6.2, lon: 106.8 }, 250);
    expect(square.north - square.south).toBeCloseTo(500 / 111320, 6);
    const tiles = want([lotus('n1', -6.2, 106.8)]);
    expect(zooms(tiles).pop()).toBe(19);
    expect(atZoom(tiles, 19).length).toBeGreaterThan(30);
    expect(atZoom(tiles, 19).length).toBeLessThan(100);
    expect(tiles.size).toBeLessThan(200);
  });

  it('two devices close together share their tiles', () => {
    const one = want([lotus('n1', -6.2, 106.8)]).size;
    const two = want([lotus('n1', -6.2, 106.8), lotus('n2', -6.2001, 106.8001)]).size;
    expect(two).toBeLessThan(one * 1.3);
  });

  it('a project of two far-apart devices gets detail at each, not across the gap', () => {
    const tiles = want([lotus('jakarta', -6.2, 106.8), lotus('london', 51.5, -0.1)]);
    expect(tiles.size).toBeLessThan(600);
    const deep = atZoom(tiles, 19);
    expect(deep.every((t) => (t.x === tileX(106.8, 19)) || Math.abs(t.x - tileX(106.8, 19)) < 10
      || Math.abs(t.x - tileX(-0.1, 19)) < 10)).toBe(true);
  });

  it('nothing at 17 or deeper outside the device squares', () => {
    const locs = [lotus('n1', -6.2, 106.8), lotus('n2', -6.25, 106.85, 'paddy')];
    const squares = locs.map((l) => deviceSquare(l, 250));
    for (const t of of(want(locs)).filter((x) => x.z >= 17)) {
      const inside = squares.some((s) => (t.x >= tileX(s.west, t.z)) && (t.x <= tileX(s.east, t.z))
        && (t.y >= tileY(s.north, t.z)) && (t.y <= tileY(s.south, t.z)));
      expect(inside).toBe(true);
    }
  });

  it('nothing when nothing is located', () => {
    expect(want([]).size).toBe(0);
  });
});

describe('a device\'s location', () => {
  it('a GPS with a fix wins, as on the map', () => {
    expect(locationOf({ location: '-6.2,106.8', latitude: -6.3, longitude: 106.9, satellites: 5 })).toEqual({ lat: -6.3, lon: 106.9 });
    expect(locationOf({ location: '-6.2,106.8', latitude: 0, longitude: 0, satellites: 0 })).toEqual({ lat: -6.2, lon: 106.8 });
  });
  it('nothing for no location, or nonsense', () => {
    for (const v of [{}, { location: '' }, { location: 'here' }, { location: '91,0' }, { location: '0,181' }]) {
      expect(locationOf(v)).toBeNull();
    }
  });
  it('read from what the logger last heard', () => {
    const values = { 'dev/lotus/n1/frugal_iot/location': '-6.2,106.8', 'dev/lotus/n2/frugal_iot/name': 'Unplaced' };
    const logger = {
      reportNodes: () => ({ dev: { lotus: { n1: {}, n2: {} } } }),
      getPropertyValue: (org, project, node, field) => values[`${org}/${project}/${node}/${field}`],
    };
    expect(loggerLocations(logger)).toEqual([lotus('n1', -6.2, 106.8)]);
  });
});

describe('running it', () => {
  function setup(locs, answer = () => 'fetched') {
    const asked = [];
    let keep;
    let online = true;
    const cache = {
      sources: OSM,
      online: () => online,
      setKeep: (fn) => { keep = fn; },
      prefetch: (id, t, cb) => { asked.push(t); setImmediate(() => cb(null, answer(t))); },
    };
    let clock = 0;
    const p = createPrefetch(cache, {}, () => locs.current, () => clock);
    const check = () => new Promise((resolve) => p.check((err, counts) => resolve(counts)));
    return { asked, check, keep: (f) => keep(f), setOnline: (v) => { online = v; },
      advance: (ms) => { clock += ms; } };
  }

  it('fetches what is wanted, and keeps it from eviction', async () => {
    const locs = { current: [lotus('n1', -6.2, 106.8)] };
    const s = setup(locs);
    const counts = await s.check();
    expect(counts.fetched).toBe(s.asked.length);
    expect(s.asked.length).toBe(want(locs.current).size);
    expect(s.keep(`osm/19/${tileX(106.8, 19)}/${tileY(-6.2, 19)}`)).toBe(true);
    expect(s.keep('osm/19/0/0')).toBe(false);
  });

  it('runs again only when a device moves, or a day on', async () => {
    const locs = { current: [lotus('n1', -6.2, 106.8)] };
    const s = setup(locs);
    await s.check();
    expect(await s.check()).toBeNull();
    locs.current = [lotus('n1', -6.21, 106.8)];
    expect(await s.check()).not.toBeNull();
    expect(s.keep(`osm/19/${tileX(106.8, 19)}/${tileY(-6.2, 19)}`)).toBe(false);   // the old square may now go
    s.advance(25 * 60 * 60 * 1000);
    expect(await s.check()).not.toBeNull();
  });

  it('a run with failures is tried again at the next check; offline, not at all', async () => {
    const locs = { current: [lotus('n1', -6.2, 106.8)] };
    const s = setup(locs, () => 'failed');
    expect((await s.check()).failed).toBeGreaterThan(0);
    s.setOnline(false);
    expect(await s.check()).toBeNull();
    s.setOnline(true);
    expect(await s.check()).not.toBeNull();
  });
});

describe('a source with bounds', () => {
  const sydney = lotus('farm', -33.87, 151.21);
  const jakarta = lotus('paddy', -6.2, 106.8, 'ricefield');

  it('only device squares inside it, from its minzoom, down to devicezoom', () => {
    const tiles = want([sydney, jakarta], WITH_NSW);
    expect(zooms(tiles, 'nsw')).toEqual([15, 16, 17, 18, 19]);
    expect(of(tiles, 'nsw').every((t) => Math.abs(t.x - tileX(151.21, t.z)) < 10)).toBe(true);   // none near Jakarta
    expect(zooms(tiles, 'osm')[0]).toBe(0);   // the map still gets its box layers
  });

  it('deeper only when devicezoom says so', () => {
    expect(zooms(wantedTiles([sydney], { devicezoom: 21 }, WITH_NSW), 'nsw').pop()).toBe(21);
    expect(zooms(wantedTiles([sydney], { devicezoom: 21 }, WITH_NSW), 'osm').pop()).toBe(19);
  });

  it('not across the gaps between devices, as the map\'s project layer would be', () => {
    const east = lotus('east', -33.87, 151.25);   // about 4 km from the farm
    const near = (t, l) => (Math.abs(t.x - tileX(l.lon, t.z)) <= 1) && (Math.abs(t.y - tileY(l.lat, t.z)) <= 1);
    const tiles = want([sydney, east], WITH_NSW);
    expect(atZoom(tiles, 16, 'nsw').every((t) => near(t, sydney) || near(t, east))).toBe(true);
    expect(atZoom(tiles, 16, 'osm').some((t) => !near(t, sydney) && !near(t, east))).toBe(true);
  });

  it('nothing for it when no device is inside', () => {
    expect(of(want([jakarta], WITH_NSW), 'nsw')).toEqual([]);
  });
});
