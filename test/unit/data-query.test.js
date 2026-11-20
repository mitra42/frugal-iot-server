/*
 * Asking for readings (lib/data-query.js): what a request may name, what it is allowed to reach, what
 * comes back raw and bucketed, the limits, and the SenML it is turned into.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import {
  parseSelectors, parseBucket, parseAggs, parseTimeZone, parseTime, tzOffsetMs, bucketStart,
  expandSelectors, queryData, toSenMLPacks, LIMITS,
} from '../../lib/data-query.js';

const H = 3600 * 1000;
const DAY = Date.parse('2026-09-24T00:00:00Z');
let dir;
const put = (topic, file, text, gz = false) => {
  const d = join(dir, ...topic.split('/'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), gz ? gzipSync(text) : text);
};
const lines = (...rows) => rows.map(([t, v]) => `${t},"${v}"`).join('\n') + '\n';
const everything = () => true;
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'resolved'; };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'data-query-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parsing', () => {
  it('device may be repeated, comma-separated, or both, and repeats are dropped', () => {
    expect(parseSelectors(['dev/lotus/a/sht/temperature,dev/lotus/b', 'dev/lotus/a/sht/temperature']))
      .toEqual([['dev', 'lotus', 'a', 'sht', 'temperature'], ['dev', 'lotus', 'b']]);
    expect(parseSelectors('dev/lotus/a/')).toEqual([['dev', 'lotus', 'a']]);
  });
  it('"+" is one level, anywhere but the organization', () => {
    expect(parseSelectors('dev/+/+/sht/temperature')).toEqual([['dev', '+', '+', 'sht', 'temperature']]);
    expect(() => parseSelectors('+/lotus/a')).toThrow(/Bad device/);
  });
  it('refuses anything that is not three to five plain levels', () => {
    for (const bad of ['dev/lotus', 'dev/lotus/a/b/c/d', 'dev/../varta/a', 'dev/lotus/a b', 'dev/lotus/#', 'dev//a']) {
      expect(() => parseSelectors(bad), bad).toThrow(/Bad device/);
    }
    expect(() => parseSelectors(undefined)).toThrow(/device/);
    expect(() => parseSelectors(Array.from({ length: 51 }, (_, i) => `dev/lotus/n${i}`))).toThrow(/At most 50/);
  });
  it('bucket, agg, tz and times', () => {
    expect(parseBucket('15m')).toBe(15 * 60 * 1000);
    expect(parseBucket('1d')).toBe(24 * H);
    expect(parseBucket(undefined)).toBeUndefined();
    for (const bad of ['0h', '1w', 'h', '1.5h', '367d']) expect(() => parseBucket(bad), bad).toThrow(/bucket/);
    expect(parseAggs('max,mean')).toEqual(['mean', 'max']);
    expect(parseAggs(undefined)).toEqual(['mean', 'min', 'max', 'count']);
    expect(() => parseAggs('median')).toThrow(/agg/);
    expect(parseTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(parseTimeZone(undefined)).toBe('UTC');
    expect(() => parseTimeZone('Mars/Olympus')).toThrow(/time zone/);
    expect(parseTime('1758672000', 'from')).toBe(1758672000000);
    expect(parseTime('1758672000000', 'from')).toBe(1758672000000);
    expect(parseTime('2025-09-24T00:00:00Z', 'from')).toBe(Date.parse('2025-09-24T00:00:00Z'));
    expect(() => parseTime('yesterday', 'from')).toThrow(/"from"/);
  });
});

describe('time zones and buckets', () => {
  it('knows the offset, including a half-hour zone and summer time', () => {
    expect(tzOffsetMs('UTC', DAY)).toBe(0);
    expect(tzOffsetMs('Asia/Kolkata', DAY)).toBe(5.5 * H);
    expect(tzOffsetMs('Europe/London', Date.parse('2026-07-01T12:00:00Z'))).toBe(H);
    expect(tzOffsetMs('Europe/London', Date.parse('2026-01-01T12:00:00Z'))).toBe(0);
  });
  it('lines buckets up with the local clock', () => {
    const t = Date.parse('2026-09-24T10:10:00Z'); // 15:40 in Kolkata
    expect(new Date(bucketStart(t, H, 'UTC')).toISOString()).toBe('2026-09-24T10:00:00.000Z');
    expect(new Date(bucketStart(t, H, 'Asia/Kolkata')).toISOString()).toBe('2026-09-24T09:30:00.000Z'); // 15:00 local
    expect(new Date(bucketStart(t, 24 * H, 'Asia/Kolkata')).toISOString()).toBe('2026-09-23T18:30:00.000Z'); // local midnight
  });
});

describe('which topics a request reaches', () => {
  beforeEach(() => {
    for (const t of ['dev/lotus/a/sht/temperature', 'dev/lotus/a/sht/humidity', 'dev/lotus/b/sht/temperature', 'dev/magi/c/sht/temperature']) {
      put(t, '2026-09-24.csv', lines([DAY + H, 1]));
    }
  });
  const topics = async (device, mayRead = everything) =>
    (await expandSelectors(parseSelectors(device), dir, mayRead)).map((t) => t.topic);

  it('a node is every field of it, a module every field of that', async () => {
    expect(await topics('dev/lotus/a')).toEqual(['dev/lotus/a/sht/humidity', 'dev/lotus/a/sht/temperature']);
    expect(await topics('dev/lotus/a/sht')).toEqual(['dev/lotus/a/sht/humidity', 'dev/lotus/a/sht/temperature']);
    expect(await topics('dev/lotus/a/sht/temperature')).toEqual(['dev/lotus/a/sht/temperature']);
  });
  it('"+" matches every node, or every project', async () => {
    expect(await topics('dev/lotus/+/sht/temperature')).toEqual(['dev/lotus/a/sht/temperature', 'dev/lotus/b/sht/temperature']);
    expect(await topics('dev/+/+/sht/temperature')).toHaveLength(3);
  });
  it('a project reached by "+" that may not be read is left out; one named outright is refused', async () => {
    const lotusOnly = (org, project) => org === 'dev' && (!project || project === 'lotus');
    expect(await topics('dev/+/+/sht/temperature', lotusOnly)).toEqual(['dev/lotus/a/sht/temperature', 'dev/lotus/b/sht/temperature']);
    expect(await code(topics('dev/magi/c', lotusOnly))).toBe('not_allowed');
    expect(await code(topics('varta/+/+', lotusOnly))).toBe('not_allowed');
  });
  it('something named outright that is not there is device_not_found; a "+" that finds nothing is just empty', async () => {
    expect(await code(topics('dev/lotus/zz'))).toBe('device_not_found');
    expect(await code(topics('dev/lotus/a/sht/pressure'))).toBe('device_not_found');
    expect(await topics('dev/lotus/+/sht/pressure')).toEqual([]);
  });
  it('refuses to match too many', async () => {
    const was = LIMITS.MAX_TOPICS;
    LIMITS.MAX_TOPICS = 2;
    try { expect(await code(topics('dev/+/+/sht/temperature'))).toBe('too_much_data'); }
    finally { LIMITS.MAX_TOPICS = was; }
  });
});

describe('queryData', () => {
  const q = (args) => queryData({ dataDir: dir, mayRead: everything, ...args });
  const T = 'dev/lotus/a/sht/temperature';

  it('returns the numeric readings in range, from plain and compressed days, oldest first', async () => {
    put(T, '2026-09-23.csv.gz', lines([DAY - 2 * H, 10], [DAY - H, 11]), true);
    put(T, '2026-09-24.csv', lines([DAY + H, 'not a number'], [DAY + 2 * H, 12], [DAY + 30 * H, 99]) + '\n');
    put(T, 'notes.txt', 'ignored');
    const r = await q({ device: T, from: String(DAY - H), to: String(DAY + 3 * H) });
    expect(r.series).toHaveLength(1);
    expect(r.series[0].rows).toEqual([{ t: DAY - H, v: 11 }, { t: DAY + 2 * H, v: 12 }]);
  });
  it('accepts seconds and unquoted values in the files, as older ones have', async () => {
    put(T, '2026-09-24.csv', `${(DAY + H) / 1000},7\n`);
    expect((await q({ device: T, from: String(DAY) })).series[0].rows).toEqual([{ t: DAY + H, v: 7 }]);
  });
  it('buckets: mean, min, max and count, a gap being a missing bucket', async () => {
    put(T, '2026-09-24.csv', lines([DAY + 10, 1], [DAY + 20, 3], [DAY + 30, 5], [DAY + 2 * H + 1, 8]));
    const r = await q({ device: T, from: String(DAY), to: String(DAY + 3 * H - 1), bucket: '1h' });
    expect(r.series[0].buckets).toEqual([
      { t: DAY, count: 3, mean: 3, min: 1, max: 5 },
      { t: DAY + 2 * H, count: 1, mean: 8, min: 8, max: 8 },
    ]);
  });
  it('buckets by the asker\'s clock', async () => {
    put(T, '2026-09-24.csv', lines([DAY + H, 1]));
    const r = await q({ device: T, from: String(DAY), bucket: '1d', tz: 'Asia/Kolkata' });
    expect(new Date(r.series[0].buckets[0].t).toISOString()).toBe('2026-09-23T18:30:00.000Z');
  });
  it('a topic with nothing in range is left out', async () => {
    put(T, '2026-09-20.csv', lines([DAY - 4 * 24 * H, 1]));
    expect((await q({ device: T, from: String(DAY) })).series).toEqual([]);
  });
  it('wants from, and from before to', async () => {
    expect(await code(q({ device: T }))).toBe('invalid_request');
    put(T, '2026-09-24.csv', lines([DAY, 1]));
    expect(await code(q({ device: T, from: String(DAY + H), to: String(DAY) }))).toBe('invalid_request');
  });

  describe('limits, refused before reading with what to change', () => {
    const withLimit = async (key, value, fn) => {
      const was = LIMITS[key];
      LIMITS[key] = value;
      try { return await fn(); } finally { LIMITS[key] = was; }
    };
    it('too many buckets, worked out from the range alone', async () => {
      put(T, '2026-09-24.csv', lines([DAY, 1]));
      const err = await q({ device: T, from: String(DAY - 30 * 24 * H), to: String(DAY), bucket: '1m' }).catch((e) => e);
      expect(err.code).toBe('too_much_data');
      expect(err.message).toMatch(/larger bucket/);
    });
    it('too many days of files', async () => {
      put(T, '2026-09-23.csv', lines([DAY - H, 1]));
      put(T, '2026-09-24.csv', lines([DAY + H, 1]));
      const err = await withLimit('MAX_DAY_FILES', 1, () => q({ device: T, from: String(DAY - 24 * H) }).catch((e) => e));
      expect(err.code).toBe('too_much_data');
      expect(err.message).toMatch(/shorter time/);
    });
    it('too many raw readings says to bucket them', async () => {
      put(T, '2026-09-24.csv', lines([DAY + 1, 1], [DAY + 2, 2], [DAY + 3, 3]));
      const err = await withLimit('MAX_RAW_READINGS', 2, () => q({ device: T, from: String(DAY) }).catch((e) => e));
      expect(err.code).toBe('too_much_data');
      expect(err.message).toMatch(/bucket=/);
    });
  });
});

describe('toSenMLPacks', () => {
  const series = (node, field, rows) => ({ org: 'dev', project: 'lotus', node, module: 'sht', field, rows });

  it('one node is the single-device pack it always was', () => {
    const pack = toSenMLPacks({ series: [series('a', 'temperature', [{ t: DAY, v: 1 }, { t: DAY + 1500, v: 2 }])] });
    expect(pack).toEqual([
      { bn: 'dev/lotus/a/', bt: DAY / 1000 },
      { n: 'sht/temperature', v: 1 },
      { n: 'sht/temperature', v: 2, t: 1.5 },
    ]);
  });
  it('several nodes each get their own base record, and fields of a node are interleaved by time', () => {
    const pack = toSenMLPacks({ series: [
      series('a', 'temperature', [{ t: DAY + 1000, v: 1 }]),
      series('a', 'humidity', [{ t: DAY, v: 50 }]),
      series('b', 'temperature', [{ t: DAY, v: 9 }]),
    ] });
    expect(pack).toEqual([
      { bn: 'dev/lotus/a/', bt: DAY / 1000 },
      { n: 'sht/humidity', v: 50 },
      { n: 'sht/temperature', v: 1, t: 1 },
      { bn: 'dev/lotus/b/', bt: DAY / 1000 },
      { n: 'sht/temperature', v: 9 },
    ]);
  });
  it('a bucketed value is named for its aggregate, at its bucket\'s start', () => {
    const pack = toSenMLPacks({ aggs: ['mean', 'count'], series: [{ org: 'dev', project: 'lotus', node: 'a', module: 'sht', field: 'temperature',
      buckets: [{ t: DAY, count: 3, mean: 2, min: 1, max: 3 }] }] });
    expect(pack).toEqual([
      { bn: 'dev/lotus/a/', bt: DAY / 1000 },
      { n: 'sht/temperature/count', v: 3 },
      { n: 'sht/temperature/mean', v: 2 },
    ]);
  });
  it('nothing is an empty pack', () => {
    expect(toSenMLPacks({ series: [] })).toEqual([]);
  });
});
