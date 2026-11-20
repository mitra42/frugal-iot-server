/**
 * Asking for readings: which topics, over what time, raw or summarised into buckets.
 *
 * Shared by GET /api/data (API.md Section 6.2) and the MCP tools (issue #44), which differ only in who
 * may read what - so the permission check is passed in as mayRead(org, project), and everything else
 * here is the same for both.
 *
 * A selector names readings at one of three depths, and any level after the organization may be "+"
 * (one level, as in MQTT):
 *
 *   dev/lotus/esp32-aaaa                    every field of that node
 *   dev/lotus/esp32-aaaa/sht                every field of one module
 *   dev/lotus/+/sht/temperature             one field, on every node of the project
 *
 * Readings are on disk as data/<org>/<project>/<node>/<module>/<field>/<YYYY-MM-DD>.csv, one file per
 * UTC day (".csv.gz" once lib/housekeeping.js has compressed a day gone by), each line
 * `<ms since 1970>,"<value>"`. Only numeric values are returned, as before.
 *
 * Every request is bounded before any file is read - in topics, in day files, and for buckets in the
 * records it could produce - and refused with a message saying what to change, because a month across
 * many nodes is exactly what an AI will ask for, and the server should be cheap to run.
 */

import { readdir, readFile } from 'fs/promises';
import { gunzip as gunzipCallback } from 'zlib';
import { promisify } from 'util';
import { join } from 'path';
import { APIError } from './api-errors.js';

const gunzip = promisify(gunzipCallback);

export const AGGS = ['mean', 'min', 'max', 'count'];
export const LIMITS = {
  MAX_SELECTORS: 50,
  MAX_TOPICS: 200,        // after "+" is expanded
  MAX_DAY_FILES: 6000,    // e.g. 200 topics for a month, or 16 for a year
  MAX_RAW_READINGS: 100000,
  MAX_RECORDS: 20000,     // bucketed: buckets x aggregates x topics
};
const DAY_MS = 24 * 60 * 60 * 1000;
const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: DAY_MS };
const LEVEL = /^[A-Za-z0-9_.-]+$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.csv(\.gz)?$/;

// ---- parsing the request -----------------------------------------------------------------------

// device= may be repeated, and each may hold several separated by commas
export function parseSelectors(device) {
  const raw = [].concat(device === undefined ? [] : device)
    .flatMap((d) => String(d).split(','))
    .map((d) => d.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!raw.length) throw new APIError('invalid_request', 'Missing required parameter: device');
  if (raw.length > LIMITS.MAX_SELECTORS) {
    throw new APIError('invalid_request', `At most ${LIMITS.MAX_SELECTORS} devices in one request - use "+" to match many`);
  }
  return [...new Set(raw)].map((s) => {
    const levels = s.split('/');
    const ok = levels.length >= 3 && levels.length <= 5
      && levels.every((l, i) => (l === '+' ? i > 0 : (LEVEL.test(l) && l !== '.' && l !== '..')));
    if (!ok) {
      throw new APIError('invalid_request',
        `Bad device ${JSON.stringify(s)}: must be org/project/node, optionally /module/field; "+" matches one level after the organization`);
    }
    return levels;
  });
}

// "15m", "1h", "6h", "1d", "7d"
export function parseBucket(bucket) {
  if (bucket === undefined || bucket === '') return undefined;
  const m = /^(\d+)([mhd])$/.exec(String(bucket));
  const ms = m && Number(m[1]) * UNIT_MS[m[2]];
  if (!ms || ms > 366 * DAY_MS) {
    throw new APIError('invalid_request', 'bucket must be a number followed by m, h or d - e.g. 15m, 1h, 1d - and at most 366d');
  }
  return ms;
}

export function parseAggs(agg) {
  if (agg === undefined || agg === '') return AGGS;
  const aggs = [...new Set(String(agg).split(',').map((a) => a.trim()).filter(Boolean))];
  const bad = aggs.filter((a) => !AGGS.includes(a));
  if (bad.length || !aggs.length) throw new APIError('invalid_request', `agg must be some of ${AGGS.join(',')}`);
  return AGGS.filter((a) => aggs.includes(a)); // a fixed order, whatever order they were asked in
}

export function parseTimeZone(tz) {
  if (tz === undefined || tz === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return String(tz);
  } catch {
    throw new APIError('invalid_request', `Unknown time zone ${JSON.stringify(tz)} - use an IANA name such as Asia/Kolkata`);
  }
}

// ISO 8601, or Unix time in seconds or milliseconds
export function parseTime(v, name) {
  if (v === undefined || v === '') return undefined;
  const s = String(v);
  let ms;
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); ms = n < 1e11 ? n * 1000 : n; }
  else if (/^\d{4}-\d{2}-\d{2}/.test(s)) ms = Date.parse(s);
  if (ms === undefined || Number.isNaN(ms)) {
    throw new APIError('invalid_request', `"${name}" must be a Unix timestamp or ISO 8601`);
  }
  return Math.floor(ms);
}

