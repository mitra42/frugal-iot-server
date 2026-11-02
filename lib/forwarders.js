/**
 * Forwarders added from the dashboard: where an organization's readings are sent besides the CSV
 * files - OpenSearch, Google Sheets. See frugal-iot-logger for what each does.
 *
 * An organization's YAML file can still carry "forwarders:", and those keep working; what is
 * stored here is added to them. An administrator can add, change, switch off and delete these, and
 * the change takes effect at once: the logger stops the old set and starts the new, without a
 * restart (MqttLogger.setForwarders).
 *
 *   GET  /forwarders/:org           the types that can be added and what fields each takes, the ones
 *                                   stored here, and the ones that come from the file (read-only)
 *   POST /forwarders/:org           {id?, type, name, enabled, config}  add, or change if id is given
 *   POST /forwarders/:org/delete    {id}
 *
 * Organization administrators only. Secrets (a password, an API key, the Google Sheets URL) are
 * never sent back: a forwarder is listed with which of its secrets are set, and leaving a secret
 * blank when changing one keeps what was there.
 *
 * Only some of what the logger accepts in YAML is offered here, on purpose. The server makes these
 * connections, and an organization's administrator is not the server's - so nothing that names a
 * file on this machine (a CA certificate, a Firebase service account) can be set from a browser,
 * and neither can the index prefix, which would let one organization write into another's index.
 * Those stay in the YAML file, which only whoever runs the server can edit.
 */

import express, { Router } from 'express';

// The dashboard's POST reports an error from "message", and the rest of this server's JSON replies say
// "error" - so send both, or a reason such as "OpenSearch URL is required" shows up as just "400".
const fail = (res, status, msg) => res.status(status).json({ error: msg, message: msg });

const run = (db, sql, args) => new Promise((res, rej) => db.run(sql, args, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, args) => new Promise((res, rej) => db.get(sql, args, (e, r) => (e ? rej(e) : res(r))));
const all = (db, sql, args) => new Promise((res, rej) => db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));

