/**
 * /mcp - lets a user's own Claude ask about the readings they can already see (issue #44).
 *
 * The server only answers data queries; the reasoning happens on the user's Claude plan, so it costs
 * this project nothing. Read-only: there is no tool that sends a set or changes anything.
 *
 * MCP Streamable HTTP, stateless - the tools are built per request, holding the user they act for,
 * so nothing about one request can leak into the next. Responses are plain JSON, never a stream. The
 * protocol itself is lib/mcp-protocol.js.
 *
 * Who may see what is mayUseMCP (lib/config-for-user.js): MCP and READ, on the project. The tools reach
 * readings only through lib/data-query.js, the same code as GET /api/data, with that as its mayRead.
 */

import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { Router } from 'express';
import { handleMcpPost } from './mcp-protocol.js';
import { APIError } from './api-errors.js';
import { mayUseMCP } from './config-for-user.js';
import { queryData, tzOffsetMs, readGuard, LIMITS, parseSelectors, expandSelectors, parseTime,
  parseBucket, parseTimeZone } from './data-query.js';
import { tokenAuth } from './tokens.js';
import { makeRateLimiter } from './enrol.js';
import { createMcpLog } from './mcp-log.js';
import { publicBase as defaultPublicBase } from './public-base.js';

/*
 * Whether /mcp also accepts a logged-in browser's session, with no token. Handy for trying it from a
 * browser while it is new (issue #44, item 9), and it widens nothing - the session's user is the same
 * user, with the same permissions. Set to false to accept tokens only.
 */
const MCP_ACCEPTS_SESSION = true;

// What one tool call may return, counted as values (a row of a bucket with four aggregates is four).
// Well under what fits in Claude's context, and far more than a useful answer needs.
const MAX_VALUES_RETURNED = 10000;
// How long a reading is taken to hold when working out time spent above a threshold. Nodes report on
// change and at least every few minutes (the "duplicates" rules in topics.yaml), so a longer gap
// means the node was not reporting, and the last value is not stretched across it.
const HOLD_MS = 60 * 60 * 1000;
const LEVEL = /^[A-Za-z0-9_.-]+$/;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;

const INSTRUCTIONS = `Frugal IoT: readings from sensor nodes on farms, as recorded by this server.

Data model: organization / project / node / module / field. A node is one device (e.g. esp32-a1b2c3);
a module is a sensor or control on it (sht, soil1, battery); a field is one reading of that module
(temperature, humidity). A full name looks like dev/lotus/esp32-a1b2c3/sht/temperature. Anywhere a
device is asked for, "+" matches any one level after the organization: dev/lotus/+/sht/temperature is
that field on every node of the project. Naming only org/project/node, or org/project/node/module,
means every field under it.

Start with list_scope to see what this user may ask about, and describe_node for what a node measures,
in what units, over which days, and its configured thresholds. get_series gives readings over time,
summarised into buckets (bucket=1h, 1d...) - use buckets for anything longer than a day. summarize_field
answers "which nodes / how long above X" across many nodes at once.

When you show readings as a chart, also give a graph_link for the same selection, so the user has a
live version on this server that they can reopen later or share with others who have access - it
fetches the readings afresh each time, and shows only what whoever opens it may read.

Times: pass from/to as ISO 8601 (2026-11-01T00:00:00+05:30) or as milliseconds since 1970; to defaults
to now. Give tz (an IANA zone such as Asia/Kolkata) to have buckets start at the user's local midnight
and times shown in local time; otherwise UTC. Readings are stamped by the server when they arrive.

Thresholds: a node may have a configured max and min for a field, set by its owner on the dashboard.
"Maxed out" or "too high" means above that configured max. Only today's setting is known, not what it
was in the past. gauge_range in describe_node is only the range a dashboard gauge draws.

Gaps: a missing bucket means no readings then - the node was off, out of range, or not yet installed.
count per bucket shows how well each is covered. Nodes report when a value changes significantly, and
otherwise every few minutes, so readings are not evenly spaced.

Limits: a request that would read or return too much is refused with a message saying what to change
(a larger bucket, a shorter time, fewer nodes). Do that rather than giving up.

Forecasting or other analysis is yours to do with the readings; the server does not predict.`;

