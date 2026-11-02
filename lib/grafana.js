/**
 * Reading history over HTTP, for Grafana.
 *
 * Grafana's Infinity data source can call any URL that returns JSON, so rather than copy readings
 * into a second store this serves them straight from the CSV files under data/ - the same files,
 * and the same loader approach, as GET /api/data - in the shape Infinity wants: an array of
 * { time, value }. Every organization's complete history is available this way, which exporting to
 * a search index (see the OpenSearch forwarder in frugal-iot-logger) is not unless it was switched on.
 *
 *   GET  /grafana/:org/health                                  {status: "ok"}  - for "Test" in Grafana
 *   GET  /grafana/:org/topics[?project=&node=]                 what there is to chart
 *   GET  /grafana/:org/data?topic=&from=&to=&maxPoints=        [{time, value}, ...]
 *
 * These are authenticated by a bearer token, not a login: Grafana is a program asking on a timer,
 * so there is no person and no session. A token is read-only and belongs to one organization.
 * Tokens are issued by an organization's administrator:
 *
 *   POST /grafana_token/:org         {name}   issue (or re-issue, which replaces) - the token is in the reply, once
 *   GET  /grafana_token/:org                   list names and when last used
 *   POST /grafana_token/:org/revoke  {name}
 *
 * See GRAFANA.md for setting up Grafana to use these.
 */

