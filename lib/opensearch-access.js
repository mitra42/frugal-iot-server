/*
 * A login to this server's OpenSearch for a person, to put in OpenSearch Dashboards running on their own
 * computer.
 *
 * OpenSearch Dashboards is a separate program that talks to OpenSearch on a person's behalf. It has
 * ONE login in its own configuration file, and uses it both to read the data and to keep its own saved
 * dashboards and index patterns - in an index inside OpenSearch (".kibana" unless told otherwise).
 * Left alone that is a powerful, shared login. So:
 *
 *   a user     frugaliot_<org>_<username>   one per person per organization, its own password, shown once
 *   a role     frugaliot_<org>              shared by that organization's users: may READ the
 *                                           organization's readings (frugaliot-<org>-*) and do anything
 *                                           to the organization's saved-objects index (.kibana_<org>*),
 *                                           and nothing else
 *   a mapping  from the role's name as a "backend role" of each user - so adding or removing a person
 *              never rewrites a list another request might be changing
 *
 * and a line for Dashboards' config pointing it at that index (opensearchDashboards.index). The people
 * of an organization share its saved dashboards; two organizations' Dashboards do not overwrite each
 * other's.
 *
 * The role covers the WHOLE organization, so only a person who can READ the whole organization may have
 * one (not someone limited to a project) - the others use Grafana, whose tokens follow project
 * permissions. OpenSearch does not look at this server's permissions afterwards: a login stays until it
 * is removed, by its owner or an organization administrator.
 *
 * Made through OpenSearch's security REST API, with the credentials of an account that is allowed to
 * (config.d/opensearch.yaml, "admin"). It needs the security plugin: the Homebrew build has none, so
 * this can only be tried on a real server.
 *
 * Only organizations whose id is lower-case letters and digits qualify - that is what keeps the index
 * patterns exact, and the first "_" after the organization the start of the username - and only
 * usernames of letters, digits, "." "_" and "-".
 *
 *   GET  /opensearch_access/:org           { available, exists, username, hosts, index, all? }
 *   POST /opensearch_access/:org           make your login, or replace its password - shown once
 *   POST /opensearch_access/:org/revoke    {username?} remove yours; an organization administrator may name another's
 */

import crypto from 'crypto';
import http from 'http';
import https from 'https';
import express, { Router } from 'express';
import { jsonOnly } from './admin-guards.js';

const ORG_OK = /^[a-z0-9]{1,20}$/;
const USERNAME_OK = /^[A-Za-z0-9._-]{1,40}$/;
const TIMEOUT_MS = 15000;

export const namesFor = (org, username) => ({
  user: `frugaliot_${org}_${username}`,
  role: `frugaliot_${org}`,
  dataPattern: `frugaliot-${org}-*`,
  savedIndex: `.kibana_${org}`,
});

// The role. Read on the readings; everything on this organization's own saved-objects index and its
// numbered versions. The cluster actions are those Dashboards needs to start and to bulk-write; each
// bulk item is still checked against the index permissions, so they do not open other indices.
export function roleFor(org) {
  const n = namesFor(org);
  return {
    cluster_permissions: ['cluster_composite_ops', 'cluster:monitor/main', 'cluster:monitor/health', 'cluster:monitor/nodes/info', 'cluster:monitor/state'],
    index_permissions: [
      { index_patterns: [n.dataPattern],
        allowed_actions: ['read', 'indices:admin/get', 'indices:admin/mappings/get',
          'indices:admin/resolve/index', 'indices:monitor/settings/get'] },
      { index_patterns: [n.savedIndex, `${n.savedIndex}_*`], allowed_actions: ['indices_all'] },
      // Dashboards looks an alias up before it makes one, and OpenSearch checks that against every index
      { index_patterns: ['*'], allowed_actions: ['indices:admin/aliases/get'] },
    ],
  };
}