// ---- time zones --------------------------------------------------------------------------------

const formatters = new Map();
const offsetCache = new Map(); // `${tz} ${hour}` -> offset
// Milliseconds to add to UTC to get the wall clock in tz. Looked up once per hour of readings, which
// misplaces nothing except in a zone that changes its clocks at other than a whole hour (Lord Howe).
export function tzOffsetMs(tz, t) {
  if (tz === 'UTC') return 0;
  const hour = Math.floor(t / 3600000);
  const key = `${tz} ${hour}`;
  let off = offsetCache.get(key);
  if (off !== undefined) return off;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const at = hour * 3600000;
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  if (offsetCache.size > 10000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}

// The start (UTC ms) of the bucket a reading falls in. Buckets line up with the wall clock in tz -
// days start at local midnight, and in a +5:30 zone hours start at :30 UTC. A bucket that spans a
// clock change is an hour longer or shorter.
export function bucketStart(t, bucketMs, tz) {
  const off = tzOffsetMs(tz, t);
  return Math.floor((t + off) / bucketMs) * bucketMs - off;
}

// ---- finding the topics ------------------------------------------------------------------------

async function subdirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && LEVEL.test(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name).sort();
  } catch { return []; }
}

/*
 * The topics a request names, each { topic, org, project, node, module, field }. mayRead(org, project)
 * decides what the asker may see: a project named outright that they may not read is refused, while
 * one reached through "+" is simply left out - the same as the dashboard not listing it.
 * A selector with no "+" that matches nothing is device_not_found, as /api/data always answered.
 */
export async function expandSelectors(selectors, dataDir, mayRead) {
  const topics = new Map();
  for (const levels of selectors) {
    const [org, project] = levels;
    if (!mayRead(org, project === '+' ? undefined : project)) {
      throw new APIError('not_allowed', `Not allowed to read ${levels.slice(0, project === '+' ? 1 : 2).join('/')}`);
    }
    let paths = [[org]];
    for (let depth = 1; depth < 5; depth++) {
      const want = levels[depth]; // undefined past the end of a short selector: every one
      const next = [];
      for (const p of paths) {
        const names = (want === undefined || want === '+') ? await subdirs(join(dataDir, ...p)) : [want];
        for (const name of names) {
          if (depth === 1 && want === '+' && !mayRead(org, name)) continue;
          next.push([...p, name]);
        }
      }
      paths = next;
      // Checked as it goes, so a "+" on every level stops before it has walked the whole tree
      if (topics.size + paths.length > LIMITS.MAX_TOPICS * 20) {
        throw new APIError('too_much_data', `That matches too much - name a module or field, or fewer nodes`);
      }
    }
    // A level that was named rather than listed may not exist, even after a "+" (dev/lotus/+/sht/pressure)
    const found = [];
    for (const p of paths) {
      try { await readdir(join(dataDir, ...p)); } catch { continue; }
      found.push(p);
    }
    if (!found.length && !levels.includes('+')) {
      throw new APIError('device_not_found', `No data found for device ${levels.join('/')}`);
    }
    for (const [o, pr, node, module, field] of found) {
      const topic = [o, pr, node, module, field].join('/');
      topics.set(topic, { topic, org: o, project: pr, node, module, field });
    }
    if (topics.size > LIMITS.MAX_TOPICS) {
      throw new APIError('too_much_data',
        `That matches more than ${LIMITS.MAX_TOPICS} fields - name a module or field, or fewer nodes`);
    }
  }
  return [...topics.values()];
}

// ---- reading -----------------------------------------------------------------------------------

// The day files of one topic that overlap [fromMs, toMs], oldest first
async function dayFiles(dataDir, topic, fromMs, toMs) {
  let files;
  try { files = await readdir(join(dataDir, ...topic.split('/'))); } catch { return []; }
  const out = [];
  for (const file of files.sort()) {
    const m = DAY_FILE.exec(file);
    if (!m) continue;
    const dayStart = Date.parse(`${m[1]}T00:00:00Z`);
    if (dayStart + DAY_MS <= fromMs || dayStart > toMs) continue;
    out.push({ path: join(dataDir, ...topic.split('/'), file), gz: !!m[2] });
  }
  return out;
}

// Every numeric reading in the files between two times: { t: ms, v }. Lines are `1703318400000,"25.3"`;
// a timestamp in seconds, or a value without quotes, is accepted as well.
async function* readRows(files, fromMs, toMs) {
  for (const { path, gz } of files) {
    let text;
    try {
      const raw = await readFile(path);
      text = (gz ? await gunzip(raw) : raw).toString('utf8');
    } catch (err) {
      console.warn(`Could not read ${path}:`, err.message);
      continue;
    }
    for (const line of text.split('\n')) {
      const comma = line.indexOf(',');
      if (comma < 1) continue;
      let t = Number(line.slice(0, comma));
      if (!Number.isFinite(t)) continue;
      if (t < 1e11) t *= 1000;
      const value = line.slice(comma + 1).trim().replace(/^"(.*)"$/, '$1');
      if (value === '') continue;
      const v = Number(value);
      if (Number.isNaN(v)) continue;
      if (t >= fromMs && t <= toMs) yield { t, v };
    }
  }
}