import crypto from 'crypto';
import express, { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { gunzip as gunzipCallback } from 'zlib';
import { promisify } from 'util';
import { join, resolve, sep } from 'path';

const gunzip = promisify(gunzipCallback);

const DASHBOARD_TEMPLATE = fileURLToPath(new URL('../extras/grafana/frugaliot-readings.json', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_POINTS = 1000;
const HARD_MAX_POINTS = 5000;
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = 'fiot_'; // so a leaked one is recognisable, to people and to secret scanners

// ---- tokens ------------------------------------------------------------------------------------
const run = (db, sql, args) => new Promise((res, rej) => db.run(sql, args, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, args) => new Promise((res, rej) => db.get(sql, args, (e, r) => (e ? rej(e) : res(r))));
const all = (db, sql, args) => new Promise((res, rej) => db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Returns the new token - the only time it is ever available. Issuing a name that exists replaces it.
export async function issueToken(db, org, name) {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  await run(db,
    `INSERT INTO grafana_tokens (org, name, token_hash, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(org, name) DO UPDATE SET token_hash = excluded.token_hash,
                                          created_at = excluded.created_at, last_used = NULL`,
    [org, name, hashToken(token), Date.now()]);
  return token;
}

export function listTokens(db, org) {
  return all(db, 'SELECT name, created_at, last_used FROM grafana_tokens WHERE org = ? ORDER BY name', [org]);
}

// True if there was one to revoke
export async function revokeToken(db, org, name) {
  const r = await run(db, 'DELETE FROM grafana_tokens WHERE org = ? AND name = ?', [org, name]);
  return r.changes > 0;
}

// Which { org, name } a token belongs to, or undefined.
export async function tokenOwner(db, token) {
  if (!token) return undefined;
  const row = await get(db, 'SELECT org, name, last_used FROM grafana_tokens WHERE token_hash = ?', [hashToken(token)]);
  if (row && (!row.last_used || Date.now() - row.last_used > LAST_USED_GRANULARITY_MS)) {
    run(db, 'UPDATE grafana_tokens SET last_used = ? WHERE org = ? AND name = ?', [Date.now(), row.org, row.name])
      .catch(() => {}); // only a convenience for the admin, never worth failing a request over
  }
  return row && { org: row.org, name: row.name };
}

// ---- reading the files -------------------------------------------------------------------------
// A topic arrives from the URL, so it is held to what a real one can be before it goes anywhere near
// a file path: each level a plain name, and no "." or ".." to climb out of data/.
export function validTopic(topic, org) {
  if (typeof topic !== 'string') return false;
  const levels = topic.split('/');
  return levels.length >= 5
    && levels[0] === org
    && levels.every((l) => /^[A-Za-z0-9_.+-]+$/.test(l) && l !== '.' && l !== '..');
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.csv(\.gz)?$/;

// Every reading of one topic between two times: [{ t: ms since 1970, value: number }], oldest first.
// Lines are   1703318400000,"25.3"   - a reading that is not a number (a description, a colour) is
// left out, as it cannot be charted. Days gone by may be compressed (".csv.gz") by housekeeping.
export async function loadTopicData(topic, dataDir, fromMs, toMs) {
  const dir = join(dataDir, ...topic.split('/'));
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const rows = [];
  for (const file of files.sort()) {
    const m = DAY_FILE.exec(file);
    if (!m) continue;
    const dayStart = Date.parse(`${m[1]}T00:00:00Z`);
    if (dayStart + DAY_MS <= fromMs || dayStart > toMs) continue;
    let text;
    try {
      const raw = await readFile(join(dir, file));
      text = (m[2] ? await gunzip(raw) : raw).toString('utf8');
    } catch (err) {
      console.warn(`Grafana: could not read ${join(dir, file)}:`, err.message);
      continue;
    }
    for (const line of text.split('\n')) {
      const lm = /^(\d+),"(.*)"$/.exec(line);
      if (!lm || lm[2] === '') continue;
      const value = Number(lm[2]);
      if (Number.isNaN(value)) continue;
      const t = Number(lm[1]);
      if (t >= fromMs && t <= toMs) rows.push({ t, value });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

// Grafana asks for as many points as the panel has pixels. Past maxPoints, average into equal
// time buckets so a year of readings every ten seconds does not travel as three million rows.
export function downsample(rows, fromMs, toMs, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const width = Math.ceil((toMs - fromMs + 1) / maxPoints);
  const buckets = new Map();
  for (const { t, value } of rows) {
    const k = Math.floor((t - fromMs) / width);
    const b = buckets.get(k);
    if (b) { b.sum += value; b.n++; } else { buckets.set(k, { sum: value, n: 1 }); }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ t: fromMs + k * width, value: b.sum / b.n }));
}

// Every topic under an organization that has readings: a directory holding day files.
export async function listTopics(org, dataDir) {
  const root = resolve(dataDir);
  const topics = [];
  async function walk(dir, levels) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && DAY_FILE.test(e.name))) {
      const [o, project, node, module, ...rest] = levels;
      if (rest.length > 0) topics.push({ topic: levels.join('/'), project, node, module, leaf: rest.join('/') });
    }
    if (levels.length >= 8) return; // nothing real is this deep
    for (const e of entries) if (e.isDirectory()) await walk(join(dir, e.name), [...levels, e.name]);
  }
  const orgDir = resolve(root, org);
  if (orgDir.startsWith(root + sep)) await walk(orgDir, [org]);
  return topics;
}

// "1703318400000" (ms), "1703318400" (seconds) or an ISO date; undefined if it is none of those.
export function parseTime(v) {
  if (v === undefined || v === '') return undefined;
  if (/^\d+$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

// The starter dashboard with this server and organization already filled in as the defaults Grafana
// offers on import, so all that is left to choose is the data source. `server` is the address Grafana
// reaches this server at; the dashboard's own browser knows it better than this process does, behind
// whatever proxy there is, so it is passed in. Only an http(s) origin is accepted.
export async function dashboardFor(org, server) {
  let origin;
  try {
    const u = new URL(server);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    origin = u.origin;
  } catch { return undefined; }
  const dash = JSON.parse(await readFile(DASHBOARD_TEMPLATE, 'utf8'));
  for (const input of dash.__inputs) {
    if (input.name === 'VAR_SERVER') input.value = origin;
    if (input.name === 'VAR_ORG') input.value = org;
  }
  dash.title = `Frugal IoT readings - ${org}`;
  dash.uid = `frugaliot-readings-${org}`; // a dashboard per organization, so importing a second does not replace the first
  return dash;
}

// ---- the routes --------------------------------------------------------------------------------
/**
 * @param db        sqlite3 database
 * @param dataDir   where the CSV files are
 * @param loggerClient  has flush(), to get readings still in the logger's memory onto disk first
 * @param auth      { loggedInOrFail, can_ADMIN } from frugal-iot-server.js, passed in so tests can stand in
 * @returns { data, admin } - routers to mount at /grafana and /grafana_token
 */
export function createGrafanaRouters(db, dataDir, loggerClient, auth) {
  const data = Router();
  const admin = Router();

  // Bearer token, and it must be for the organization in the URL. The same answer for an unknown
  // token as for another organization's, so a token cannot be used to find out which exist.
  const tokenAuth = async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';
      const owner = await tokenOwner(db, header.startsWith('Bearer ') ? header.slice(7) : '');
      if (!owner || owner.org !== req.params.org) {
        return res.status(403).json({ error: 'Not a valid token for this organization' });
      }
      next();
    } catch (err) { next(err); }
  };

  data.get('/:org/health', tokenAuth, (req, res) => res.json({ status: 'ok' }));

  data.get('/:org/topics', tokenAuth, async (req, res, next) => {
    try {
      const { project, node } = req.query;
      const topics = (await listTopics(req.params.org, dataDir))
        .filter((t) => (!project || t.project === project) && (!node || t.node === node));
      res.json(topics);
    } catch (err) { next(err); }
  });

  data.get('/:org/data', tokenAuth, async (req, res, next) => {
    try {
      const { topic } = req.query;
      if (!validTopic(topic, req.params.org)) {
        return res.status(400).json({ error: `topic must be ${req.params.org}/project/node/module/leaf` });
      }
      const toMs = parseTime(req.query.to) ?? Date.now();
      const fromMs = parseTime(req.query.from) ?? toMs - DAY_MS;
      if (req.query.to !== undefined && parseTime(req.query.to) === undefined
          || req.query.from !== undefined && parseTime(req.query.from) === undefined) {
        return res.status(400).json({ error: 'from and to must be epoch milliseconds or ISO dates' });
      }
      if (fromMs > toMs) return res.status(400).json({ error: 'from is after to' });
      const maxPoints = Math.min(Math.max(parseInt(req.query.maxPoints, 10) || DEFAULT_MAX_POINTS, 1), HARD_MAX_POINTS);
      // Readings are held in memory and written out every few minutes, so write them first or a
      // chart reaching "now" would stop short
      await loggerClient.flush();
      const rows = downsample(await loadTopicData(topic, dataDir, fromMs, toMs), fromMs, toMs, maxPoints);
      res.json(rows.map((r) => ({ time: new Date(r.t).toISOString(), value: r.value })));
    } catch (err) { next(err); }
  });

  // Issuing is POST, not GET: a GET could be triggered against a logged-in administrator by any page
  // that can make their browser fetch a URL.
  admin.post('/:org', auth.loggedInOrFail, auth.can_ADMIN, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(name)) {
        return res.status(400).json({ error: 'name must be 1-40 characters: letters, digits, space, _ . -' });
      }
      const token = await issueToken(db, req.params.org, name);
      console.log('Grafana token issued by', req.user.username, '-', req.params.org, name);
      res.status(201).json({ org: req.params.org, name, token });
    } catch (err) { next(err); }
  });
  admin.get('/:org', auth.loggedInOrFail, auth.can_ADMIN, async (req, res, next) => {
    try { res.json(await listTokens(db, req.params.org)); } catch (err) { next(err); }
  });
  // The starter dashboard, for an administrator to save and import into Grafana (GRAFANA.md)
  admin.get('/:org/dashboard', auth.loggedInOrFail, auth.can_ADMIN, async (req, res, next) => {
    try {
      const dash = await dashboardFor(req.params.org, String(req.query.server || ''));
      if (!dash) return res.status(400).json({ error: 'server must be this server\'s http or https address', message: 'server must be this server\'s http or https address' });
      res.set('Content-Disposition', `attachment; filename="frugaliot-${req.params.org}-dashboard.json"`);
      res.json(dash);
    } catch (err) { next(err); }
  });
  admin.post('/:org/revoke', auth.loggedInOrFail, auth.can_ADMIN, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const done = await revokeToken(db, req.params.org, String((req.body && req.body.name) || ''));
      console.log('Grafana token revoked by', req.user.username, '-', req.params.org, req.body && req.body.name);
      res.status(done ? 200 : 404).json({ revoked: done });
    } catch (err) { next(err); }
  });

  return { data, admin };
}
