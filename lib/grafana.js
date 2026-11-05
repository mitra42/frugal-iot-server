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
 * so there is no person and no session. A token is read-only, belongs to one organization, and
 * acts as the user who made it: each request is answered with whatever READ permissions that user
 * holds at that moment, so it shows only their projects and stops working when their access does.
 * Anyone who can READ the organization can make their own:
 *
 *   POST /grafana_token/:org         {name}   issue (or re-issue, which replaces) - the token is in the reply, once
 *   GET  /grafana_token/:org                   list names and when last used (yours; all, for an org-wide administrator)
 *   POST /grafana_token/:org/revoke  {name}   yours; any, for an org-wide administrator
 *
 * See docs/GRAFANA.md for setting up Grafana to use these.
 */

import crypto from 'crypto';
import express, { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { gunzip as gunzipCallback } from 'zlib';
import { promisify } from 'util';
import { hasPermissions } from './config-for-user.js';
import { join, resolve, sep } from 'path';
import { jsonOnly } from './admin-guards.js';

const gunzip = promisify(gunzipCallback);

const DASHBOARD_TEMPLATE = fileURLToPath(new URL('../extras/grafana/frugaliot-readings.json', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_POINTS = 1000;
const HARD_MAX_POINTS = 5000;
// Reads of history at once: in all, and for any one organization - so one organization's Grafana
// cannot leave everyone else's being told to wait
const MAX_CONCURRENT_READS = 4;
const MAX_CONCURRENT_READS_PER_ORG = 2;
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = 'fiot_'; // so a leaked one is recognisable, to people and to secret scanners

// ---- tokens ------------------------------------------------------------------------------------
const run = (db, sql, args) => new Promise((res, rej) => db.run(sql, args, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, args) => new Promise((res, rej) => db.get(sql, args, (e, r) => (e ? rej(e) : res(r))));
const all = (db, sql, args) => new Promise((res, rej) => db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Per person within an organization: tokens are the person's own, so the limit is theirs too
export const MAX_TOKENS_PER_USER = 10;

// A token belongs to the user who made it and is only ever as powerful as that user's READ permissions
// are at the moment it is used (see tokenUser) - so it neither outlives their access nor shows them
// anything the dashboard would not.
//
// Returns the new token - the only time it is ever available. Issuing a name you already have
// replaces it; a name another user holds in this organization is refused. The limit is part of the
// insert so that requests arriving together cannot all get under it.
export async function issueToken(db, org, name, userId) {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const existing = await get(db, 'SELECT user_id FROM grafana_tokens WHERE org = ? AND name = ?', [org, name]);
  if (existing && existing.user_id !== userId) throw new TokenNameTaken(`The name ${JSON.stringify(name)} is used by someone else - choose another`);
  const r = await run(db,
    `INSERT INTO grafana_tokens (org, name, token_hash, created_at, user_id)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM grafana_tokens WHERE org = ? AND user_id = ?) < ?
          OR EXISTS (SELECT 1 FROM grafana_tokens WHERE org = ? AND name = ? AND user_id = ?)
     ON CONFLICT(org, name) DO UPDATE SET token_hash = excluded.token_hash,
                                          created_at = excluded.created_at, last_used = NULL
                                      WHERE grafana_tokens.user_id = excluded.user_id`,
    [org, name, hashToken(token), Date.now(), userId, org, userId, MAX_TOKENS_PER_USER, org, name, userId]);
  if (!r.changes) throw new TooManyTokens(`You can have up to ${MAX_TOKENS_PER_USER} tokens in an organization - revoke one first`);
  return token;
}
export class TooManyTokens extends Error {}
export class TokenNameTaken extends Error {}

// userId given: that user's tokens. Omitted: the whole organization's, for its administrator.
export function listTokens(db, org, userId) {
  return userId === undefined
    ? all(db, 'SELECT name, created_at, last_used, user_id FROM grafana_tokens WHERE org = ? ORDER BY name', [org])
    : all(db, 'SELECT name, created_at, last_used, user_id FROM grafana_tokens WHERE org = ? AND user_id = ? ORDER BY name', [org, userId]);
}

// True if there was one to revoke. userId given: only that user's; omitted: any in the organization.
export async function revokeToken(db, org, name, userId) {
  const r = userId === undefined
    ? await run(db, 'DELETE FROM grafana_tokens WHERE org = ? AND name = ?', [org, name])
    : await run(db, 'DELETE FROM grafana_tokens WHERE org = ? AND name = ? AND user_id = ?', [org, name, userId]);
  return r.changes > 0;
}

// Which { org, name, userId } a token belongs to, or undefined. A token with no user (made before
// tokens were tied to one) is not honoured: it would be a pass for the whole organization that
// nobody's permissions stand behind.
export async function tokenOwner(db, token) {
  if (!token) return undefined;
  const row = await get(db, 'SELECT org, name, last_used, user_id FROM grafana_tokens WHERE token_hash = ?', [hashToken(token)]);
  if (!row || row.user_id === null || row.user_id === undefined) return undefined;
  if (!row.last_used || Date.now() - row.last_used > LAST_USED_GRANULARITY_MS) {
    run(db, 'UPDATE grafana_tokens SET last_used = ? WHERE org = ? AND name = ?', [Date.now(), row.org, row.name])
      .catch(() => {}); // only a convenience for the admin, never worth failing a request over
  }
  return { org: row.org, name: row.name, userId: row.user_id };
}

// The user a token acts as, with the permissions they hold NOW - read from the table on each request,
// not from any session, because a token is used with no session at all. A user who has been deleted
// is left with only what is granted to everyone (id 0), which is as little as can be.
export async function permissionsOf(db, userId) {
  const permissions = await all(db, 'SELECT * FROM permissions WHERE id = ? OR id = 0', [userId]);
  return { id: userId, permissions };
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

// Every reading of one topic in the range, a file at a time: { t: ms since 1970, value: number }.
// Not in time order across files unless the file names sort that way, which they do (dates).
async function* readTopic(topic, dataDir, fromMs, toMs) {
  const dir = join(dataDir, ...topic.split('/'));
  let files;
  try { files = await readdir(dir); } catch { return; }
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
      if (t >= fromMs && t <= toMs) yield { t, value };
    }
  }
}

// Every reading of one topic between two times: [{ t, value }], oldest first. Lines are
//   1703318400000,"25.3"   - a reading that is not a number (a description, a colour) is left out, as
// it cannot be charted. Days gone by may be compressed (".csv.gz") by housekeeping.
export async function loadTopicData(topic, dataDir, fromMs, toMs) {
  const rows = [];
  for await (const r of readTopic(topic, dataDir, fromMs, toMs)) rows.push(r);
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

// The same readings, ready to send: the series for a chart of at most maxPoints points. Unlike
// loadTopicData this never holds a long history in memory - past RAW_CAP readings it switches to
// adding each one into its time bucket as it is read, so a year of readings every few seconds costs
// as much memory as a day's. (The server may be a Raspberry Pi, and any holder of a token can ask for
// any range.) The answer is the same as downsample(loadTopicData(...)) either way.
const RAW_CAP = 20000;
export async function loadTopicSeries(topic, dataDir, fromMs, toMs, maxPoints) {
  const width = Math.ceil((toMs - fromMs + 1) / maxPoints);
  let rows = [];
  let buckets = null; // Map of bucket -> { sum, n }, once there are too many to keep as they are
  const add = (t, value) => {
    const k = Math.floor((t - fromMs) / width);
    const b = buckets.get(k);
    if (b) { b.sum += value; b.n++; } else { buckets.set(k, { sum: value, n: 1 }); }
  };
  for await (const { t, value } of readTopic(topic, dataDir, fromMs, toMs)) {
    if (buckets) { add(t, value); continue; }
    rows.push({ t, value });
    if (rows.length > RAW_CAP) {
      buckets = new Map();
      for (const r of rows) add(r.t, r.value);
      rows = null;
    }
  }
  if (!buckets) {
    rows.sort((a, b) => a.t - b.t);
    return downsample(rows, fromMs, toMs, maxPoints);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ t: fromMs + k * width, value: b.sum / b.n }));
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
const topicCache = new Map(); // org -> { at, topics }
const TOPIC_CACHE_MS = 60 * 1000;
export function clearTopicCache() { topicCache.clear(); }
// Cached for a minute: it walks every directory of the organization, which is slow on a big one, and
// a new topic appearing a minute late in a dropdown is no loss.
export async function listTopics(org, dataDir) {
  const hit = topicCache.get(`${dataDir}\0${org}`);
  if (hit && Date.now() - hit.at < TOPIC_CACHE_MS) return hit.topics;
  const topics = await walkTopics(org, dataDir);
  topicCache.set(`${dataDir}\0${org}`, { at: Date.now(), topics });
  return topics;
}
async function walkTopics(org, dataDir) {
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
 * @param auth      { loggedInOrFail, can_READ } from frugal-iot-server.js, passed in so tests can stand in
 * @returns { data, admin } - routers to mount at /grafana and /grafana_token
 */
export function createGrafanaRouters(db, dataDir, loggerClient, auth) {
  const data = Router();
  let reading = 0; // reads of history in progress, across every token
  const readingByOrg = new Map();
  const admin = Router();

  // Bearer token, and it must be for the organization in the URL, and its user must still be able to
  // READ that organization. The same answer for an unknown token as for another organization's, so a
  // token cannot be used to find out which exist. req.tokenUser is who it acts as.
  const tokenAuth = async (req, res, next) => {
    try {
      const header = req.get('Authorization') || '';
      const owner = await tokenOwner(db, header.startsWith('Bearer ') ? header.slice(7) : '');
      if (owner && owner.org === req.params.org) {
        const user = await permissionsOf(db, owner.userId);
        if (hasPermissions(user, owner.org, 'READ')) {
          req.tokenUser = user;
          return next();
        }
      }
      return res.status(403).json({ error: 'Not a valid token for this organization' });
    } catch (err) { next(err); }
  };

  data.get('/:org/health', tokenAuth, (req, res) => res.json({ status: 'ok' }));

  data.get('/:org/topics', tokenAuth, async (req, res, next) => {
    try {
      const { project, node } = req.query;
      const topics = (await listTopics(req.params.org, dataDir))
        .filter((t) => hasPermissions(req.tokenUser, req.params.org, 'READ', t.project))
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
      if (!hasPermissions(req.tokenUser, req.params.org, 'READ', topic.split('/')[1])) {
        return res.status(403).json({ error: 'Not a valid token for this project' });
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
      // Reading a long history is real work, and a token can ask for as many at once as it likes.
      // Past a few at a time, say so and let the caller retry - Grafana does - rather than let a
      // small machine fall over.
      const org = req.params.org;
      if (reading >= MAX_CONCURRENT_READS || (readingByOrg.get(org) || 0) >= MAX_CONCURRENT_READS_PER_ORG) {
        res.set('Retry-After', '5');
        return res.status(503).json({ error: 'Busy - try again in a few seconds' });
      }
      reading++;
      readingByOrg.set(org, (readingByOrg.get(org) || 0) + 1);
      try {
        await loggerClient.flush();
        const rows = await loadTopicSeries(topic, dataDir, fromMs, toMs, maxPoints);
        res.json(rows.map((r) => ({ time: new Date(r.t).toISOString(), value: r.value })));
      } finally {
        reading--;
        readingByOrg.set(org, readingByOrg.get(org) - 1);
      }
    } catch (err) { next(err); }
  });

  // Whether this user is an administrator of the whole organization, who may see and revoke anyone's
  // tokens; anyone else deals only with their own.
  const isOrgAdmin = (req) => hasPermissions(req.user, req.params.org, 'ADMIN') && req.user.permissions.some(
    (p) => p.capability === 'ADMIN' && p.org === req.params.org && !p.project);
  const bad = (res, status, message) => res.status(status).json({ error: message, message });

  // Issuing is POST, not GET: a GET could be triggered against a logged-in user by any page that can
  // make their browser fetch a URL.
  admin.post('/:org', auth.loggedInOrFail, auth.can_READ, jsonOnly, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(name)) {
        return bad(res, 400, 'name must be 1-40 characters: letters, digits, space, _ . -');
      }
      let token;
      try { token = await issueToken(db, req.params.org, name, Number(req.user.id)); }
      catch (err) {
        if (err instanceof TooManyTokens || err instanceof TokenNameTaken) return bad(res, 400, err.message);
        throw err;
      }
      console.log('Grafana token issued by', req.user.username, '-', req.params.org, JSON.stringify(name));
      res.set('Cache-Control', 'no-store'); // the token is in this reply and must not be kept anywhere
      res.status(201).json({ org: req.params.org, name, token });
    } catch (err) { next(err); }
  });
  admin.get('/:org', auth.loggedInOrFail, auth.can_READ, async (req, res, next) => {
    try {
      const rows = await listTokens(db, req.params.org, isOrgAdmin(req) ? undefined : Number(req.user.id));
      res.json(rows.map(({ user_id, ...t }) => ({ ...t, mine: user_id === Number(req.user.id) })));
    } catch (err) { next(err); }
  });
  // The starter dashboard, to save and import into Grafana (docs/GRAFANA.md). Nothing in it is secret.
  admin.get('/:org/dashboard', auth.loggedInOrFail, auth.can_READ, async (req, res, next) => {
    try {
      const dash = await dashboardFor(req.params.org, String(req.query.server || ''));
      if (!dash) return bad(res, 400, 'server must be this server\'s http or https address');
      res.set('Content-Disposition', `attachment; filename="frugaliot-${req.params.org}-dashboard.json"`);
      res.json(dash);
    } catch (err) { next(err); }
  });
  admin.post('/:org/revoke', auth.loggedInOrFail, auth.can_READ, jsonOnly, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const done = await revokeToken(db, req.params.org, String((req.body && req.body.name) || ''),
        isOrgAdmin(req) ? undefined : Number(req.user.id));
      console.log('Grafana token revoked by', req.user.username, '-', req.params.org, JSON.stringify(req.body && req.body.name));
      res.status(done ? 200 : 404).json({ revoked: done });
    } catch (err) { next(err); }
  });

  return { data, admin };
}