/*
 * The whole query, from the request's own strings: { device, from, to, bucket, agg, tz }.
 *
 * Returns { fromMs, toMs, bucketMs, aggs, tz, series }, where each of series is a topic (as from
 * expandSelectors) with either rows [{t, v}] or, when bucketed, buckets [{t, count, mean, min, max}]
 * - t being the bucket's start. A bucket with no readings is left out, so a gap shows as a missing
 * bucket, and count says how well each one is covered.
 */
export async function queryData({ dataDir, mayRead, device, from, to, bucket, agg, tz }) {
  const selectors = parseSelectors(device);
  const fromMs = parseTime(from, 'from');
  if (fromMs === undefined) throw new APIError('invalid_request', 'Missing required parameter: from');
  const toMs = parseTime(to, 'to') ?? Date.now();
  if (fromMs > toMs) throw new APIError('invalid_request', 'Start time must be before end time');
  const bucketMs = parseBucket(bucket);
  const aggs = parseAggs(agg);
  const zone = parseTimeZone(tz);

  const topics = await expandSelectors(selectors, dataDir, mayRead);
  if (bucketMs) {
    const most = (Math.floor((toMs - fromMs) / bucketMs) + 2) * aggs.length * topics.length;
    if (most > LIMITS.MAX_RECORDS) {
      throw new APIError('too_much_data',
        `That could be ${most} values, more than ${LIMITS.MAX_RECORDS} - use a larger bucket, a shorter time, fewer fields or fewer aggregates`);
    }
  }
  const files = await Promise.all(topics.map((t) => dayFiles(dataDir, t.topic, fromMs, toMs)));
  const nFiles = files.reduce((n, f) => n + f.length, 0);
  if (nFiles > LIMITS.MAX_DAY_FILES) {
    throw new APIError('too_much_data',
      `That would read ${nFiles} days of files, more than ${LIMITS.MAX_DAY_FILES} - ask for a shorter time or fewer fields`);
  }

  const series = [];
  let readings = 0;
  for (let i = 0; i < topics.length; i++) {
    if (!files[i].length) continue;
    if (!bucketMs) {
      const rows = [];
      for await (const r of readRows(files[i], fromMs, toMs)) {
        rows.push(r);
        if (++readings > LIMITS.MAX_RAW_READINGS) {
          throw new APIError('too_much_data',
            `More than ${LIMITS.MAX_RAW_READINGS} readings - add bucket= (e.g. bucket=1h) to have them summarised`);
        }
      }
      rows.sort((a, b) => a.t - b.t);
      if (rows.length) series.push({ ...topics[i], rows });
    } else {
      const byStart = new Map();
      for await (const { t, v } of readRows(files[i], fromMs, toMs)) {
        const s = bucketStart(t, bucketMs, zone);
        const b = byStart.get(s);
        if (b) { b.n++; b.sum += v; if (v < b.min) b.min = v; if (v > b.max) b.max = v; }
        else byStart.set(s, { n: 1, sum: v, min: v, max: v });
      }
      const buckets = [...byStart.entries()].sort((a, b) => a[0] - b[0])
        .map(([t, b]) => ({ t, count: b.n, mean: b.sum / b.n, min: b.min, max: b.max }));
      if (buckets.length) series.push({ ...topics[i], buckets });
    }
  }
  return { fromMs, toMs, bucketMs, aggs, tz: zone, series };
}

/*
 * SenML (API.md Section 4) for a query's result. One base record per node, each followed by that
 * node's records - so a request naming one node gets exactly the single-device pack it always did.
 * Times are seconds, as SenML has them; t is relative to the node's bt. A bucketed value is named
 * <module>/<field>/<aggregate>, e.g. sht/temperature/mean, and timed at its bucket's start.
 */
export function toSenMLPacks(result) {
  const byNode = new Map();
  for (const s of result.series) {
    const key = `${s.org}/${s.project}/${s.node}/`;
    if (!byNode.has(key)) byNode.set(key, []);
    const recs = byNode.get(key);
    const n = `${s.module}/${s.field}`;
    if (s.rows) {
      for (const { t, v } of s.rows) recs.push({ n, t, v });
    } else {
      for (const b of s.buckets) for (const a of result.aggs) recs.push({ n: `${n}/${a}`, t: b.t, v: b[a] });
    }
  }
  const pack = [];
  for (const [bn, recs] of byNode) {
    recs.sort((a, b) => (a.t - b.t) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    const bt = recs[0].t;
    pack.push({ bn, bt: bt / 1000 });
    for (const r of recs) {
      const rec = { n: r.n, v: r.v };
      if (r.t !== bt) rec.t = (r.t - bt) / 1000;
      pack.push(rec);
    }
  }
  return pack;
}
