/*
 * Map tiles kept on this server. Upstream is a stand-in and the clock is ours, so every case runs
 * with no network: what is served, what is fetched, and what is dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTileCache, parseTile, tileX, tileY } from '../../lib/tiles.js';

const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from('a tile');
let dir, clock, calls, answer;

// answer(url, since) -> {status, body} or an Error for "could not reach upstream"
function cache(o = {}) {
  return createTileCache({
    dir, now: () => clock,
    fetchTile: (url, { since, userAgent }, cb) => {
      calls.push({ url, since, userAgent });
      const r = answer(url, since);
      setImmediate(() => ((r instanceof Error) ? cb(r) : cb(null, r)));
    },
    ...o,
  });
}
const get = (c, t, id = 'osm') => new Promise((resolve) => c.get(id, t, (err, file) => resolve(file)));
const evict = (c) => new Promise((resolve) => c.evict((err, r) => resolve(r)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const T = { z: 15, x: 26000, y: 16900 };
const fileOf = (t) => path.join(dir, 'osm', String(t.z), String(t.x), `${t.y}.png`);
function keep(t, size, mtime) {
  fs.mkdirSync(path.dirname(fileOf(t)), { recursive: true });
  fs.writeFileSync(fileOf(t), Buffer.alloc(size));
  fs.utimesSync(fileOf(t), new Date(mtime), new Date(mtime));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-'));
  clock = Date.parse('2026-11-07T12:00:00Z');
  calls = [];
  answer = () => ({ status: 200, type: 'image/png', body: PNG });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a tile in the URL', () => {
  it('is three numbers inside the world at that zoom', () => {
    expect(parseTile('15', '26000', '16900.png')).toEqual(T);
    expect(parseTile('0', '0', '0.png')).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTile('2', '4', '0.png')).toBeNull();       // zoom 2 is 4 tiles across: 0 to 3
    expect(parseTile('15', '26000', '16900')).toEqual(T);   // the extension is optional
    expect(parseTile('23', '0', '0')).toBeNull();           // deeper than any source goes
  });
  it('and nothing else, since it becomes a file path', () => {
    for (const [z, x, f] of [['..', '0', '0.png'], ['1', '..', '0.png'], ['1', '0', '../0.png'],
      ['1', '0', '0.png/..'], ['1', '0', '0.gif'], ['1', '-1', '0.png'], ['1', '0x1', '0.png'], ['1', '0', '.png']]) {
      expect(parseTile(z, x, f), `${z}/${x}/${f}`).toBeNull();
    }
  });
});

describe('serving', () => {
  it('a kept tile, without asking upstream', async () => {
    keep(T, 10, clock - DAY);
    expect(await get(cache(), T)).toBe(fileOf(T));
    expect(calls).toEqual([]);
  });

  it('a tile not kept is fetched, kept, and identified to upstream', async () => {
    const c = cache();
    expect(await get(c, T)).toBe(fileOf(T));
    expect(fs.readFileSync(fileOf(T))).toEqual(PNG);
    expect(calls[0].url).toBe('https://tile.openstreetmap.org/15/26000/16900.png');
    expect(calls[0].since).toBeNull();
    expect(calls[0].userAgent).toMatch(/^frugal-iot-server\/\d+\.\d+\.\d+ \(\+https:\/\//);
  });

  it('two views of one tile fetch it once', async () => {
    const c = cache();
    const [a, b] = await Promise.all([get(c, T), get(c, T)]);
    expect(a).toBe(fileOf(T));
    expect(b).toBe(fileOf(T));
    expect(calls.length).toBe(1);
  });

  it('a tile upstream does not have is a 404, and does not mean offline', async () => {
    answer = (url) => (url.includes('/16900.png') ? { status: 404 } : { status: 200, type: 'image/png', body: PNG });
    const c = cache();
    expect(await get(c, T)).toBeNull();
    expect(await get(c, { ...T, y: 16901 })).toBe(fileOf({ ...T, y: 16901 }));
  });
});

describe('offline', () => {
  it('a miss is a 404 at once, and upstream is left alone for a minute', async () => {
    answer = () => new Error('getaddrinfo ENOTFOUND');
    const c = cache();
    expect(await get(c, T)).toBeNull();
    expect(await get(c, { ...T, y: 16901 })).toBeNull();
    expect(calls.length).toBe(1);
    clock += 61 * 1000;
    answer = () => ({ status: 200, type: 'image/png', body: PNG });
    expect(await get(c, { ...T, y: 16901 })).not.toBeNull();
  });

  it('an overloaded upstream is treated the same way', async () => {
    answer = () => ({ status: 429 });
    const c = cache();
    await get(c, T);
    await get(c, { ...T, y: 16901 });
    expect(calls.length).toBe(1);
  });

  it('a stale tile is still served', async () => {
    answer = () => new Error('offline');
    keep(T, 10, clock - 400 * DAY);
    expect(await get(cache(), T)).toBe(fileOf(T));
    await settle();
    expect(fs.existsSync(fileOf(T))).toBe(true);
  });
});

describe('refreshing', () => {
  it('not before refreshdays', async () => {
    keep(T, 10, clock - 29 * DAY);
    await get(cache(), T);
    await settle();
    expect(calls).toEqual([]);
  });

  it('never sooner than OSM allows, whatever the config says', async () => {
    keep(T, 10, clock - 3 * DAY);
    await get(cache({ refreshdays: 1 }), T);
    await settle();
    expect(calls).toEqual([]);
  });

  it('after it, served at once and checked behind; unchanged costs only the mtime', async () => {
    const mtime = clock - 31 * DAY;
    keep(T, 10, mtime);
    answer = () => ({ status: 304 });
    expect(await get(cache(), T)).toBe(fileOf(T));
    await settle();
    expect(calls[0].since.getTime()).toBe(mtime);
    expect(fs.statSync(fileOf(T)).mtimeMs).toBe(clock);
    expect(fs.statSync(fileOf(T)).size).toBe(10);
  });

  it('a changed tile replaces the old one', async () => {
    keep(T, 10, clock - 31 * DAY);
    await get(cache(), T);
    await settle();
    expect(fs.readFileSync(fileOf(T))).toEqual(PNG);
  });
});

describe('keeping to size', () => {
  const MB = 1024 * 1024;
  const A = { ...T, y: 1 }; const B = { ...T, y: 2 }; const C = { ...T, y: 3 };

  it('nothing goes while under maxmb', async () => {
    keep(A, MB, clock - 9 * DAY);
    expect((await evict(cache({ maxmb: 2 }))).removed).toBe(0);
  });

  it('least recently used first, by view in memory rather than atime', async () => {
    keep(A, MB, clock - 9 * DAY);   // known current longest ago, but viewed just now
    keep(B, MB, clock - 5 * DAY);
    keep(C, MB, clock - 1 * DAY);
    const c = cache({ maxmb: 2 });
    await get(c, A);
    expect((await evict(c)).removed).toBe(1);
    expect(fs.existsSync(fileOf(A))).toBe(true);
    expect(fs.existsSync(fileOf(B))).toBe(false);
    expect(fs.existsSync(fileOf(C))).toBe(true);
  });

  it('never a tile the prefetch still wants', async () => {
    keep(A, MB, clock - 9 * DAY);
    keep(B, MB, clock - 5 * DAY);
    keep(C, MB, clock - 1 * DAY);
    const c = cache({ maxmb: 2, keep: (key) => key === `osm/${A.z}/${A.x}/${A.y}` });
    await evict(c);
    expect(fs.existsSync(fileOf(A))).toBe(true);
    expect(fs.existsSync(fileOf(B))).toBe(false);
  });

  it('an empty cache is not an error', async () => {
    expect((await evict(cache())).removed).toBe(0);
  });
});

describe('prefetching', () => {
  const prefetch = (c, t) => new Promise((resolve) => c.prefetch('osm', t, (err, r) => resolve(r)));

  it('leaves a fresh tile alone, and fetches a missing one', async () => {
    keep(T, 10, clock - DAY);
    const c = cache();
    expect(await prefetch(c, T)).toBe('kept');
    expect(await prefetch(c, { ...T, y: 16901 })).toBe('fetched');
    expect(calls.length).toBe(1);
  });

  it('a view goes ahead of every prefetch still waiting', async () => {
    const held = [];
    const c = createTileCache({ dir, now: () => clock,
      fetchTile: (url, o, cb) => { calls.push(url); held.push(cb); } });
    [1, 2, 3, 4].forEach((y) => c.prefetch('osm', { ...T, y }, () => {}));
    c.get('osm', { ...T, y: 99 }, () => {});
    await settle();
    expect(calls.length).toBe(2);   // two at once
    held.shift()(null, { status: 404 });
    await settle();
    expect(calls[2]).toMatch(/\/99\.png$/);
  });
});

describe('several sources', () => {
  // Sydney, inside NSW's bounds; Jakarta, outside them
  const syd = (z) => ({ z, x: tileX(151.21, z), y: tileY(-33.87, z) });
  const jkt = (z) => ({ z, x: tileX(106.8, z), y: tileY(-6.2, z) });
  const JPG = Buffer.from('a photo');
  const sources = {
    osm: { name: 'Map', upstream: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxzoom: 19 },
    nsw: { name: 'Imagery', upstream: 'https://maps.six.nsw.gov.au/tile/{z}/{y}/{x}',
           bounds: [[-38.4, 138.4], [-26.5, 159.3]], minzoom: 15, maxzoom: 21 },
    off: { name: 'Imagery', enabled: false, upstream: 'https://example.org/{z}/{x}/{y}' },
  };
  const both = () => cache({ sources });

  it('each from its own upstream, in its own order, kept as the type it was sent', async () => {
    answer = (url) => (url.includes('six.nsw') ? { status: 200, type: 'image/jpeg', body: JPG } : { status: 200, type: 'image/png', body: PNG });
    const c = both();
    const t = syd(20);
    const file = await get(c, t, 'nsw');
    expect(calls[0].url).toBe(`https://maps.six.nsw.gov.au/tile/20/${t.y}/${t.x}`);
    expect(file).toBe(path.join(dir, 'nsw', '20', String(t.x), `${t.y}.jpg`));
    expect(fs.readFileSync(file)).toEqual(JPG);
    expect(await get(c, t, 'nsw')).toBe(file);   // and found again as a .jpg
    expect(calls.length).toBe(1);
  });

  it('nothing asked for outside a source\'s bounds or zooms', async () => {
    const c = both();
    expect(await get(c, jkt(17), 'nsw')).toBeNull();
    expect(await get(c, syd(14), 'nsw')).toBeNull();
    expect(await get(c, syd(22), 'nsw')).toBeNull();
    expect(await get(c, syd(20), 'osm')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('nor from a source that is switched off, or not there', async () => {
    const c = both();
    expect(await get(c, T, 'off')).toBeNull();
    expect(await get(c, T, 'nosuch')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('one source being down does not stop another', async () => {
    answer = (url) => (url.includes('six.nsw') ? new Error('ENOTFOUND') : { status: 200, type: 'image/png', body: PNG });
    const c = both();
    expect(await get(c, syd(16), 'nsw')).toBeNull();
    expect(c.online('nsw')).toBe(false);
    expect(await get(c, syd(16), 'osm')).not.toBeNull();
  });

  it('no sources configured is OpenStreetMap', async () => {
    expect(Object.keys(cache().sources)).toEqual(['osm']);
  });
});