// One request to OpenSearch, as the account that may manage logins. https.request rather than fetch,
// because a server's own certificate often is not one a browser would accept and the operator may have
// said to allow that (config.d/opensearch.yaml "insecure"). Resolves { status, body }.
export function osRequest(cfg, method, path, body) {
  const admin = cfg.admin || cfg;
  const url = new URL(path, cfg.node.endsWith('/') ? cfg.node : cfg.node + '/');
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (admin.username) headers.Authorization = 'Basic ' + Buffer.from(`${admin.username}:${admin.password || ''}`).toString('base64');
  if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers, rejectUnauthorized: !cfg.insecure, timeout: TIMEOUT_MS }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('OpenSearch did not answer')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const API = '_plugins/_security/api';
const ok = (r) => r.status >= 200 && r.status < 300;
const enc = encodeURIComponent;

export class AccessError extends Error {}

function need(r, what) {
  if (!ok(r)) {
    const why = r.status === 401 || r.status === 403 ? 'the account in config.d/opensearch.yaml is not allowed to manage logins'
      : `OpenSearch said ${r.status}`;
    throw new AccessError(`Could not ${what}: ${why}`);
  }
}

export async function accessExists(cfg, org, username) {
  const r = await osRequest(cfg, 'GET', `${API}/internalusers/${enc(namesFor(org, username).user)}`);
  if (r.status === 404) return false;
  need(r, 'check for the login');
  return true;
}

// The usernames that have a login for this organization
export async function listAccess(cfg, org) {
  const r = await osRequest(cfg, 'GET', `${API}/internalusers`);
  need(r, 'list the logins');
  const prefix = `frugaliot_${org}_`;
  return Object.keys(r.body || {}).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)).sort();
}

// Makes the organization's role if it is not there (always rewritten, so a change to roleFor reaches
// it), and this person's login - or gives the existing one a new password. Returns { username, password, index }.
export async function createAccess(cfg, org, username) {
  const n = namesFor(org, username);
  const password = crypto.randomBytes(24).toString('base64url');
  need(await osRequest(cfg, 'PUT', `${API}/roles/${enc(n.role)}`, roleFor(org)), 'make the role');
  need(await osRequest(cfg, 'PUT', `${API}/rolesmapping/${enc(n.role)}`, { backend_roles: [n.role] }), 'connect the role');
  need(await osRequest(cfg, 'PUT', `${API}/internalusers/${enc(n.user)}`,
    { password, backend_roles: [n.role], attributes: { frugaliot_org: org, frugaliot_user: username } }), 'make the login');
  return { username: n.user, password, index: n.savedIndex };
}

// Removes the person's login. The role stays: it grants nothing without a user, and the next person
// needs it.
export async function revokeAccess(cfg, org, username) {
  const r = await osRequest(cfg, 'DELETE', `${API}/internalusers/${enc(namesFor(org, username).user)}`);
  if (r.status === 404) return false;
  need(r, 'remove the login');
  return true;
}

// What an administrator copies into opensearch_dashboards.yml
export function dashboardsConfig(cfg, org, username, password) {
  const n = namesFor(org, username);
  return [
    `opensearch.hosts: [ ${JSON.stringify(cfg.public)} ]`,
    `opensearch.username: ${JSON.stringify(n.user)}`,
    `opensearch.password: ${JSON.stringify(password)}`,
    `opensearchDashboards.index: ${JSON.stringify(n.savedIndex)}`,
    // Dashboards uses the login above only for its own housekeeping, and leaves it off requests made for a
    // browser - which would then ask for one. A header set here goes on every request and a browser cannot
    // override it, so nobody is asked.
    'opensearch.requestHeadersAllowlist: []',
    `opensearch.customHeaders: { authorization: ${JSON.stringify('Basic ' + Buffer.from(`${n.user}:${password}`).toString('base64'))} }`,
  ].join('\n');
}

/**
 * @param orgs         () => the organizations configuration
 * @param auth         { loggedInOrFail, can_READ }
 * @param localOpenSearch  () => config.d/opensearch.yaml: { node, admin: {username, password}, insecure, public }
 */
