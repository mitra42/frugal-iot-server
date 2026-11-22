/**
 * lib/locations.js: which location a node has now, and where its GPS put it per bucket.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { nodeLocation, parseLocation, parseNodes, queryLocations } from '../../lib/locations.js';

const DAY = Date.parse('2026-09-24T00:00:00Z');
const H = 3600000;

describe('nodeLocation', () => {
  const set = { 'frugal_iot/location': { value: '-8.510013,115.264' } };
  const gps = (satellites, lat = -8.6, lon = 115.3) => ({
    'gps/satellites': { value: satellites }, 'gps/latitude': { value: lat }, 'gps/longitude': { value: lon },
  });
  it('a location set on the dashboard', () => {
    expect(nodeLocation(set)).toEqual({ lat: -8.510013, lon: 115.264, source: 'set' });
  });
  it('a GPS with a fix wins over a set location', () => {
    expect(nodeLocation({ ...set, ...gps(7) })).toEqual({ lat: -8.6, lon: 115.3, source: 'gps' });
  });
  it('a GPS with no satellites, or reporting NaN, falls back to the set location', () => {
    expect(nodeLocation({ ...set, ...gps(0) })).toMatchObject({ source: 'set' });
    expect(nodeLocation({ ...set, ...gps(7, NaN, NaN) })).toMatchObject({ source: 'set' });
    expect(nodeLocation(gps(0))).toBe(null);
  });
  it('nothing, or nonsense, is no location', () => {
    expect(nodeLocation({})).toBe(null);
    expect(nodeLocation()).toBe(null);
    for (const value of ['', '1,2,3', '91,0', '0,181', ',5', 'here', 42]) {
      expect(parseLocation(value)).toBe(null);
    }
  });
});

describe('parseNodes', () => {
  it('repeated or comma-separated, org/project/node only', () => {
    expect(parseNodes(['dev/lotus/a,dev/lotus/b', 'dev/magi/c/'])).toEqual([['dev', 'lotus', 'a'], ['dev', 'lotus', 'b'], ['dev', 'magi', 'c']]);
    expect(() => parseNodes('dev/lotus/+')).toThrow(/org\/project\/node/);
    expect(() => parseNodes('dev/lotus/a/sht')).toThrow(/org\/project\/node/);
    expect(() => parseNodes('dev/../a')).toThrow();
    expect(() => parseNodes(undefined)).toThrow(/node/);
  });
});

describe('queryLocations', () => {
  let dir;
  const put = (topic, rows) => {
    const d = join(dir, ...topic.split('/'));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '2026-09-24.csv'), rows.map(([t, v]) => `${t},"${v}"`).join('\n') + '\n');
  };
  const states = {
    a: { 'frugal_iot/location': { value: '-8.5,115.2' } },
    t: { 'gps/satellites': { value: 9 }, 'gps/latitude': { value: -8.52 }, 'gps/longitude': { value: 115.22 } },
  };
  const ask = (args) => queryLocations({
    dataDir: dir, mayRead: (org, project) => project === 'lotus',
    getNodeState: (org, project, id) => states[id] || {}, ...args,
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'locations-'));
    put('dev/lotus/a/sht/temperature', [[DAY, 20]]);
    // t moves in the first hour, stays put in the second; a no-fix NaN is dropped, not averaged
    put('dev/lotus/t/gps/latitude', [[DAY, -8.50], [DAY + 1000, 'nan'], [DAY + 2000, -8.52], [DAY + H, -8.52]]);
    put('dev/lotus/t/gps/longitude', [[DAY, 115.20], [DAY + 1000, 'nan'], [DAY + 2000, 115.22], [DAY + H, 115.22]]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('without a bucket, only where each node is now', async () => {
    const r = await ask({ node: 'dev/lotus/a,dev/lotus/t,dev/lotus/none' });
    expect(r.nodes).toEqual([
      { node: 'dev/lotus/a', location: { lat: -8.5, lon: 115.2, source: 'set' } },
      { node: 'dev/lotus/t', location: { lat: -8.52, lon: 115.22, source: 'gps' } },
      { node: 'dev/lotus/none', location: null },
    ]);
  });
  it('with a bucket, a GPS node\'s track: mean position and bounding box per bucket', async () => {
    const r = await ask({ node: 'dev/lotus/a,dev/lotus/t', from: String(DAY), to: String(DAY + 2 * H - 1), bucket: '1h' });
    expect(r.nodes[0].track).toBeUndefined();
    const [first, second] = r.nodes[1].track;
    expect(first).toMatchObject({ t: DAY, count: 2, south: -8.52, north: -8.50, west: 115.20, east: 115.22 });
    expect(first.lat).toBeCloseTo(-8.51);
    expect(first.lon).toBeCloseTo(115.21);
    expect(second).toMatchObject({ t: DAY + H, count: 1, lat: -8.52, south: -8.52, north: -8.52 });
  });
  it('a project that may not be read is refused', async () => {
    await expect(ask({ node: 'dev/magi/c' })).rejects.toMatchObject({ code: 'not_allowed' });
  });
});