// Topic patterns, as in the logger: levels split on "/", "+" for one level, a trailing "#" for the rest.
const TOPIC_PATTERN = /^[A-Za-z0-9_.+#/-]{1,200}$/;

const isUrl = (v, protocols) => {
  try { return protocols.includes(new URL(v).protocol); } catch { return false; }
};

// What can be added from the dashboard, and the fields each takes. The dashboard builds its form
// from this, so a new field or type is added here and nowhere in the browser.
//   kind: string | url | boolean | int | topics        secret: never sent back to the browser
export const FORWARDER_TYPES = {
  opensearch: {
    label: 'OpenSearch',
    help: 'Sends each logged reading to OpenSearch, to browse in OpenSearch Dashboards or Grafana.',
    fields: [
      { key: 'node', label: 'OpenSearch URL', kind: 'url', protocols: ['http:', 'https:'], required: true,
        help: 'e.g. https://localhost:9200' },
      { key: 'username', label: 'Username', kind: 'string', max: 100 },
      { key: 'password', label: 'Password', kind: 'string', secret: true, max: 200 },
      { key: 'apiKey', label: 'API key', kind: 'string', secret: true, max: 500,
        help: 'Instead of a username and password' },
      { key: 'insecure', label: 'Do not check the certificate', kind: 'boolean',
        help: 'For a self-signed certificate on a connection that stays on this machine' },
      { key: 'topics', label: 'Only these topics', kind: 'topics',
        help: 'One per line, e.g. dev/lotus/+/sht/#. Leave empty to send everything that is logged.' },
      { key: 'flushSeconds', label: 'Send every (seconds)', kind: 'int', min: 1, max: 3600 },
    ],
  },
  gsheet: {
    label: 'Google Sheets',
    help: 'Appends a row of the latest values of the chosen topics to a spreadsheet, on a timer.',
    fields: [
      { key: 'url', label: 'Web app URL', kind: 'url', protocols: ['https:'], required: true, secret: true,
        help: 'The Apps Script web app URL. Anyone holding it can write to the sheet.' },
      { key: 'sheet', label: 'Sheet name', kind: 'string', max: 100 },
      { key: 'intervalSeconds', label: 'Add a row every (seconds)', kind: 'int', min: 60, max: 86400, required: true },
      { key: 'topics', label: 'Topics (one column each)', kind: 'topics', required: true,
        help: 'One full topic per line, in column order, e.g. dev/lotus/esp32-3c7ab8/sht/humidity' },
    ],
  },
};

// A cleaned config, or an Error saying what is wrong. `existing` is the config being changed, so that
// a secret left blank keeps its value. Anything not in the type's field list is refused rather than
// dropped, so a typo does not look like it worked.
export function validateConfig(type, input, existing = {}) {
  const def = FORWARDER_TYPES[type];
  if (!def) return new Error(`Unknown type "${type}"`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return new Error('config must be an object');
  const known = new Set(def.fields.map((f) => f.key));
  const stray = Object.keys(input).filter((k) => !known.has(k));
  if (stray.length) return new Error(`Not a setting of ${def.label}: ${stray.join(', ')}`);
  const out = {};
  for (const f of def.fields) {
    let v = input[f.key];
    const blank = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (blank) {
      if (f.secret && existing[f.key] !== undefined) { out[f.key] = existing[f.key]; continue; }
      if (f.required) return new Error(`${f.label} is required`);
      continue;
    }
    switch (f.kind) {
      case 'string':
        if (typeof v !== 'string' || v.length > (f.max || 200)) return new Error(`${f.label} is not valid`);
        break;
      case 'url':
        if (typeof v !== 'string' || v.length > 2000 || !isUrl(v, f.protocols)) {
          return new Error(`${f.label} must be a ${f.protocols.map((p) => p.replace(':', '')).join(' or ')} URL`);
        }
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return new Error(`${f.label} must be true or false`);
        if (!v) continue; // off is the same as not set
        break;
      case 'int':
        v = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
        if (!Number.isInteger(v) || v < f.min || v > f.max) return new Error(`${f.label} must be a whole number from ${f.min} to ${f.max}`);
        break;
      case 'topics':
        if (!Array.isArray(v) || v.length > 500 || !v.every((t) => typeof t === 'string' && TOPIC_PATTERN.test(t))) {
          return new Error(`${f.label}: each must be a topic, such as dev/lotus/+/sht/#`);
        }
        break;
    }
    out[f.key] = v;
  }
  return out;
}

// What the browser may be told about a stored config: everything except the secrets, plus which are set
export function publicConfig(type, config) {
  const def = FORWARDER_TYPES[type];
  const out = { config: {}, secretsSet: [] };
  for (const f of (def ? def.fields : [])) {
    if (config[f.key] === undefined) continue;
    if (f.secret) out.secretsSet.push(f.key); else out.config[f.key] = config[f.key];
  }
  return out;
}

// The same for an entry from the YAML file, whose fields are not limited to the ones above
function fileEntry(entry, index) {
  const def = FORWARDER_TYPES[entry && entry.type];
  const secretKeys = new Set(['password', 'apiKey', 'url', 'serviceAccount', 'ca', 'allowedNodes']);
  const shown = {};
  for (const [k, v] of Object.entries(entry || {})) {
    if (k === 'type') continue;
    if (def ? def.fields.some((f) => f.key === k && f.secret) : secretKeys.has(k)) continue;
    shown[k] = v;
  }
  return { source: 'file', index, type: entry && entry.type, name: `From the configuration file (#${index + 1})`, enabled: true, config: shown };
}

const rowToApi = (r) => ({
  source: 'db', id: r.id, type: r.type, name: r.name, enabled: !!r.enabled,
  ...publicConfig(r.type, JSON.parse(r.config)),
  updated_at: r.updated_at,
});

export const listRows = (db, org) => all(db, 'SELECT * FROM forwarders WHERE org = ? ORDER BY id', [org]);

// What the logger is given: each enabled row as a YAML-style entry
export async function enabledConfigs(db, org) {
  return (await listRows(db, org)).filter((r) => r.enabled).map((r) => ({ type: r.type, ...JSON.parse(r.config) }));
}

/**
 * @param db           sqlite3 database
 * @param mqttLogger   has setForwarders(org, configs)
 * @param orgs         () => the organizations configuration, { org: {...} }
 * @param auth         { loggedInOrFail, can_ADMIN } from frugal-iot-server.js, passed in so tests can stand in
 */
export function createForwardersRouter(db, mqttLogger, orgs, auth) {
  const router = Router();
  const guard = [auth.loggedInOrFail, auth.can_ADMIN];

  const orgExists = (req, res, next) => (orgs()[req.params.org]
    ? next() : fail(res, 404, 'No such organization'));

  // Tell the logger. A failure here must not look like the save failed - the row is stored, and is
  // picked up at the next restart - so it is reported alongside.
  async function apply(org) {
    try {
      await mqttLogger.setForwarders(org, await enabledConfigs(db, org));
      return { applied: true };
    } catch (err) {
      console.error(`Forwarders for ${org} saved but could not be applied:`, err);
      return { applied: false, applyError: err.message };
    }
  }

  router.get('/:org', ...guard, orgExists, async (req, res, next) => {
    try {
      const org = req.params.org;
      const file = (orgs()[org].forwarders || []).map(fileEntry);
      res.json({
        types: Object.fromEntries(Object.entries(FORWARDER_TYPES).map(([k, d]) => [k, { label: d.label, help: d.help, fields: d.fields }])),
        forwarders: (await listRows(db, org)).map(rowToApi),
        fromFile: file,
      });
    } catch (err) { next(err); }
  });

  router.post('/:org', ...guard, orgExists, express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const org = req.params.org;
      const { id, type, config } = req.body || {};
      const name = String((req.body && req.body.name) || '').trim();
      const enabled = req.body && req.body.enabled === false ? 0 : 1;
      if (!/^.{1,60}$/.test(name)) return fail(res, 400, 'Give it a name of up to 60 characters');
      const now = Date.now();
      if (id !== undefined) {
        const row = await get(db, 'SELECT * FROM forwarders WHERE id = ? AND org = ?', [id, org]);
        if (!row) return fail(res, 404, 'No such forwarder');
        if (type !== undefined && type !== row.type) return fail(res, 400, 'A forwarder cannot change type - add a new one');
        const clean = validateConfig(row.type, config, JSON.parse(row.config));
        if (clean instanceof Error) return fail(res, 400, clean.message);
        await run(db, 'UPDATE forwarders SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?',
          [name, enabled, JSON.stringify(clean), now, id]);
        console.log('Forwarder changed by', req.user.username, '-', org, row.type, name);
        return res.json({ id, ...(await apply(org)) });
      }
      const clean = validateConfig(type, config);
      if (clean instanceof Error) return fail(res, 400, clean.message);
      const r = await run(db, 'INSERT INTO forwarders (org, type, name, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [org, type, name, enabled, JSON.stringify(clean), now, now]);
      console.log('Forwarder added by', req.user.username, '-', org, type, name);
      res.status(201).json({ id: r.lastID, ...(await apply(org)) });
    } catch (err) { next(err); }
  });

  router.post('/:org/delete', ...guard, orgExists, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const org = req.params.org;
      const r = await run(db, 'DELETE FROM forwarders WHERE id = ? AND org = ?', [req.body && req.body.id, org]);
      if (!r.changes) return fail(res, 404, 'No such forwarder');
      console.log('Forwarder deleted by', req.user.username, '-', org, req.body.id);
      res.json({ deleted: true, ...(await apply(org)) });
    } catch (err) { next(err); }
  });

  return router;
}
