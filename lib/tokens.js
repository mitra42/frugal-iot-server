/**
 * Tokens: how a program, rather than a person at a browser, acts as a user.
 *
 * One table and one verifier for every kind of token, told apart by `purpose`:
 *
 *   grafana   Grafana reading one organization's history (lib/grafana.js) - tied to that organization
 *   mcp       Claude, through the MCP endpoint (issue #44) - not tied to an organization: each request
 *             is checked against MCP and READ on whatever organization it touches
 *   platform  a Farm-Platform calling the API of API.md (Section 3.4) - not used yet
 *
 * A token acts as the user who made it, with the permissions that user holds AT THE MOMENT it is used -
 * read from the table on every request, never from a session - so it shows nothing the dashboard would
 * not, and stops working when their access does. What it does not do is authenticate anywhere it is not
 * asked to: tokenAuth is added route by route. Several routes that change state are GETs
 * (/add_permission, /permissions_delete, /ota_delete), so a token honoured everywhere would be an
 * administrator's session in a header.
 *
 * Only a SHA-256 of a token is stored, so a copy of the database (a backup, a laptop) hands out no
 * working credentials, and the token itself is shown once, when it is issued. It is 32 random bytes,
 * which is why a plain hash is enough and no salt or slow hash is needed.
 */

import crypto from 'crypto';
import express, { Router } from 'express';
import { jsonOnly } from './admin-guards.js';

export const PURPOSES = ['grafana', 'mcp', 'platform'];
export const TOKEN_PREFIX = 'fiot_'; // so a leaked one is recognisable, to people and to secret scanners
// For whoever cannot set an Authorization header: API.md Section 3.4 presents the token as a cookie.
// Not the session's cookie (express-session's "connect.sid"), which /mcp may also accept.
export const TOKEN_COOKIE = 'frugal_iot_token';
// Per person, per purpose, per organization
export const MAX_TOKENS_PER_USER = 10;
const LAST_USED_GRANULARITY_MS = 60 * 60 * 1000; // rewritten at most hourly, to spare an SD card
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

export class TooManyTokens extends Error {}
export class TokenNameTaken extends Error {}

