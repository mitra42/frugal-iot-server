/*
 * Forwarders added from the dashboard. What matters here: what an administrator may set (and so
 * what a browser can make this server connect to), that a secret never comes back out, and that a
 * change reaches the logger.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'sqlite3';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'fs';
import { createForwardersRouter, validateConfig, checkDestinations, publicConfig, enabledConfigs, typesFor, FORWARDER_TYPES } from '../../lib/forwarders.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');

let db, app, user, applied, orgs;
const open = () => new Promise((res) => { const d = new Database(':memory:'); d.exec(SCHEMA, () => res(d)); });

beforeEach(async () => {
  db = await open();
  user = { username: 'admin', permissions: [{ capability: 'ADMIN', org: 'dev' }] };
  applied = [];
  orgs = { dev: { forwarders: [{ type: 'gsheet', url: 'https://script.google.com/SECRET', sheet: 'S1', intervalSeconds: 300 }] }, winam: {} };
  const auth = {
    loggedInOrFail: (req, res, next) => (user ? next() : res.sendStatus(401)),
    can_ADMIN: (req, res, next) =>
      (user && user.permissions.some((p) => p.capability === 'ADMIN' && p.org === req.params.org) ? next() : res.sendStatus(401)),
  };
  const logger = { setForwarders: async (org, configs) => { applied.push([org, configs]); } };
  app = express();
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/forwarders', createForwardersRouter(db, logger, () => orgs, auth, { lookup: fakeLookup }));
});

// DNS stands in: localhost is this machine, anything with "internal" in it is private, the rest are public
const fakeLookup = async (host) => [{ address: host === 'localhost' ? '127.0.0.1' : /internal/.test(host) ? '10.0.0.5' : '93.184.216.34' }];

const OS = { node: 'https://search.example.org', username: 'admin', password: 'os-secret', topics: ['dev/lotus/#'] };
const add = (body = {}) => request(app).post('/forwarders/dev').send({ type: 'opensearch', name: 'Search', config: OS, ...body });

describe('validateConfig', () => {
  it('accepts a complete OpenSearch config, and turns a numeric string into a number', () => {
    expect(validateConfig('opensearch', { ...OS, flushSeconds: '30' })).toEqual({ ...OS, flushSeconds: 30 });
  });
  it('refuses a setting the type does not offer - including the ones that name files or other orgs', () => {
    for (const bad of [{ ca: '/etc/passwd' }, { indexPrefix: 'frugaliot-winam' }, { serviceAccount: '/x' }]) {
      expect(validateConfig('opensearch', { ...OS, ...bad })).toBeInstanceOf(Error);
    }
  });
  it('wants the required settings', () => {
    expect(validateConfig('opensearch', { username: 'x' }).message).toMatch(/OpenSearch URL is required/);
    expect(validateConfig('gsheet', { url: 'https://x.org/y', intervalSeconds: 300 }).message).toMatch(/Topics/);
  });
  it('holds URLs to the protocols that make sense', () => {
    expect(validateConfig('opensearch', { node: 'file:///etc/passwd' })).toBeInstanceOf(Error);
    expect(validateConfig('opensearch', { node: 'not a url' })).toBeInstanceOf(Error);
    expect(validateConfig('gsheet', { url: 'http://script.google.com/x', intervalSeconds: 300, topics: ['a/b/c/d/e'] })).toBeInstanceOf(Error);
  });
  it('checks numbers and topics', () => {
    expect(validateConfig('gsheet', { url: 'https://x.org/y', intervalSeconds: 5, topics: ['a/b/c/d/e'] })).toBeInstanceOf(Error);
    expect(validateConfig('opensearch', { ...OS, topics: ['a b'] })).toBeInstanceOf(Error);
    expect(validateConfig('opensearch', { ...OS, flushSeconds: 'x' })).toBeInstanceOf(Error);
  });
  it('keeps an existing secret when it is left blank, and replaces it when given', () => {
    expect(validateConfig('opensearch', { node: OS.node, password: '' }, { password: 'old' }).password).toBe('old');
    expect(validateConfig('opensearch', { node: OS.node, password: 'new' }, { password: 'old' }).password).toBe('new');
  });
  it('knows no type it was not told about', () => {
    expect(validateConfig('firebase', {})).toBeInstanceOf(Error);
    expect(Object.keys(FORWARDER_TYPES)).toEqual(['opensearch-local', 'opensearch', 'gsheet']);
  });
});

describe('where a forwarder may connect', () => {
  it('refuses a URL with a login in it', () => {
    expect(validateConfig('opensearch', { node: 'https://admin:pw@search.example.org' }).message).toMatch(/must not contain a login/);
  });
  it('wants https for another server, and has no way to skip the certificate check', () => {
    expect(validateConfig('opensearch', { node: 'https://search.example.org' })).toEqual({ node: 'https://search.example.org' });
    expect(validateConfig('opensearch', { node: 'http://search.example.org' })).toBeInstanceOf(Error);
    expect(validateConfig('opensearch', { node: 'https://search.example.org', insecure: true })).toBeInstanceOf(Error);
  });
});

describe('where the server may be told to connect', () => {
  const check = (type, config) => checkDestinations(type, config, { lookup: fakeLookup });
  it('refuses what is private, link-local or hidden in another spelling', async () => {
    for (const node of ['http://169.254.169.254/latest', 'http://[::ffff:a9fe:a9fe]/', 'http://metadata.google.internal./',
      'http://10.0.0.5:9200', 'http://192.168.1.1', 'http://100.100.100.200/', 'http://[::]/', 'http://db.internal.example:9200']) {
      expect(await check('opensearch', { node }), node).toMatch(/OpenSearch URL .*not allowed/);
    }
  });
  it('allows nothing on this machine for another-server OpenSearch either, port 9200 included', async () => {
    for (const node of ['https://localhost:9200', 'http://127.0.0.1:9200', 'https://[::1]:9200', 'https://localhost']) {
      expect(await check('opensearch', { node }), node).toMatch(/may not point at this machine/);
    }
    expect(await check('opensearch', { node: 'https://search.example.org' })).toBeNull();
  });
  it('allows nothing on this machine for Google Sheets', async () => {
    expect(await check('gsheet', { url: 'https://localhost:9200/x' })).toMatch(/may not point at this machine/);
    expect(await check('gsheet', { url: 'https://script.google.com/macros/s/x/exec' })).toBeNull();
  });
});

describe('OpenSearch on this server', () => {
  const LOCAL = { node: 'https://localhost:9200', username: 'logger', password: 'local-secret', insecure: true };
  let withLocal;
  beforeEach(() => {
    withLocal = express();
    withLocal.use((req, res, next) => { req.user = user; next(); });
    withLocal.use('/forwarders', createForwardersRouter(db, { setForwarders: async (org, configs) => { applied.push([org, configs]); } },
      () => orgs, { loggedInOrFail: (q, r, n) => n(), can_ADMIN: (q, r, n) => n() }, { lookup: fakeLookup, localOpenSearch: () => LOCAL }));
  });
  const addLocal = (body = {}) => request(withLocal).post('/forwarders/dev').send({ type: 'opensearch-local', name: 'Mine', config: { topics: ['dev/lotus/#'] }, ...body });

  it('is offered only on a server that has one', async () => {
    expect(Object.keys(typesFor(undefined))).toEqual(['opensearch', 'gsheet']);
    expect(Object.keys(typesFor({}))).toEqual(['opensearch', 'gsheet']);
    expect(Object.keys(typesFor(LOCAL))).toEqual(['opensearch-local', 'opensearch', 'gsheet']);
    expect((await request(app).post('/forwarders/dev').send({ type: 'opensearch-local', name: 'x', config: {} })).status).toBe(400);
    expect(Object.keys((await request(withLocal).get('/forwarders/dev')).body.types)).toContain('opensearch-local');
    expect(Object.keys((await request(app).get('/forwarders/dev')).body.types)).not.toContain('opensearch-local');
  });
  it('takes no address or login from the browser', () => {
    for (const bad of [{ node: 'https://evil.example' }, { username: 'x' }, { password: 'x' }, { insecure: true }]) {
      expect(validateConfig('opensearch-local', bad)).toBeInstanceOf(Error);
    }
  });
  it("is given the operator's address and credentials only when it goes to the logger", async () => {
    const res = await addLocal();
    expect(res.status).toBe(201);
    expect(applied.at(-1)).toEqual(['dev', [{ type: 'opensearch', ...LOCAL, apiKey: undefined, topics: ['dev/lotus/#'] }]]);
    const listed = JSON.stringify((await request(withLocal).get('/forwarders/dev')).body);
    expect(listed).not.toContain('local-secret');
    expect(listed).not.toContain('localhost');
    const stored = await new Promise((r) => db.get('SELECT config FROM forwarders', (e, x) => r(x.config)));
    expect(stored).not.toContain('local-secret');
  });
  it('is left out of what the logger gets if the server stops having one', async () => {
    await addLocal();
    expect(await enabledConfigs(db, 'dev', undefined)).toEqual([]);
  });
});

describe('publicConfig', () => {
  it('leaves secrets out and says which are set', () => {
    expect(publicConfig('opensearch', OS)).toEqual({
      config: { node: OS.node, username: 'admin', topics: ['dev/lotus/#'] }, secretsSet: ['password'],
    });
  });
});

describe('the API', () => {
  it('adds one, stores it, and tells the logger', async () => {
    const res = await add();
    expect(res.status).toBe(201);
    expect(res.body.applied).toBe(true);
    expect(applied).toEqual([['dev', [{ type: 'opensearch', ...OS }]]]);
  });
  it('never sends a secret back', async () => {
    await add();
    const res = await request(app).get('/forwarders/dev');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('os-secret');
    expect(text).not.toContain('SECRET'); // the file one's Google Sheets URL
    expect(res.body.forwarders[0].secretsSet).toEqual(['password']);
    expect(res.body.forwarders[0].config.node).toBe(OS.node);
  });
  it('lists the forwarders from the configuration file, read-only and without their secrets', async () => {
    const res = await request(app).get('/forwarders/dev');
    expect(res.body.fromFile).toHaveLength(1);
    expect(res.body.fromFile[0]).toMatchObject({ source: 'file', type: 'gsheet' });
    expect(res.body.fromFile[0].config).toEqual({ sheet: 'S1', intervalSeconds: 300 });
  });
  it('describes the types so the dashboard can build its form', async () => {
    const res = await request(app).get('/forwarders/dev');
    expect(res.body.types.opensearch.fields.map((f) => f.key)).toContain('node');
    expect(res.body.types.opensearch.links).toEqual([]);
  });
  it('points Google Sheets at the script to copy, and says to follow its instructions', async () => {
    const { gsheet } = (await request(app).get('/forwarders/dev')).body.types;
    expect(gsheet.links[0].url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.*\/examples\/gsheets\/gsheet_app$/);
    expect(gsheet.help).toMatch(/follow the instructions at the top of the file/);
  });
  it('changes one, keeping a secret left blank, and re-applies', async () => {
    const { body } = await add();
    const res = await request(app).post('/forwarders/dev')
      .send({ id: body.id, name: 'Renamed', config: { ...OS, password: '', username: 'bob' } });
    expect(res.status).toBe(200);
    const last = applied.at(-1)[1][0];
    expect(last).toMatchObject({ username: 'bob', password: 'os-secret' });
  });
  it('switching one off stops sending to it', async () => {
    const { body } = await add();
    await request(app).post('/forwarders/dev').send({ id: body.id, name: 'Search', enabled: false, config: OS });
    expect(applied.at(-1)).toEqual(['dev', []]);
  });
  it('deletes one and re-applies', async () => {
    const { body } = await add();
    const res = await request(app).post('/forwarders/dev/delete').send({ id: body.id });
    expect(res.body.deleted).toBe(true);
    expect(applied.at(-1)).toEqual(['dev', []]);
    expect((await request(app).post('/forwarders/dev/delete').send({ id: body.id })).status).toBe(404);
  });
  it('cannot change or delete another organization\'s forwarder', async () => {
    user.permissions.push({ capability: 'ADMIN', org: 'winam' });
    const { body } = await request(app).post('/forwarders/winam').send({ type: 'opensearch', name: 'W', config: OS });
    expect((await request(app).post('/forwarders/dev').send({ id: body.id, name: 'x', config: OS })).status).toBe(404);
    expect((await request(app).post('/forwarders/dev/delete').send({ id: body.id })).status).toBe(404);
    expect(await enabledConfigs(db, 'winam')).toHaveLength(1);
  });
  it('will not save somewhere the server must not connect to', async () => {
    const res = await add({ config: { ...OS, node: 'https://[::ffff:a9fe:a9fe]/' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not allowed/);
    expect((await add({ config: { ...OS, node: 'https://localhost:9200' } })).status).toBe(400);
    expect((await add({ config: { ...OS, node: 'https://db.internal.example:9200' } })).status).toBe(400);
    expect(await enabledConfigs(db, 'dev')).toEqual([]);
  });
  it('checks where it points on a change too, not only when it is first added', async () => {
    const { body } = await add();
    const res = await request(app).post('/forwarders/dev').send({ id: body.id, name: 'x', config: { ...OS, node: 'https://10.0.0.5:9200' } });
    expect(res.status).toBe(400);
    expect((await enabledConfigs(db, 'dev'))[0].node).toBe(OS.node);
  });
  it('refuses a plain form post, which another site could send with an administrator\'s session', async () => {
    const res = await request(app).post('/forwarders/dev').type('form').send('type=opensearch&name=x&config[node]=https://evil.example/');
    expect(res.status).toBe(415);
    expect(await enabledConfigs(db, 'dev')).toEqual([]);
    expect((await request(app).post('/forwarders/dev/delete').type('form').send('id=1')).status).toBe(415);
  });
  it('needs ADMIN for the whole organization, not for one project of it', async () => {
    user.permissions = [{ capability: 'ADMIN', org: 'dev', project: 'lotus' }];
    expect((await add()).status).toBe(403);
    expect((await request(app).get('/forwarders/dev')).status).toBe(403);
    expect((await request(app).post('/forwarders/dev/delete').send({ id: 1 })).status).toBe(403);
    expect(applied).toEqual([]);
    user.permissions = [{ capability: 'ADMIN', org: 'dev', project: '' }];
    expect((await add()).status).toBe(201);
  });
  it('shows a file entry only what its type offers - not a key nobody told this code about', async () => {
    orgs.dev.forwarders = [{ type: 'opensearch', node: 'https://x.example', ca: '/etc/ssl/private/ca.pem', token: 'sekrit', password: 'pw', flushSeconds: 5 }];
    const text = JSON.stringify((await request(app).get('/forwarders/dev')).body.fromFile);
    expect(text).toContain('https://x.example');
    for (const hidden of ['/etc/ssl/private/ca.pem', 'sekrit', 'pw']) expect(text).not.toContain(hidden);
  });
  it('limits the topic patterns, since each logged message is matched against every one', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `dev/lotus/n${i}/sht/temperature`);
    expect((await add({ config: { ...OS, topics: many } })).status).toBe(400);
    expect((await add({ config: { ...OS, topics: many.slice(0, 100) } })).status).toBe(201);
  });
  it('the limit holds when requests arrive together', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => add({ name: `S${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(await enabledConfigs(db, 'dev')).toHaveLength(10);
  });
  it('stops at ten forwarders for one organization', async () => {
    for (let i = 0; i < 10; i++) expect((await add({ name: `S${i}` })).status).toBe(201);
    const res = await add({ name: 'one too many' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/up to 10 forwarders/);
  });
  it('a type cannot be changed by editing', async () => {
    const { body } = await add();
    expect((await request(app).post('/forwarders/dev').send({ id: body.id, type: 'gsheet', name: 'x', config: OS })).status).toBe(400);
  });
  it('refuses bad input with a reason, and stores nothing', async () => {
    const res = await add({ config: { ...OS, node: 'file:///etc/passwd' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/OpenSearch URL/);
    expect(res.body.message).toBe(res.body.error); // the dashboard reads "message"
    expect(await enabledConfigs(db, 'dev')).toEqual([]);
    expect((await add({ name: '' })).status).toBe(400);
  });
  it('is for administrators of that organization only', async () => {
    expect((await request(app).get('/forwarders/winam')).status).toBe(401);
    expect((await request(app).post('/forwarders/winam').send({ type: 'opensearch', name: 'x', config: OS })).status).toBe(401);
    user = null;
    expect((await request(app).get('/forwarders/dev')).status).toBe(401);
    expect(applied).toEqual([]);
  });
  it('says so, rather than failing, if the logger could not be told', async () => {
    const auth = { loggedInOrFail: (r, s, n) => n(), can_ADMIN: (r, s, n) => n() };
    const broken = express();
    broken.use((req, res, next) => { req.user = { username: 'a', permissions: [{ capability: 'ADMIN', org: 'dev' }] }; next(); });
    broken.use('/forwarders', createForwardersRouter(db, { setForwarders: async () => { throw new Error('boom'); } }, () => orgs, auth, { lookup: fakeLookup }));
    const res = await request(broken).post('/forwarders/dev').send({ type: 'opensearch', name: 'x', config: OS });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ applied: false, applyError: 'boom' });
    expect(await enabledConfigs(db, 'dev')).toHaveLength(1); // still stored
  });
  it('knows nothing of an organization that does not exist', async () => {
    user.permissions.push({ capability: 'ADMIN', org: 'ghost' });
    expect((await request(app).get('/forwarders/ghost')).status).toBe(404);
  });
});

describe('sending earlier readings', () => {
  let calls, finish, fail, appB;
  const LOCAL = { node: 'https://localhost:9200', username: 'admin', password: 'local-secret', insecure: true };
  const wait = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(() => {
    calls = [];
    const auth = {
      loggedInOrFail: (req, res, next) => next(),
      can_ADMIN: (req, res, next) => next(),
    };
    // A job that runs until the test says it is done
    const backfill = (args) => new Promise((res, rej) => {
      calls.push(args);
      args.progress(10);
      finish = () => res({ sent: 42, skippedFiles: 1 });
      fail = () => rej(new Error('No data/dev'));
    });
    appB = express();
    appB.use((req, res, next) => { req.user = user; next(); });
    appB.use('/forwarders', createForwardersRouter(db, { setForwarders: async () => {} }, () => orgs, auth,
      { lookup: fakeLookup, localOpenSearch: () => LOCAL, backfill, dataDir: '/data' }));
  });
  const addOne = async (type = 'opensearch', over = {}) =>
    (await request(appB).post('/forwarders/dev').send({ type, name: 'S', config: type === 'opensearch-local' ? {} : OS, ...over })).body.id;
  const start = (id, body = {}) => request(appB).post('/forwarders/dev/backfill').send({ id, ...body });

  it('starts it, with the forwarder\'s own settings, and says how far it has got', async () => {
    const id = await addOne();
    const res = await start(id, { since: '2026-09-01' });
    expect(res.status).toBe(202);
    expect(calls[0]).toMatchObject({ org: 'dev', dataDir: '/data', since: '2026-09-01', dryRun: false });
    expect(calls[0].config).toMatchObject({ type: 'opensearch', node: OS.node, password: 'os-secret' });
    expect((await request(appB).get(`/forwarders/dev/backfill/${id}`)).body).toMatchObject({ running: true, sent: 10 });
    finish(); await wait();
    expect((await request(appB).get(`/forwarders/dev/backfill/${id}`)).body).toMatchObject({ running: false, sent: 42, skippedFiles: 1 });
  });
  it('gives the local one the operator\'s address and login, which never reach the browser', async () => {
    const id = await addOne('opensearch-local');
    expect((await start(id, { dryRun: true })).status).toBe(202);
    expect(calls[0].config).toMatchObject({ type: 'opensearch', node: LOCAL.node, password: 'local-secret', insecure: true });
    expect(calls[0].dryRun).toBe(true);
    const status = JSON.stringify((await request(appB).get(`/forwarders/dev/backfill/${id}`)).body);
    expect(status).not.toMatch(/local-secret/);
  });
  it('does one at a time for a forwarder, and again once it is done', async () => {
    const id = await addOne();
    await start(id);
    expect((await start(id)).status).toBe(409);
    finish(); await wait();
    expect((await start(id)).status).toBe(202);
  });
  it('reports a failure', async () => {
    const id = await addOne();
    await start(id);
    fail(); await wait();
    expect((await request(appB).get(`/forwarders/dev/backfill/${id}`)).body).toMatchObject({ running: false, error: 'No data/dev' });
  });
  it('refuses a bad date, another type, a switched-off forwarder and one that is not there', async () => {
    const os = await addOne();
    const sheet = (await request(appB).post('/forwarders/dev').send({ type: 'gsheet', name: 'G', config: { url: 'https://script.google.com/x', intervalSeconds: 300, topics: ['a/b/c/d/e'] } })).body.id;
    const off = await addOne('opensearch', { enabled: false });
    expect((await start(os, { since: 'yesterday' })).status).toBe(400);
    expect((await start(os, { since: '2026-02-31' })).status).toBe(400);
    expect((await start(os, { since: '2026-13-45' })).status).toBe(400);
    expect((await start(sheet)).status).toBe(400);
    expect((await start(off)).status).toBe(400);
    expect((await start(9999)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it('is for administrators of that organization, and only for forwarders of that organization', async () => {
    const id = await addOne();
    orgs.winam = {};
    expect((await request(appB).post('/forwarders/winam/backfill').send({ id })).status).toBe(403);
  });
  it('says so when this server cannot', async () => {
    const bare = express();
    bare.use((req, res, next) => { req.user = user; next(); });
    bare.use('/forwarders', createForwardersRouter(db, { setForwarders: async () => {} }, () => orgs,
      { loggedInOrFail: (q, s, n) => n(), can_ADMIN: (q, s, n) => n() }, { lookup: fakeLookup }));
    expect((await request(bare).post('/forwarders/dev/backfill').send({ id: 1 })).status).toBe(501);
  });
});
