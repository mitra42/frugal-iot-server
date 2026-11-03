/*
 * The login made for an organization's own OpenSearch Dashboards. OpenSearch's security API is
 * played by a small server that records what it is asked, since the real one needs a Linux install
 * of OpenSearch with its security plugin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import express from 'express';
import { createAccessRouter, namesFor, roleFor, dashboardsConfig } from '../../lib/opensearch-access.js';

let os, calls, users, replyStatus, app, cfg, user;

beforeEach(async () => {
  calls = []; users = new Set(); replyStatus = null;
  os = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      const m = /internalusers\/(.+)$/.exec(req.url);
      let status = 200;
      let reply = { status: 'OK' };
      if (replyStatus) status = replyStatus;
      else if (req.method === 'GET' && /internalusers$/.test(req.url)) reply = Object.fromEntries([...users, 'admin', 'frugaliot_winam_x'].map((u) => [u, {}]));
      else if (m && req.method === 'GET') status = users.has(decodeURIComponent(m[1])) ? 200 : 404;
      else if (m && req.method === 'PUT') users.add(decodeURIComponent(m[1]));
      else if (m && req.method === 'DELETE') { status = users.delete(decodeURIComponent(m[1])) ? 200 : 404; }
      else if (req.method === 'DELETE' && users.size === 0 && !/internalusers/.test(req.url)) status = 404;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => os.listen(0, '127.0.0.1', r));
  cfg = { node: `http://127.0.0.1:${os.address().port}`, admin: { username: 'secadmin', password: 'pw' }, public: 'https://search.example.org' };
  user = { id: 1, username: 'mitra', permissions: [{ capability: 'READ', org: 'dev', project: '' }] };
  const auth = {
    loggedInOrFail: (q, s, n) => (user ? n() : s.sendStatus(401)),
    can_READ: (q, s, n) => (user.permissions.some((p) => p.capability === 'READ' && p.org === q.params.org) ? n() : s.sendStatus(401)),
  };
  app = express();
  app.use((q, s, n) => { q.user = user; n(); });
  app.use('/opensearch_access', createAccessRouter(() => ({ dev: {}, 'dev-x': {}, winam: {} }), auth, () => cfg));
});
afterEach(() => new Promise((r) => os.close(r)));

describe('the role', () => {
  it('reads only this organization\'s readings, and owns only its own saved-objects index', () => {
    const role = roleFor('dev');
    const patterns = role.index_permissions.map((p) => p.index_patterns).flat();
    expect(patterns).toEqual(['frugaliot-dev-*', '.kibana_dev', '.kibana_dev_*', '*']);
    expect(role.index_permissions[0].allowed_actions).not.toContain('write');
    expect(role.index_permissions[0].allowed_actions).not.toContain('indices_all');
    // The one grant on every index is looking aliases up - Dashboards cannot start without it
    const everywhere = role.index_permissions.filter((p) => p.index_patterns.includes('*'));
    expect(everywhere).toEqual([{ index_patterns: ['*'], allowed_actions: ['indices:admin/aliases/get'] }]);
  });
});

describe('making a login', () => {
  it('makes the role, its mapping and the person\'s login, and shows the password once with the config to use', async () => {
    const res = await request(app).post('/opensearch_access/dev').send({});
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.username).toBe('frugaliot_dev_mitra');
    expect(res.body.config).toContain('opensearch.hosts: [ "https://search.example.org" ]');
    expect(res.body.config).toContain('opensearch.username: "frugaliot_dev_mitra"');
    expect(res.body.config).toContain('opensearchDashboards.index: ".kibana_dev"');
    expect(res.body.config).toContain(JSON.stringify(res.body.password));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /_plugins/_security/api/roles/frugaliot_dev',
      'PUT /_plugins/_security/api/rolesmapping/frugaliot_dev',
      'PUT /_plugins/_security/api/internalusers/frugaliot_dev_mitra',
    ]);
    expect(calls[0].body).toEqual(roleFor('dev'));
    expect(calls[1].body).toEqual({ backend_roles: ['frugaliot_dev'] });
    expect(calls[2].body).toMatchObject({ password: res.body.password, backend_roles: ['frugaliot_dev'] });
    expect(calls[0].auth).toBe('Basic ' + Buffer.from('secadmin:pw').toString('base64'));
  });
  it('gives each person their own login, and a new password each time', async () => {
    const a = await request(app).post('/opensearch_access/dev').send({});
    const b = await request(app).post('/opensearch_access/dev').send({});
    expect(a.body.password).not.toBe(b.body.password);
    expect(a.body.password.length).toBeGreaterThanOrEqual(30);
    user = { id: 2, username: 'sam', permissions: [{ capability: 'READ', org: 'dev', project: '' }] };
    const c = await request(app).post('/opensearch_access/dev').send({});
    expect(c.body.username).toBe('frugaliot_dev_sam');
    expect([...users].sort()).toEqual(['frugaliot_dev_mitra', 'frugaliot_dev_sam']);
  });
  it('says whether you have one, without ever saying its password', async () => {
    expect((await request(app).get('/opensearch_access/dev')).body).toMatchObject({ available: true, exists: false, username: 'frugaliot_dev_mitra' });
    await request(app).post('/opensearch_access/dev').send({});
    const got = await request(app).get('/opensearch_access/dev');
    expect(got.body.exists).toBe(true);
    expect(JSON.stringify(got.body)).not.toMatch(/password/i);
    expect(got.body.all).toBeUndefined(); // only an administrator sees everyone's
  });
  it('removes your login and leaves the role for the others', async () => {
    await request(app).post('/opensearch_access/dev').send({});
    calls.length = 0;
    const res = await request(app).post('/opensearch_access/dev/revoke').send({});
    expect(res.body).toEqual({ revoked: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /_plugins/_security/api/internalusers/frugaliot_dev_mitra']);
  });
});

describe('an organization administrator', () => {
  beforeEach(async () => {
    await request(app).post('/opensearch_access/dev').send({});
    user = { id: 9, username: 'boss', permissions: [{ capability: 'READ', org: 'dev', project: '' }, { capability: 'ADMIN', org: 'dev', project: '' }] };
  });
  it('sees whose logins there are - this organization\'s only', async () => {
    expect((await request(app).get('/opensearch_access/dev')).body.all).toEqual(['mitra']);
  });
  it("can remove someone else's login, and a reader cannot", async () => {
    user = { id: 2, username: 'sam', permissions: [{ capability: 'READ', org: 'dev', project: '' }] };
    expect((await request(app).post('/opensearch_access/dev/revoke').send({ username: 'mitra' })).status).toBe(403);
    expect(users.has('frugaliot_dev_mitra')).toBe(true);
    user = { id: 9, username: 'boss', permissions: [{ capability: 'READ', org: 'dev', project: '' }, { capability: 'ADMIN', org: 'dev', project: '' }] };
    expect((await request(app).post('/opensearch_access/dev/revoke').send({ username: 'mitra' })).body).toEqual({ revoked: true });
    expect(users.has('frugaliot_dev_mitra')).toBe(false);
  });
  it('cannot name a username that is not one', async () => {
    expect((await request(app).post('/opensearch_access/dev/revoke').send({ username: '../x' })).status).toBe(400);
  });
});

describe('when it cannot be done', () => {
  it('says so if OpenSearch refuses the account, without showing a password', async () => {
    replyStatus = 403;
    const res = await request(app).post('/opensearch_access/dev').send({});
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/not allowed to manage logins/);
    expect(JSON.stringify(res.body)).not.toMatch(/password/);
  });
  it('says what is missing when the server has no OpenSearch, or no public address for it', async () => {
    cfg = undefined;
    expect((await request(app).get('/opensearch_access/dev')).body).toMatchObject({ available: false, reason: expect.stringMatching(/no OpenSearch of its own/) });
    expect((await request(app).post('/opensearch_access/dev').send({})).status).toBe(400);
    cfg = { node: 'http://127.0.0.1:1', admin: {} };
    expect((await request(app).get('/opensearch_access/dev')).body.reason).toMatch(/not said where OpenSearch can be reached/);
  });
  it('is only for organizations whose id keeps the index patterns exact', async () => {
    user.permissions.push({ capability: 'READ', org: 'dev-x', project: '' });
    const res = await request(app).post('/opensearch_access/dev-x').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/lower-case letters and digits/);
    expect(calls).toEqual([]);
  });
  it('refuses a username OpenSearch could misread, rather than making a login that is not theirs', async () => {
    user.username = 'a/../b';
    expect((await request(app).post('/opensearch_access/dev').send({})).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('reports OpenSearch being down as unavailable rather than crashing', async () => {
    await new Promise((r) => os.close(r));
    cfg.node = 'http://127.0.0.1:1';
    const res = await request(app).get('/opensearch_access/dev');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    os = http.createServer(); await new Promise((r) => os.listen(0, r)); // for afterEach
  });
});

describe('who may ask', () => {
  it('wants READ for the WHOLE organization: the role covers all of it, so a project reader uses Grafana', async () => {
    user = { id: 3, username: 'lotus', permissions: [{ capability: 'READ', org: 'dev', project: 'lotus' }] };
    const res = await request(app).post('/opensearch_access/dev').send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/whole organization/);
    expect((await request(app).get('/opensearch_access/dev')).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('is for people who can read that organization, and refuses a form post', async () => {
    expect((await request(app).post('/opensearch_access/dev').type('form').send('x=1')).status).toBe(415);
    user = { id: 4, username: 'other', permissions: [{ capability: 'READ', org: 'winam', project: '' }] };
    expect((await request(app).post('/opensearch_access/dev').send({})).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it('quotes the config so a value cannot add lines', () => {
    const cfg = dashboardsConfig({ public: 'https://x.org' }, 'dev', 'mitra', 'pw');
    expect(cfg).toContain('opensearch.requestHeadersAllowlist: []');
    expect(cfg).toContain(`authorization: "Basic ${Buffer.from('frugaliot_dev_mitra:pw').toString('base64')}"`);
    expect(dashboardsConfig({ public: 'https://x.org/"\nevil: 1' }, 'dev', 'mitra', 'p"w')).not.toMatch(/\nevil: 1/);
    expect(namesFor('dev', 'mitra').savedIndex).toBe('.kibana_dev');
  });
});
