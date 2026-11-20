/*
 * Tokens of every purpose: issuing, the verifier routes opt into, the user-level routes for MCP
 * tokens, and moving Grafana's tokens out of the table they used to have.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'sqlite3';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'fs';
import {
  issueToken, listTokens, revokeToken, tokenOwner, userForToken, tokenAuth, presentedToken,
  createTokenRouter, migrateTokens, hashToken, MAX_TOKENS_PER_USER, TOKEN_COOKIE,
} from '../../lib/tokens.js';
import { addMissingColumns } from '../../lib/schema-columns.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');

let db;
const open = (sql = SCHEMA) => new Promise((res) => { const d = new Database(':memory:'); d.exec(sql, () => res(d)); });
const exec = (sql, args = []) => new Promise((res, rej) => db.run(sql, args, (e) => (e ? rej(e) : res())));
const rows = (sql, args = []) => new Promise((res, rej) => db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));
const grant = (id, capability, org, project = '') =>
  exec('INSERT OR IGNORE INTO permissions (id, capability, org, project) VALUES (?, ?, ?, ?)', [id, capability, org, project]);
const mcp = (userId, name = 'laptop') => issueToken(db, { purpose: 'mcp', name, userId });

beforeEach(async () => {
  db = await open();
  await exec("INSERT INTO users (id, username, name) VALUES (5, 'fred', 'Fred')");
  await exec("INSERT INTO users (id, username, name) VALUES (6, 'jo', 'Jo')");
});

describe('issuing', () => {
  it('only the hash is stored, and the owner is known from the token', async () => {
    const token = await mcp(5);
    expect(token).toMatch(/^fiot_/);
    expect(await tokenOwner(db, token)).toEqual({ purpose: 'mcp', org: '', name: 'laptop', userId: 5 });
    expect(JSON.stringify(await rows('SELECT * FROM api_tokens'))).not.toContain(token);
  });
  it('an unknown, empty or non-string token is nobody', async () => {
    expect(await tokenOwner(db, 'fiot_nope')).toBeUndefined();
    expect(await tokenOwner(db, '')).toBeUndefined();
    expect(await tokenOwner(db, ['fiot_x'])).toBeUndefined();
  });
  it('issuing a name again replaces its token', async () => {
    const first = await mcp(5);
    const second = await mcp(5);
    expect(await tokenOwner(db, first)).toBeUndefined();
    expect(await tokenOwner(db, second)).toBeTruthy();
    expect(await listTokens(db, { purpose: 'mcp', userId: 5 })).toHaveLength(1);
  });
  it('with no organization, two users can each have the same name', async () => {
    const a = await mcp(5);
    const b = await mcp(6);
    expect((await tokenOwner(db, a)).userId).toBe(5);
    expect((await tokenOwner(db, b)).userId).toBe(6);
  });
  it('within an organization a name is one user\'s, as its administrator revokes by name', async () => {
    await issueToken(db, { purpose: 'grafana', org: 'dev', name: 'home', userId: 5 });
    await expect(issueToken(db, { purpose: 'grafana', org: 'dev', name: 'home', userId: 6 })).rejects.toThrow(/used by someone else/);
    await expect(issueToken(db, { purpose: 'grafana', org: 'winam', name: 'home', userId: 6 })).resolves.toMatch(/^fiot_/);
  });
  it('a purpose limits only its own kind', async () => {
    await issueToken(db, { purpose: 'grafana', org: 'dev', name: 'home', userId: 5 });
    await expect(issueToken(db, { purpose: 'mcp', name: 'home', userId: 5 })).resolves.toMatch(/^fiot_/);
    expect(await listTokens(db, { purpose: 'mcp', userId: 5 })).toHaveLength(1);
  });
  it('refuses a purpose it does not know', async () => {
    await expect(issueToken(db, { purpose: 'root', name: 'x', userId: 5 })).rejects.toThrow(/Unknown token purpose/);
  });
  it('holds each user to the limit, even when asked all at once', async () => {
    const results = await Promise.all(Array.from({ length: MAX_TOKENS_PER_USER + 5 }, (_, i) =>
      mcp(5, `t${i}`).then(() => 'ok', () => 'refused')));
    expect(results.filter((r) => r === 'ok')).toHaveLength(MAX_TOKENS_PER_USER);
    const held = (await listTokens(db, { purpose: 'mcp', userId: 5 }))[0].name; // which ten got in varies
    await expect(mcp(5, held)).resolves.toMatch(/^fiot_/); // replacing one is always allowed
    await expect(mcp(6, 'other')).resolves.toMatch(/^fiot_/); // and the limit is per user
  });
  it('a revoked token stops working, and only its owner\'s is revoked', async () => {
    const mine = await mcp(5);
    const theirs = await mcp(6);
    expect(await revokeToken(db, { purpose: 'mcp', name: 'laptop', userId: 5 })).toBe(true);
    expect(await tokenOwner(db, mine)).toBeUndefined();
    expect(await tokenOwner(db, theirs)).toBeTruthy();
    expect(await revokeToken(db, { purpose: 'mcp', name: 'laptop', userId: 5 })).toBe(false);
  });
});

describe('the user a token acts as', () => {
  it('looks like a login\'s, with the permissions held now and those granted to everyone', async () => {
    await grant(5, 'READ', 'dev');
    await grant(0, 'READ', 'public');
    const u = await userForToken(db, 5);
    expect(u).toMatchObject({ id: 5, username: 'fred', name: 'Fred' });
    expect(u.permissions.map((p) => p.org).sort()).toEqual(['dev', 'public']);
    await exec('DELETE FROM permissions WHERE id = 5');
    expect((await userForToken(db, 5)).permissions.map((p) => p.org)).toEqual(['public']);
  });
  it('a deleted user keeps only what everyone has', async () => {
    await grant(0, 'READ', 'public');
    const u = await userForToken(db, 99);
    expect(u.id).toBe(99);
    expect(u.permissions.map((p) => p.org)).toEqual(['public']);
  });
});

describe('presentedToken', () => {
  const req = (headers) => ({ get: (h) => headers[h] });
  it('reads a Bearer header first, then the cookie', () => {
    expect(presentedToken(req({ Authorization: 'Bearer fiot_a', Cookie: `${TOKEN_COOKIE}=fiot_b` }))).toBe('fiot_a');
    expect(presentedToken(req({ Cookie: `connect.sid=s%3Ax; ${TOKEN_COOKIE}=fiot_b` }))).toBe('fiot_b');
  });
  it('ignores the session cookie and anything malformed', () => {
    expect(presentedToken(req({ Cookie: 'connect.sid=s%3Ax' }))).toBe('');
    expect(presentedToken(req({ Authorization: 'Basic abc' }))).toBe('');
    expect(presentedToken(req({ Cookie: `${TOKEN_COOKIE}=%E0%A4%A` }))).toBe('');
    expect(presentedToken(req({}))).toBe('');
  });
});

describe('tokenAuth', () => {
  let app, session;
  beforeEach(() => {
    session = undefined;
    app = express();
    // Stands in for passport: a session, when there is one, puts its user here first
    app.use((req, res, next) => { req.user = session; req.isAuthenticated = () => !!req.user; next(); });
    const show = (req, res) => res.json({ user: req.user && req.user.username, token: req.token || null, authed: req.isAuthenticated() });
    app.get('/mcp', tokenAuth(db, { purposes: ['mcp'] }), show);
    app.get('/mcp-or-session', tokenAuth(db, { purposes: ['mcp'], allowSession: true }), show);
  });

  it('a token of the right purpose acts as its user, by header or by cookie', async () => {
    const token = await mcp(5);
    const byHeader = await request(app).get('/mcp').set('Authorization', `Bearer ${token}`);
    expect(byHeader.status).toBe(200);
    expect(byHeader.body).toMatchObject({ user: 'fred', authed: true, token: { purpose: 'mcp', userId: 5 } });
    const byCookie = await request(app).get('/mcp').set('Cookie', `${TOKEN_COOKIE}=${token}`);
    expect(byCookie.body.user).toBe('fred');
  });
  it('refuses a token made for something else', async () => {
    const grafana = await issueToken(db, { purpose: 'grafana', org: 'dev', name: 'g', userId: 5 });
    expect((await request(app).get('/mcp').set('Authorization', `Bearer ${grafana}`)).status).toBe(401);
  });
  it('refuses no token, unless the route lets a session through', async () => {
    expect((await request(app).get('/mcp')).status).toBe(401);
    expect((await request(app).get('/mcp-or-session')).status).toBe(401);
    session = { username: 'jo' };
    expect((await request(app).get('/mcp')).status).toBe(401);
    const s = await request(app).get('/mcp-or-session');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ user: 'jo', token: null });
  });
  it('a bad token is refused even alongside a session, rather than falling back to it', async () => {
    session = { username: 'jo' };
    expect((await request(app).get('/mcp-or-session').set('Authorization', 'Bearer fiot_nope')).status).toBe(401);
  });
  it('a good token decides who it is, whoever is logged in', async () => {
    session = { username: 'jo' };
    const token = await mcp(5);
    expect((await request(app).get('/mcp-or-session').set('Authorization', `Bearer ${token}`)).body.user).toBe('fred');
  });
});

describe('/tokens routes', () => {
  let app, user;
  beforeEach(() => {
    user = { id: 5, username: 'fred', permissions: [{ capability: 'MCP', org: 'dev', project: '' }, { capability: 'READ', org: 'dev', project: '' }] };
    app = express();
    app.use((req, res, next) => { req.user = user; next(); });
    app.use('/tokens', createTokenRouter(db, { loggedInOrFail: (req, res, next) => (user ? next() : res.sendStatus(401)) }));
  });

  it('makes, lists and revokes your own', async () => {
    const made = await request(app).post('/tokens/mcp').send({ name: 'laptop' });
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.body).toMatchObject({ purpose: 'mcp', name: 'laptop' });
    expect((await tokenOwner(db, made.body.token)).userId).toBe(5);
    const listed = await request(app).get('/tokens/mcp');
    expect(listed.body.map((t) => t.name)).toEqual(['laptop']);
    expect(listed.body[0].user_id).toBeUndefined();
    expect(JSON.stringify(listed.body)).not.toContain(made.body.token);
    expect((await request(app).post('/tokens/mcp/revoke').send({ name: 'laptop' })).body).toEqual({ revoked: true });
    expect(await tokenOwner(db, made.body.token)).toBeUndefined();
  });
  it('lists and revokes only your own', async () => {
    await mcp(6, 'laptop');
    expect((await request(app).get('/tokens/mcp')).body).toEqual([]);
    expect((await request(app).post('/tokens/mcp/revoke').send({ name: 'laptop' })).status).toBe(404);
    expect(await listTokens(db, { purpose: 'mcp', userId: 6 })).toHaveLength(1);
  });
  it('needs MCP on some organization to make one', async () => {
    user = { id: 5, username: 'fred', permissions: [{ capability: 'READ', org: 'dev', project: '' }] };
    expect((await request(app).post('/tokens/mcp').send({ name: 'laptop' })).status).toBe(403);
  });
  it('needs a login', async () => {
    user = undefined;
    expect((await request(app).get('/tokens/mcp')).status).toBe(401);
    expect((await request(app).post('/tokens/mcp').send({ name: 'x' })).status).toBe(401);
  });
  it('makes only the kinds a user makes for themselves', async () => {
    expect((await request(app).post('/tokens/grafana').send({ name: 'x' })).status).toBe(404);
    expect((await request(app).post('/tokens/platform').send({ name: 'x' })).status).toBe(404);
    expect((await request(app).get('/tokens/grafana')).status).toBe(404);
  });
  it('refuses a form post, which another site could send with your session, and a bad name', async () => {
    expect((await request(app).post('/tokens/mcp').type('form').send('name=x')).status).toBe(415);
    expect((await request(app).post('/tokens/mcp/revoke').type('form').send('name=x')).status).toBe(415);
    expect((await request(app).post('/tokens/mcp').send({ name: '../x' })).status).toBe(400);
    expect((await request(app).post('/tokens/mcp').send({})).status).toBe(400);
  });
});

describe('moving Grafana\'s tokens out of grafana_tokens', () => {
  // The table as the last release had it, before api_tokens replaced it
  const OLD = `CREATE TABLE grafana_tokens (org TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used INTEGER, user_id INTEGER, UNIQUE(org, name));`;
  const migrate = () => new Promise((res, rej) => migrateTokens(db, (e) => (e ? rej(e) : res())));
  const tables = async () => (await rows("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);

  it('moves those with a user, leaves those without, and drops the table', async () => {
    await exec(OLD);
    await exec("INSERT INTO grafana_tokens VALUES ('dev', 'home', ?, 10, 20, 5)", [hashToken('fiot_home')]);
    await exec("INSERT INTO grafana_tokens VALUES ('dev', 'old', ?, 10, NULL, NULL)", [hashToken('fiot_old')]);
    await migrate();
    expect(await tokenOwner(db, 'fiot_home')).toEqual({ purpose: 'grafana', org: 'dev', name: 'home', userId: 5 });
    expect(await tokenOwner(db, 'fiot_old')).toBeUndefined();
    expect(await tables()).not.toContain('grafana_tokens');
  });
  it('a token revoked after the move stays revoked on the next start', async () => {
    await exec(OLD);
    await exec("INSERT INTO grafana_tokens VALUES ('dev', 'home', ?, 10, NULL, 5)", [hashToken('fiot_home')]);
    await migrate();
    await revokeToken(db, { purpose: 'grafana', org: 'dev', name: 'home' });
    await exec(SCHEMA); // as every startup does
    await migrate();
    expect(await tokenOwner(db, 'fiot_home')).toBeUndefined();
  });
  it('works on a table from before user_id, once addMissingColumns has added it', async () => {
    await exec('CREATE TABLE grafana_tokens (org TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, UNIQUE(org, name))');
    await exec("INSERT INTO grafana_tokens VALUES ('dev', 'ancient', ?, 10, NULL)", [hashToken('fiot_a')]);
    await new Promise((res, rej) => addMissingColumns(db, (e) => (e ? rej(e) : res())));
    await migrate();
    expect(await tokenOwner(db, 'fiot_a')).toBeUndefined();
    expect(await tables()).not.toContain('grafana_tokens');
  });
  it('does nothing when there is no old table', async () => {
    await migrate();
    expect(await tables()).toContain('api_tokens');
  });
});