const run = (db, sql, args) => new Promise((res, rej) => db.run(sql, args, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, args) => new Promise((res, rej) => db.get(sql, args, (e, r) => (e ? rej(e) : res(r))));
const all = (db, sql, args) => new Promise((res, rej) => db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function validName(name) {
  return typeof name === 'string' && NAME.test(name);
}

/*
 * Make a token, returning it - the only time it is ever available. Issuing a name the user already has
 * replaces its token, which is how one is rotated.
 *
 * Within an organization a name belongs to one user, because that organization's administrator sees
 * them all and revokes by name. With no organization (org '') names are each user's own, so two people
 * can both call theirs "laptop".
 *
 * The limit and the name check are part of the insert, so requests arriving together cannot all get
 * past them.
 */
export async function issueToken(db, { purpose, org = '', name, userId }) {
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown token purpose ${JSON.stringify(purpose)}`);
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const r = await run(db,
    `INSERT INTO api_tokens (purpose, org, user_id, name, token_hash, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE ((SELECT COUNT(*) FROM api_tokens WHERE purpose = ? AND org = ? AND user_id = ?) < ?
              OR EXISTS (SELECT 1 FROM api_tokens WHERE purpose = ? AND org = ? AND user_id = ? AND name = ?))
         AND NOT (? <> '' AND EXISTS (SELECT 1 FROM api_tokens WHERE purpose = ? AND org = ? AND name = ? AND user_id <> ?))
     ON CONFLICT(purpose, org, user_id, name) DO UPDATE SET token_hash = excluded.token_hash,
                                                           created_at = excluded.created_at, last_used = NULL`,
    [purpose, org, userId, name, hashToken(token), Date.now(),
      purpose, org, userId, MAX_TOKENS_PER_USER,
      purpose, org, userId, name,
      org, purpose, org, name, userId]);
  if (r.changes) return token;
  const taken = org && await get(db, 'SELECT 1 FROM api_tokens WHERE purpose = ? AND org = ? AND name = ? AND user_id <> ?',
    [purpose, org, name, userId]);
  if (taken) throw new TokenNameTaken(`The name ${JSON.stringify(name)} is used by someone else - choose another`);
  throw new TooManyTokens(`You can have up to ${MAX_TOKENS_PER_USER} tokens of this kind - revoke one first`);
}

// userId given: that user's. Omitted: everyone's, for an organization's administrator.
export function listTokens(db, { purpose, org = '', userId }) {
  return userId === undefined
    ? all(db, 'SELECT name, created_at, last_used, user_id FROM api_tokens WHERE purpose = ? AND org = ? ORDER BY name', [purpose, org])
    : all(db, 'SELECT name, created_at, last_used, user_id FROM api_tokens WHERE purpose = ? AND org = ? AND user_id = ? ORDER BY name',
      [purpose, org, userId]);
}

// True if there was one to revoke. userId given: only that user's; omitted: anyone's.
export async function revokeToken(db, { purpose, org = '', name, userId }) {
  const r = userId === undefined
    ? await run(db, 'DELETE FROM api_tokens WHERE purpose = ? AND org = ? AND name = ?', [purpose, org, name])
    : await run(db, 'DELETE FROM api_tokens WHERE purpose = ? AND org = ? AND name = ? AND user_id = ?', [purpose, org, name, userId]);
  return r.changes > 0;
}

// { purpose, org, name, userId } for a token, or undefined. Says nothing about what it may do now -
// that is userForToken's, and the route's.
export async function tokenOwner(db, token) {
  if (!token || typeof token !== 'string') return undefined;
  const row = await get(db, 'SELECT id, purpose, org, name, last_used, user_id FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return undefined;
  if (!row.last_used || Date.now() - row.last_used > LAST_USED_GRANULARITY_MS) {
    run(db, 'UPDATE api_tokens SET last_used = ? WHERE id = ?', [Date.now(), row.id])
      .catch(() => {}); // only a convenience for whoever lists them, never worth failing a request over
  }
  return { purpose: row.purpose, org: row.org, name: row.name, userId: row.user_id };
}

/*
 * The user a token acts as, shaped like the req.user a login produces so the existing checks
 * (hasPermissions, can_READ) apply unchanged, with the permissions held NOW. Includes what is granted
 * to everyone (id 0), as a login does. A user who has since been deleted is left with only that.
 */
export async function userForToken(db, userId) {
  const user = await get(db, 'SELECT id, username, name, organization FROM users WHERE id = ?', [userId]);
  const permissions = await all(db, 'SELECT * FROM permissions WHERE id = ? OR id = 0', [userId]);
  return { ...(user || { id: userId }), permissions };
}

// The token a request carries: "Authorization: Bearer <token>", or else the TOKEN_COOKIE cookie.
// Parsed here rather than with cookie-parser, which conflicts with express-session.
export function presentedToken(req) {
  const header = req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  for (const part of (req.get('Cookie') || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === TOKEN_COOKIE) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

/*
 * Middleware for a route that a token may use. A token of one of `purposes` makes req.user the user it
 * acts as (see userForToken) and req.token its owner; anything else presented is refused, even
 * alongside a session, so a wrong token never falls back silently to whoever is logged in.
 *
 * allowSession lets a logged-in browser through as well, with no token - for /mcp while it is being
 * tested (issue #44). Nothing here creates a session.
 */
export function tokenAuth(db, { purposes, allowSession = false }) {
  return async (req, res, next) => {
    try {
      const token = presentedToken(req);
      if (token) {
        const owner = await tokenOwner(db, token);
        if (owner && purposes.includes(owner.purpose)) {
          req.user = await userForToken(db, owner.userId);
          req.token = owner;
          return next();
        }
        return res.status(401).json({ error: 'Not a valid token here' });
      }
      if (allowSession && req.isAuthenticated && req.isAuthenticated()) return next();
      return res.status(401).json({ error: 'A token is needed: Authorization: Bearer <token>' });
    } catch (err) { next(err); }
  };
}

/*
 * Grafana's tokens had a table of their own, grafana_tokens. Its rows move here once, and the table
 * goes - kept, it would bring a revoked token back on the next start, since nothing else tells the
 * two apart. A row with no user (from before tokens were tied to one) was never honoured, so it is
 * left behind rather than moved. Must run after addMissingColumns, which gives an old grafana_tokens
 * its user_id column.
 */
export function migrateTokens(db, cb) {
  db.all('PRAGMA table_info(grafana_tokens)', [], (err, cols) => {
    if (err) return cb(err);
    if (!cols.length) return cb(null); // nothing to move, which is every database made since
    db.exec(`BEGIN;
      INSERT OR IGNORE INTO api_tokens (purpose, org, user_id, name, token_hash, created_at, last_used)
        SELECT 'grafana', org, user_id, name, token_hash, created_at, last_used FROM grafana_tokens
        WHERE user_id IS NOT NULL;
      DROP TABLE grafana_tokens;
      COMMIT;`, (e) => {
      if (e) { db.exec('ROLLBACK', () => cb(e)); return; }
      console.log('Database: moved Grafana tokens into api_tokens');
      cb(null);
    });
  });
}

/*
 * Each user's own tokens that are not tied to an organization - for now, MCP.
 *
 *   GET  /tokens/:purpose               yours: name, made, last used
 *   POST /tokens/:purpose         {name} issue, or reissue (replacing) - the token is in the reply, once
 *   POST /tokens/:purpose/revoke  {name} yours
 *
 * Issuing an MCP token needs MCP on at least one organization; what it can then reach is decided on
 * every request. Nobody revokes another user's: an administrator stops someone by removing their MCP
 * permission, which works on every token they have.
 *
 * Issuing is POST, not GET: a GET could be triggered against a logged-in user by any page that can
 * make their browser fetch a URL. jsonOnly stops a form posted from another site doing the same.
 */
const USER_PURPOSES = { mcp: 'MCP' }; // purpose -> the capability needed, somewhere, to make one

export function createTokenRouter(db, { loggedInOrFail }) {
  const router = Router();
  const bad = (res, status, message) => res.status(status).json({ error: message, message });
  const purposeOk = (req, res, next) => (USER_PURPOSES[req.params.purpose] ? next() : bad(res, 404, 'No such kind of token'));
  const userId = (req) => Number(req.user.id);

  router.get('/:purpose', loggedInOrFail, purposeOk, async (req, res, next) => {
    try {
      const rows = await listTokens(db, { purpose: req.params.purpose, userId: userId(req) });
      res.set('Cache-Control', 'no-store');
      res.json(rows.map(({ user_id, ...t }) => t));
    } catch (err) { next(err); }
  });

  router.post('/:purpose', loggedInOrFail, purposeOk, jsonOnly, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const { purpose } = req.params;
      const capability = USER_PURPOSES[purpose];
      if (!(req.user.permissions || []).some((p) => p.capability === capability)) {
        return bad(res, 403, `You need ${capability} permission on an organization to make one`);
      }
      const name = String((req.body && req.body.name) || '').trim();
      if (!validName(name)) return bad(res, 400, 'name must be 1-40 characters: letters, digits, space, _ . -');
      let token;
      try { token = await issueToken(db, { purpose, name, userId: userId(req) }); }
      catch (err) {
        if (err instanceof TooManyTokens || err instanceof TokenNameTaken) return bad(res, 400, err.message);
        throw err;
      }
      console.log(`Token (${purpose}) issued by`, req.user.username, '-', JSON.stringify(name));
      res.set('Cache-Control', 'no-store'); // the token is in this reply and must not be kept anywhere
      res.status(201).json({ purpose, name, token });
    } catch (err) { next(err); }
  });

  router.post('/:purpose/revoke', loggedInOrFail, purposeOk, jsonOnly, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const name = String((req.body && req.body.name) || '');
      const done = await revokeToken(db, { purpose: req.params.purpose, name, userId: userId(req) });
      console.log(`Token (${req.params.purpose}) revoked by`, req.user.username, '-', JSON.stringify(name));
      res.status(done ? 200 : 404).json({ revoked: done });
    } catch (err) { next(err); }
  });

  return router;
}