export function createAccessRouter(orgs, auth, localOpenSearch = () => undefined) {
  const router = Router();
  const bad = (res, status, message) => res.status(status).json({ error: message, message });
  const has = (req, capability) => req.user.permissions.some(
    (p) => p.capability === capability && p.org === req.params.org && !p.project);
  const guard = [auth.loggedInOrFail, auth.can_READ];

  // 404 for an organization that is not there. The role covers the whole organization, so the person
  // must be able to read all of it.
  const check = (req, res, next) => {
    if (!orgs()[req.params.org]) return bad(res, 404, 'No such organization');
    if (!has(req, 'READ')) return bad(res, 403, 'A login for OpenSearch Dashboards covers the whole organization, so it needs READ for the whole organization, not one project - use Grafana instead');
    if (!USERNAME_OK.test(String(req.user.username))) return bad(res, 400, 'Your username has characters OpenSearch logins cannot (use letters, digits, . _ -)');
    next();
  };
  const unavailable = (cfg, org) => {
    if (!cfg || !cfg.node) return 'This server has no OpenSearch of its own set up (config.d/opensearch.yaml)';
    if (!cfg.public) return 'This server has not said where OpenSearch can be reached from outside (config.d/opensearch.yaml, "public")';
    if (!ORG_OK.test(org)) return 'OpenSearch logins need an organization id of lower-case letters and digits only';
    return null;
  };

  router.get('/:org', ...guard, check, async (req, res, next) => {
    try {
      const cfg = localOpenSearch();
      const why = unavailable(cfg, req.params.org);
      if (why) return res.json({ available: false, reason: why });
      const n = namesFor(req.params.org, req.user.username);
      try {
        const all = await listAccess(cfg, req.params.org);
        res.json({ available: true, exists: all.includes(req.user.username), username: n.user, hosts: cfg.public, index: n.savedIndex,
          // an organization administrator also sees whose there are, to remove one
          all: has(req, 'ADMIN') ? all : undefined });
      } catch (err) {
        if (err instanceof AccessError) return res.json({ available: false, reason: err.message });
        console.error('OpenSearch Dashboards access: could not reach', cfg.node, '-', err.code || '', err.message);
        return res.json({ available: false, reason: 'OpenSearch did not answer' });
      }
    } catch (err) { next(err); }
  });

  router.post('/:org', ...guard, check, jsonOnly, async (req, res, next) => {
    try {
      const cfg = localOpenSearch();
      const why = unavailable(cfg, req.params.org);
      if (why) return bad(res, 400, why);
      let made;
      try { made = await createAccess(cfg, req.params.org, req.user.username); }
      catch (err) {
        if (err instanceof AccessError) return bad(res, 502, err.message);
        throw err;
      }
      console.log('OpenSearch Dashboards login made for', JSON.stringify(req.user.username), '-', req.params.org);
      res.set('Cache-Control', 'no-store'); // the password is in this reply and must not be kept anywhere
      res.status(201).json({ ...made, hosts: cfg.public, config: dashboardsConfig(cfg, req.params.org, req.user.username, made.password) });
    } catch (err) { next(err); }
  });

  router.post('/:org/revoke', ...guard, check, jsonOnly, express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const cfg = localOpenSearch();
      const why = unavailable(cfg, req.params.org);
      if (why) return bad(res, 400, why);
      const named = req.body && req.body.username !== undefined ? String(req.body.username) : req.user.username;
      if (named !== req.user.username && !has(req, 'ADMIN')) return bad(res, 403, 'Only an administrator of the whole organization can remove someone else\'s login');
      if (!USERNAME_OK.test(named)) return bad(res, 400, 'Not a username');
      let removed;
      try { removed = await revokeAccess(cfg, req.params.org, named); }
      catch (err) {
        if (err instanceof AccessError) return bad(res, 502, err.message);
        throw err;
      }
      console.log('OpenSearch Dashboards login removed by', JSON.stringify(req.user.username), '-', req.params.org, JSON.stringify(named));
      res.json({ revoked: removed });
    } catch (err) { next(err); }
  });

  return router;
}
