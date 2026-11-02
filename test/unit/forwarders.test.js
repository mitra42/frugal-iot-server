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
import { createForwardersRouter, validateConfig, publicConfig, enabledConfigs, FORWARDER_TYPES } from '../../lib/forwarders.js';

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
  app.use('/forwarders', createForwardersRouter(db, logger, () => orgs, auth));
});

const OS = { node: 'https://localhost:9200', username: 'admin', password: 'os-secret', topics: ['dev/lotus/#'] };
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
    expect(Object.keys(FORWARDER_TYPES)).toEqual(['opensearch', 'gsheet']);
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
    broken.use((req, res, next) => { req.user = { username: 'a' }; next(); });
    broken.use('/forwarders', createForwardersRouter(db, { setForwarders: async () => { throw new Error('boom'); } }, () => orgs, auth));
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