// ---- helpers -----------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

// A time in the requested zone, to the second, with its offset: 2026-11-01T05:30:00+05:30
export function localIso(t, tz) {
  const off = tzOffsetMs(tz, t);
  const s = new Date(t + off).toISOString().slice(0, 19);
  if (!off) return `${s}Z`;
  const m = Math.abs(off) / 60000;
  return `${s}${off < 0 ? '-' : '+'}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Enough digits for any sensor, without a mean's 21.333333333333332
const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(6)) : v);

function parseNode(node) {
  const levels = String(node || '').replace(/\/+$/, '').split('/');
  if (levels.length !== 3 || !levels.every((l) => LEVEL.test(l) && l !== '.' && l !== '..')) {
    throw new APIError('invalid_request', 'A node is organization/project/node, e.g. dev/lotus/esp32-a1b2c3');
  }
  return levels;
}

async function subdirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return []; }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.csv(\.gz)?$/;
async function recordedDays(dir) {
  let files;
  try { files = await readdir(dir); } catch { return undefined; }
  const days = files.map((f) => DAY_FILE.exec(f)).filter(Boolean).map((m) => m[1]).sort();
  return days.length ? { first_day: days[0], last_day: days[days.length - 1], days: days.length } : undefined;
}

function allRows(db, sql, args) {
  return new Promise((resolve, reject) => db.all(sql, args, (err, rows) => (err ? reject(err) : resolve(rows))));
}

// ---- the tools ---------------------------------------------------------------------------------

/*
 * The tools' work, apart from MCP, so they can be tested directly. Each takes its arguments and a
 * stats object it fills in for the call log (lib/mcp-log.js): read and returned. Each returns a plain object, which
 * the server sends as JSON text.
 */
export function makeTools({ db, dataDir, loggerClient, organizations, user, origin = '' }) {
  const may = (org, project) => mayUseMCP(user, org, project);
  const fieldSchema = (org, module, field) => {
    const m = loggerClient.schemaModule(org, module);
    return m && { moduleName: m.name, field: (m.fields || []).find((f) => f.field === field) };
  };
  const unitsOf = (org, module, field) => fieldSchema(org, module, field)?.field?.units;

  // Runs fn with a place in the read guard, so tools and GET /api/data share the limit
  async function reading(fn) {
    const done = readGuard.enter(user.id);
    if (!done) throw new APIError('busy', 'The server is busy - try again in a few seconds');
    try {
      await loggerClient.flush();
      return await fn();
    } finally { done(); }
  }

  async function listScope({ org: onlyOrg } = {}, stats = {}) {
    const orgs = organizations() || {};
    const registered = db ? await allRows(db, 'SELECT org, id, name FROM projects', []) : [];
    const live = loggerClient.reportNodes();
    const out = [];
    for (const org of Object.keys(orgs).sort()) {
      if ((onlyOrg && org !== onlyOrg) || !may(org)) continue;
      const names = new Map(registered.filter((r) => r.org === org).map((r) => [r.id, r.name]));
      const projectIds = new Set([...names.keys(), ...Object.keys(live[org] || {}), ...await subdirs(join(dataDir, org))]);
      const projects = [];
      for (const project of [...projectIds].sort()) {
        if (!may(org, project)) continue;
        const known = new Map(loggerClient.listDevices(org, project).map((d) => [d.id.split('/')[2], d]));
        const onDisk = new Set(await subdirs(join(dataDir, org, project)));
        const nodes = [...new Set([...known.keys(), ...onDisk])].sort().map((node) => {
          const d = known.get(node);
          const n = { node: `${org}/${project}/${node}` };
          if (d && d.title) n.name = d.title;
          if (d && d.description) n.description = d.description;
          if (d && d.lastSeen) n.last_seen = new Date(d.lastSeen * 1000).toISOString();
          n.has_recorded_data = onDisk.has(node);
          return n;
        });
        projects.push({ project: `${org}/${project}`, ...(names.get(project) ? { name: names.get(project) } : {}), nodes });
      }
      out.push({ organization: org, name: orgs[org].name || org, projects });
    }
    stats.returned = out.reduce((n, o) => n + o.projects.reduce((m, p) => m + p.nodes.length, 0), 0); // nodes
    if (onlyOrg && !out.length) throw new APIError('not_allowed', `Not allowed to ask about ${onlyOrg}, or there is no such organization`);
    return { organizations: out };
  }

  async function describeNode({ node }, stats = {}) {
    const [org, project, id] = parseNode(node);
    if (!may(org, project)) throw new APIError('not_allowed', `Not allowed to ask about ${org}/${project}`);
    const state = loggerClient.getNodeState(org, project, id);
    const nodeDir = join(dataDir, org, project, id);
    const fields = new Map(); // module/field -> recorded days
    for (const module of await subdirs(nodeDir)) {
      for (const field of await subdirs(join(nodeDir, module))) {
        fields.set(`${module}/${field}`, await recordedDays(join(nodeDir, module, field)));
      }
    }
    for (const key of Object.keys(state)) if (!fields.has(key)) fields.set(key, undefined);
    if (!fields.size) throw new APIError('device_not_found', `Nothing known about ${node}`);

    const modules = {};
    for (const key of [...fields.keys()].sort()) {
      const [module, field] = key.split('/');
      const s = fieldSchema(org, module, field);
      const m = (modules[module] ||= { ...(s && s.moduleName ? { name: s.moduleName } : {}), fields: {} });
      const f = s && s.field;
      const now = state[key] || {};
      const d = {};
      if (f && f.name) d.name = f.name;
      if (f && f.units) d.units = f.units;
      if (f && f.type) d.type = f.type;
      if (f && f.rw && f.rw.includes('w')) d.control = true; // a setting, not a measurement
      if (now.value !== undefined) d.current = now.value;
      if (now.max !== undefined || now.min !== undefined) {
        d.configured = {};
        if (now.min !== undefined) d.configured.min = now.min;
        if (now.max !== undefined) d.configured.max = now.max;
      }
      if (f && (f.min !== undefined || f.max !== undefined)) d.gauge_range = { min: f.min, max: f.max };
      if (fields.get(key)) d.recorded = fields.get(key);
      m.fields[field] = d;
    }
    const live = loggerClient.listDevices(org, project).find((x) => x.id === `${org}/${project}/${id}`);
    const out = { node: `${org}/${project}/${id}` };
    if (live && live.title) out.name = live.title;
    if (live && live.description) out.description = live.description;
    if (live && live.lastSeen) out.last_seen = new Date(live.lastSeen * 1000).toISOString();
    out.modules = modules;
    stats.returned = fields.size; // fields
    return out;
  }

  async function getSeries({ devices, from, to, bucket, agg, tz }, stats = {}) {
    return reading(async () => {
      const r = await queryData({ dataDir, mayRead: may, device: devices, from, to, bucket, agg, tz });
      const columns = r.bucketMs ? ['time', ...r.aggs] : ['time', 'value'];
      const total = r.series.reduce((n, s) => n + (s.rows ? s.rows.length : s.buckets.length * r.aggs.length), 0);
      stats.read = r.stats;
      stats.returned = total; // values - recorded even when refused, which is when it matters
      if (total > MAX_VALUES_RETURNED) {
        throw new APIError('too_much_data', r.bucketMs
          ? `That is ${total} values, more than ${MAX_VALUES_RETURNED} - use a larger bucket, a shorter time, fewer aggregates or fewer fields`
          : `That is ${total} readings, more than ${MAX_VALUES_RETURNED} - add a bucket (e.g. 1h) to have them summarised`);
      }
      return {
        from: localIso(r.fromMs, r.tz), to: localIso(r.toMs, r.tz), tz: r.tz,
        ...(r.bucketMs ? { bucket, note: 'time is the start of each bucket; a bucket with no readings is left out' } : {}),
        series: r.series.map((s) => ({
          device: `${s.org}/${s.project}/${s.node}`,
          field: `${s.module}/${s.field}`,
          ...(unitsOf(s.org, s.module, s.field) ? { units: unitsOf(s.org, s.module, s.field) } : {}),
          columns,
          rows: s.rows
            ? s.rows.map(({ t, v }) => [localIso(t, r.tz), round(v)])
            : s.buckets.map((b) => [localIso(b.t, r.tz), ...r.aggs.map((a) => round(b[a]))]),
        })),
      };
    });
  }

  async function summarizeField({ devices, from, to, tz, above, below }, stats = {}) {
    return reading(async () => {
      const r = await queryData({ dataDir, mayRead: may, device: devices, from, to, tz });
      stats.read = r.stats;
      stats.returned = r.series.length; // fields summarised
      const end = Math.min(r.toMs, Date.now());
      const t = (ms) => localIso(ms, r.tz);
      const results = r.series.map((s) => {
        const rows = s.rows;
        let sum = 0; let lo = rows[0]; let hi = rows[0];
        for (const x of rows) { sum += x.v; if (x.v < lo.v) lo = x; if (x.v > hi.v) hi = x; }
        const state = loggerClient.getNodeState(s.org, s.project, s.node)[`${s.module}/${s.field}`] || {};
        const out = {
          device: `${s.org}/${s.project}/${s.node}`,
          field: `${s.module}/${s.field}`,
          ...(unitsOf(s.org, s.module, s.field) ? { units: unitsOf(s.org, s.module, s.field) } : {}),
          readings: rows.length,
          first: t(rows[0].t),
          last: t(rows[rows.length - 1].t),
          mean: round(sum / rows.length),
          min: { value: round(lo.v), at: t(lo.t) },
          max: { value: round(hi.v), at: t(hi.t) },
        };
        if (state.min !== undefined || state.max !== undefined) out.configured = { min: state.min, max: state.max };
        const overMax = above ?? (typeof state.max === 'number' ? state.max : undefined);
        const underMin = below ?? (typeof state.min === 'number' ? state.min : undefined);
        if (overMax !== undefined) {
          out.above = { threshold: overMax, from: above !== undefined ? 'asked' : 'configured max',
            ...timeBeyond(rows, (v) => v > overMax, end, t) };
        }
        if (underMin !== undefined) {
          out.below = { threshold: underMin, from: below !== undefined ? 'asked' : 'configured min',
            ...timeBeyond(rows, (v) => v < underMin, end, t) };
        }
        return out;
      });
      return {
        from: t(r.fromMs), to: t(r.toMs), tz: r.tz,
        note: `hours beyond a threshold assume each reading holds until the next, for at most ${HOLD_MS / 3600000}h`,
        fields: results,
      };
    });
  }

  /*
   * A link to the client's graph page (frugal-iot-client graph.html) for the same selection. Nothing
   * is drawn here: the page fetches /api/data with the browser's own login, so it shows what whoever
   * opens it may READ - the link carries no access of its own. Checked now, so a link to nothing, or
   * to a project this user may not ask about, is refused here rather than found broken later.
   */
  async function graphLink({ devices, from, to, bucket, tz, title }, stats = {}) {
    const selectors = parseSelectors(devices);
    if (parseTime(from, 'from') === undefined) throw new APIError('invalid_request', 'from is needed');
    parseTime(to, 'to');
    parseBucket(bucket);
    const zone = parseTimeZone(tz);
    const topics = await expandSelectors(selectors, dataDir, may);
    stats.read = { topics: topics.length };
    if (!topics.length) throw new APIError('device_not_found', 'Nothing recorded matches those devices');
    const q = new URLSearchParams();
    for (const d of selectors) q.append('device', d.join('/'));
    q.set('from', from);
    if (to) q.set('to', to);
    if (bucket) q.set('bucket', bucket);
    q.set('tz', zone);
    if (title) q.set('title', String(title).slice(0, 200));
    return {
      url: `${origin}/dashboard/graph.html?${q}`,
      note: 'Opens in a browser logged in to this server, and shows what that login may read. Give it to the user as a link.',
    };
  }

  return { listScope, describeNode, getSeries, summarizeField, graphLink };
}

/*
 * How long readings were beyond a threshold: each reading holds until the next one, or for at most
 * HOLD_MS where the node went quiet. Runs are broken by a reading back within the threshold, or by a
 * silence longer than HOLD_MS.
 */
export function timeBeyond(rows, beyond, end, fmt) {
  let count = 0; let ms = 0; let run; let longest;
  for (let i = 0; i < rows.length; i++) {
    const { t, v } = rows[i];
    const next = i + 1 < rows.length ? rows[i + 1].t : end;
    const hold = Math.max(0, Math.min(next - t, HOLD_MS));
    if (beyond(v)) {
      count++;
      ms += hold;
      if (run && t - run.end > 0) run = undefined; // the node fell silent mid-run
      if (!run) run = { start: t, end: t };
      run.end = t + hold;
      if (!longest || run.end - run.start > longest.end - longest.start) longest = { ...run };
    } else {
      run = undefined;
    }
  }
  const hours = (x) => Math.round(x / 36000) / 100;
  const out = { readings: count, hours: hours(ms) };
  if (longest) out.longest = { start: fmt(longest.start), end: fmt(longest.end), hours: hours(longest.end - longest.start) };
  return out;
}

// ---- MCP ---------------------------------------------------------------------------------------

// JSON Schema for the arguments - what Claude reads to call a tool, and what lib/mcp-protocol.js
// checks a call against before the tool sees it
const str = (description) => ({ type: 'string', description });
const DEVICES = {
  type: 'array', items: { type: 'string' }, minItems: 1, maxItems: LIMITS.MAX_SELECTORS,
  description: 'Devices or fields, e.g. ["dev/lotus/esp32-a1b2c3/sht/temperature"] or ["dev/lotus/+/sht/humidity"]',
};
const FROM = str('Start: ISO 8601, or milliseconds since 1970');
const TO = str('End, as from; defaults to now');
const TZ = str('IANA time zone of the user, e.g. Asia/Kolkata; defaults to UTC');
const args = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

const TOOLS = [
  {
    name: 'list_scope', method: 'listScope',
    description: 'The organizations, projects and nodes this user may ask about, with names and when each node was last heard from.',
    inputSchema: args({ org: str('Only this organization') }),
  },
  {
    name: 'describe_node', method: 'describeNode',
    description: 'What one node measures: its modules and fields, units, current values, the max and min its owner configured, and which days have recorded readings.',
    inputSchema: args({ node: str('organization/project/node, e.g. dev/lotus/esp32-a1b2c3') }, ['node']),
  },
  {
    name: 'get_series', method: 'getSeries',
    description: 'Readings over a period, for one or more fields on one or more nodes. With bucket, summarised per bucket (mean, min, max, count); without, every reading - use a bucket for anything longer than a day. Buckets line up across series, so fields can be compared row by row.',
    inputSchema: args({
      devices: DEVICES, from: FROM, to: TO, tz: TZ,
      bucket: str('Bucket size: a number and m, h or d, e.g. 15m, 1h, 1d'),
      agg: str('With bucket: any of mean,min,max,count, comma separated; defaults to all four'),
    }, ['devices', 'from']),
  },
  {
    name: 'summarize_field', method: 'summarizeField',
    description: 'Statistics for one field across many nodes over a period: mean, min and max with when, and how long and how often each node was above its configured max (or below its min), with the longest such run. Answers "which nodes went over" questions in one call.',
    inputSchema: args({
      devices: DEVICES, from: FROM, to: TO, tz: TZ,
      above: { type: 'number', description: 'A threshold to use instead of each node\'s configured max' },
      below: { type: 'number', description: 'A threshold to use instead of each node\'s configured min' },
    }, ['devices', 'from']),
  },
  {
    name: 'graph_link', method: 'graphLink',
    description: 'A link to a live chart of the same selection as get_series, drawn by this server\'s dashboard, for the user to open in their browser. With a bucket, each series is its mean with a min-max band. Give one whenever you show readings as a chart, so the user can reopen it later or share it with someone who also has access.',
    inputSchema: args({
      devices: DEVICES, from: FROM, to: TO, tz: TZ,
      bucket: str('Bucket size, as for get_series; recommended for more than a day'),
      title: str('A heading for the chart, in the user\'s language'),
    }, ['devices', 'from']),
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

const SERVER = { name: 'frugal-iot', version: VERSION, instructions: INSTRUCTIONS };

function asText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/*
 * The tools for one request, each with call(args) as lib/mcp-protocol.js wants it. who: { user,
 * username, via } for the call log. Every call is recorded, refused ones included - a refusal is the
 * most useful line in it.
 */
function toolsFor(impl, { log, who }) {
  return TOOLS.map(({ method, ...tool }) => ({
    ...tool,
    call: async (callArgs) => {
      const started = Date.now();
      const stats = {};
      const done = (outcome) => log.record({ ...who, tool: tool.name, args: callArgs, ms: Date.now() - started, ...outcome, ...stats });
      try {
        const result = asText(await impl[method](callArgs, stats));
        done({ ok: true });
        return result;
      } catch (err) {
        if (err instanceof APIError) {
          done({ ok: false, error: err.code, message: err.message });
          return { ...asText({ error: err.code, message: err.message }), isError: true };
        }
        console.error('MCP tool', tool.name, 'failed:', err);
        done({ ok: false, error: 'server_error', message: err.message });
        return { ...asText({ error: 'server_error', message: 'Something went wrong on the server' }), isError: true };
      }
    },
  }));
}

/*
 * The router, mounted at /mcp. POST only: stateless, so there is no stream to GET and no session to
 * DELETE. express.json() must already have run.
 */
export function createMcpRouter({ db, dataDir, loggerClient, organizations, log = createMcpLog({ enabled: false }),
  publicBase = defaultPublicBase }) {
  const router = Router();
  // Tool calls per hour: per user, and across everyone. Generous for a conversation, and a backstop
  // against a loop - the read guard and the per-call limits are what protect the disk.
  const limiter = makeRateLimiter({ perOrg: 3000, perNode: 600 });

  router.post('/',
    tokenAuth(db, { purposes: ['mcp'], allowSession: MCP_ACCEPTS_SESSION }),
    async (req, res, next) => {
      try {
        const user = req.user;
        if (!(user.permissions || []).some((p) => p.capability === 'MCP' && mayUseMCP(user, p.org))) {
          return res.status(403).json({ error: 'This login may not use an AI assistant on any organization - an administrator grants MCP' });
        }
        if (!limiter.allow('mcp', String(user.id))) {
          res.set('Retry-After', '60');
          return res.status(429).json({ error: 'Too many requests - try again later' });
        }
        const origin = publicBase(req); // not the request's own Host: behind a proxy that is 127.0.0.1
        const who = { user: user.id, username: user.username, via: req.token ? `token:${req.token.name}` : 'session' };
        const tools = toolsFor(makeTools({ db, dataDir, loggerClient, organizations, user, origin }), { log, who });
        await handleMcpPost(req, res, SERVER, tools);
      } catch (err) { next(err); }
    });
  router.all('/', (req, res) => {
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });
  return router;
}
