/*
 * History for Grafana: the token, the topic check that keeps a request inside data/, and what
 * comes back for a time range. The routes run against a real in-memory database and a temporary
 * data directory, with a stand-in for the login that protects the token-issuing routes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'sqlite3';
import request from 'supertest';
import express from 'express';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import {
  createGrafanaRouters, issueToken, MAX_TOKENS_PER_USER, tokenOwner, revokeToken, listTokens,
  validTopic, downsample, hashToken, parseTime, loadTopicData, loadTopicSeries, listTopics, clearTopicCache,
} from '../../lib/grafana.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');
const T = 'dev/lotus/n1/sht/temperature';
const DAY = Date.parse('2026-09-24T00:00:00Z');

let db, dir, app, user;

const open = () => new Promise((res) => { const d = new Database(':memory:'); d.exec(SCHEMA, () => res(d)); });
const exec = (sql, args = []) => new Promise((res, rej) => db.run(sql, args, (e) => (e ? rej(e) : res())));
// Permissions as the database holds them, which is what a token is checked against
const grant = (id, capability, org, project = '') =>
  exec('INSERT OR IGNORE INTO permissions (id, capability, org, project) VALUES (?, ?, ?, ?)', [id, capability, org, project]);
// A token for a user who can READ the organization, as the people who make them can
const issue = async (org, name, uid = 1) => { await grant(uid, 'READ', org); return issueToken(db, org, name, uid); };
const put = (topic, file, text, gz = false) => {
  const d = join(dir, ...topic.split('/'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), gz ? gzipSync(text) : text);
};

beforeEach(async () => {
  db = await open();
  dir = mkdtempSync(join(tmpdir(), 'grafana-test-'));
  user = { id: 1, username: 'admin', permissions: [{ capability: 'ADMIN', org: 'dev', project: '' }, { capability: 'READ', org: 'dev', project: '' }] };
  const auth = {
    loggedInOrFail: (req, res, next) => (user ? next() : res.sendStatus(401)),
    can_READ: (req, res, next) =>
      (user && user.permissions.some((p) => p.capability === 'READ' && p.org === req.params.org) ? next() : res.sendStatus(401)),
  };
  const routers = createGrafanaRouters(db, dir, { flush: async () => {} }, auth);
  app = express();
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/grafana', routers.data);
  app.use('/grafana_token', routers.admin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tokens', () => {
  it('a token identifies its organization, and only the hash is stored', async () => {
    const token = await issue('dev', 'home');
    expect(token).toMatch(/^fiot_/);
    expect(await tokenOwner(db, token)).toEqual({ org: 'dev', name: 'home', userId: 1 });
    const rows = await new Promise((r) => db.all('SELECT * FROM grafana_tokens', (e, x) => r(x)));
    expect(JSON.stringify(rows)).not.toContain(token);
  });
  it('an unknown or empty token is nobody', async () => {
    expect(await tokenOwner(db, 'fiot_nope')).toBeUndefined();
    expect(await tokenOwner(db, '')).toBeUndefined();
  });
  it('issuing a name again replaces its token', async () => {
    const first = await issue('dev', 'home');
    const second = await issue('dev', 'home');
    expect(await tokenOwner(db, first)).toBeUndefined();
    expect(await tokenOwner(db, second)).toBeTruthy();
    expect(await listTokens(db, 'dev')).toHaveLength(1);
  });
  it('a revoked token stops working', async () => {
    const token = await issue('dev', 'home');
    expect(await revokeToken(db, 'dev', 'home')).toBe(true);
    expect(await tokenOwner(db, token)).toBeUndefined();
    expect(await revokeToken(db, 'dev', 'home')).toBe(false);
  });
});

describe('validTopic', () => {
  it('accepts org/project/node/module/leaf for that org only', () => {
    expect(validTopic(T, 'dev')).toBe(true);
    expect(validTopic(T, 'winam')).toBe(false);
  });
  it('refuses anything that could leave the data directory', () => {
    for (const bad of ['dev/../../etc/passwd/x/y', 'dev/lotus/n1/sht/..', 'dev//n1/sht/t', 'dev/lotus/n1/sht/a b',
      'dev/lotus/n1/sht', undefined, 42, 'dev/lotus/n1/sht/t\\x']) {
      expect(validTopic(bad, 'dev')).toBe(false);
    }
  });
});

describe('parseTime', () => {
  it('takes milliseconds, seconds or an ISO date', () => {
    expect(parseTime('1790459181430')).toBe(1790459181430);
    expect(parseTime('1790459181')).toBe(1790459181000);
    expect(parseTime('2026-09-24T00:00:00Z')).toBe(DAY);
    expect(parseTime('nonsense')).toBeUndefined();
    expect(parseTime(undefined)).toBeUndefined();
  });
});

describe('loadTopicData', () => {
  it('reads plain and compressed days, in order, within the range', async () => {
    put(T, '2026-09-23.csv.gz', `${DAY - 1000},"1"\n`, true);
    put(T, '2026-09-24.csv', `${DAY + 2000},"3"\n${DAY + 1000},"2.5"\n`);
    put(T, '2026-09-25.csv', `${DAY + 86400000},"9"\n`);
    const rows = await loadTopicData(T, dir, DAY - 5000, DAY + 5000);
    expect(rows).toEqual([{ t: DAY - 1000, value: 1 }, { t: DAY + 1000, value: 2.5 }, { t: DAY + 2000, value: 3 }]);
  });
  it('leaves out readings that are not numbers, and a topic with nothing is empty', async () => {
    put(T, '2026-09-24.csv', `${DAY},"hello"\n${DAY + 1},""\n${DAY + 2},"0"\n`);
    expect(await loadTopicData(T, dir, DAY, DAY + 10)).toEqual([{ t: DAY + 2, value: 0 }]);
    expect(await loadTopicData('dev/lotus/n9/sht/x', dir, DAY, DAY + 10)).toEqual([]);
  });
});

describe('downsample', () => {
  it('leaves a small series alone', () => {
    const rows = [{ t: 0, value: 1 }, { t: 1, value: 2 }];
    expect(downsample(rows, 0, 10, 5)).toBe(rows);
  });
  it('averages a long one into buckets', () => {
    const rows = [0, 1, 2, 3].map((t) => ({ t, value: t * 10 }));
    expect(downsample(rows, 0, 3, 2)).toEqual([{ t: 0, value: 5 }, { t: 2, value: 25 }]);
  });
});

describe('loadTopicSeries', () => {
  it('is the readings as they are when there are few', async () => {
    put(T, '2026-09-24.csv', `${DAY + 2000},"3"\n${DAY + 1000},"2"\n`);
    expect(await loadTopicSeries(T, dir, DAY, DAY + 5000, 100)).toEqual([{ t: DAY + 1000, value: 2 }, { t: DAY + 2000, value: 3 }]);
  });
  it('gives the same answer as loading everything and then averaging, when there are far too many to hold', async () => {
    // Past the point where it stops keeping readings and averages as it reads
    const lines = Array.from({ length: 30000 }, (_, i) => `${DAY + i * 2000},"${(i * 7) % 100}"`).join('\n');
    put(T, '2026-09-24.csv', lines + '\n');
    const to = DAY + 86399000;
    const whole = downsample(await loadTopicData(T, dir, DAY, to), DAY, to, 200);
    const streamed = await loadTopicSeries(T, dir, DAY, to, 200);
    expect(streamed.length).toBe(whole.length);
    streamed.forEach((r, i) => {
      expect(r.t).toBe(whole[i].t);
      expect(r.value).toBeCloseTo(whole[i].value, 9);
    });
    expect(streamed.length).toBeLessThanOrEqual(200);
  });
});

describe('listTopics', () => {
  it('is cached for a minute, so a big organization is not walked on every request', async () => {
    clearTopicCache();
    put(T, '2026-09-24.csv', '');
    expect(await listTopics('dev', dir)).toHaveLength(1);
    put('dev/lotus/n1/sht/humidity', '2026-09-24.csv', '');
    expect(await listTopics('dev', dir)).toHaveLength(1);   // still the cached answer
    clearTopicCache();
    expect(await listTopics('dev', dir)).toHaveLength(2);
  });
  it('finds each directory that holds day files', async () => {
    put(T, '2026-09-24.csv', '');
    put('dev/lotus/n1/relay/on/value', '2026-09-24.csv.gz', '', true);
    put('winam/p/n/m/l', '2026-09-24.csv', '');
    const topics = (await listTopics('dev', dir)).map((t) => t.topic).sort();
    expect(topics).toEqual(['dev/lotus/n1/relay/on/value', T]);
    expect((await listTopics('dev', dir))[0]).toMatchObject({ project: 'lotus', node: 'n1' });
  });
  it('cannot be pointed outside the data directory', async () => {
    expect(await listTopics('../..', dir)).toEqual([]);
  });
});

describe('GET /grafana/:org/data', () => {
  let token;
  beforeEach(async () => {
    token = await issue('dev', 'home');
    put(T, '2026-09-24.csv', `${DAY + 1000},"22.5"\n${DAY + 2000},"23"\n`);
  });
  const get = (path, tok = token) => request(app).get(path).set('Authorization', `Bearer ${tok}`);

  it('returns time and value for the range', async () => {
    const res = await get(`/grafana/dev/data?topic=${T}&from=${DAY}&to=${DAY + 5000}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { time: '2026-09-24T00:00:01.000Z', value: 22.5 },
      { time: '2026-09-24T00:00:02.000Z', value: 23 },
    ]);
  });
  it('wants a token', async () => {
    expect((await request(app).get(`/grafana/dev/data?topic=${T}`)).status).toBe(403);
    expect((await get(`/grafana/dev/data?topic=${T}`, 'fiot_wrong')).status).toBe(403);
  });
  it("a token for one organization cannot read another's", async () => {
    put('winam/p/n/m/l', '2026-09-24.csv', `${DAY},"1"\n`);
    expect((await get(`/grafana/winam/data?topic=winam/p/n/m/l&from=${DAY}&to=${DAY + 5}`)).status).toBe(403);
  });
  it("cannot ask for another organization's topic through its own url", async () => {
    expect((await get(`/grafana/dev/data?topic=winam/p/n/m/l`)).status).toBe(400);
  });
  it('refuses a path that climbs out', async () => {
    expect((await get(`/grafana/dev/data?topic=dev/lotus/n1/sht/..`)).status).toBe(400);
  });
  it('rejects times it cannot read, and a backwards range', async () => {
    expect((await get(`/grafana/dev/data?topic=${T}&from=banana`)).status).toBe(400);
    expect((await get(`/grafana/dev/data?topic=${T}&from=${DAY + 9}&to=${DAY}`)).status).toBe(400);
  });
  it('respects maxPoints', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${DAY + i * 1000},"${i}"`).join('\n');
    put(T, '2026-09-24.csv', lines + '\n');
    const res = await get(`/grafana/dev/data?topic=${T}&from=${DAY}&to=${DAY + 100000}&maxPoints=10`);
    expect(res.body.length).toBeLessThanOrEqual(10);
  });
  it('health and topics work with the token too', async () => {
    expect((await get('/grafana/dev/health')).body).toEqual({ status: 'ok' });
    expect((await get('/grafana/dev/topics')).body.map((t) => t.topic)).toEqual([T]);
    expect((await get('/grafana/dev/topics?node=other')).body).toEqual([]);
  });
});

describe('too many readings at once', () => {
  it('says busy, with when to retry, once four are being read across all organizations', async () => {
    const orgs = ['a', 'b', 'c', 'd', 'e'];
    const tokens = {};
    for (const o of orgs) {
      tokens[o] = await issue(o, 'home');
      put(`${o}/p/n/m/l`, '2026-09-24.csv', `${DAY + 1000},"22.5"\n`);
    }
    let release;
    const gate = new Promise((r) => { release = r; });
    const auth = { loggedInOrFail: (q, s, n) => n(), can_READ: (q, s, n) => n() };
    const slow = express();
    slow.use('/grafana', createGrafanaRouters(db, dir, { flush: () => gate }, auth).data);
    const ask = (o) => request(slow).get(`/grafana/${o}/data?topic=${o}/p/n/m/l&from=${DAY}&to=${DAY + 5000}`).set('Authorization', `Bearer ${tokens[o]}`);
    const inFlight = ['a', 'b', 'c', 'd'].map((o) => ask(o).then((r) => r));
    await new Promise((r) => setTimeout(r, 100)); // let all four reach the gate
    const fifth = await ask('e');
    expect(fifth.status).toBe(503);
    expect(fifth.headers['retry-after']).toBe('5');
    release();
    for (const r of await Promise.all(inFlight)) expect(r.status).toBe(200);
    expect((await ask('e')).status).toBe(200); // and it recovers
  });
});

describe('the starter dashboard', () => {
  it('has this server and organization as its defaults, and is its own dashboard per organization', async () => {
    const res = await request(app).get('/grafana_token/dev/dashboard?server=https://iot.example.org/some/path');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="frugaliot-dev-dashboard.json"/);
    const byName = Object.fromEntries(res.body.__inputs.map((i) => [i.name, i.value]));
    expect(byName.VAR_SERVER).toBe('https://iot.example.org'); // an origin, not a path
    expect(byName.VAR_ORG).toBe('dev');
    expect(res.body.uid).toBe('frugaliot-readings-dev');
    expect(res.body.templating.list.some((v) => v.name === 'topic' && v.type === 'query')).toBe(true);
  });
  it('wants an http(s) server address', async () => {
    for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'nonsense']) {
      expect((await request(app).get(`/grafana_token/dev/dashboard?server=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });
  it('is for people who can READ that organization only', async () => {
    expect((await request(app).get('/grafana_token/winam/dashboard?server=https://x.org')).status).toBe(401);
  });
});

describe('limits', () => {
  it('an organization can hold only so many tokens, even when they are asked for together', async () => {
    const results = await Promise.all(Array.from({ length: MAX_TOKENS_PER_USER + 5 }, (_, i) =>
      issue('dev', `t${i}`).then(() => 'ok', () => 'refused')));
    expect(results.filter((r) => r === 'ok')).toHaveLength(MAX_TOKENS_PER_USER);
    expect(await listTokens(db, 'dev')).toHaveLength(MAX_TOKENS_PER_USER);
  });
  it('replacing a token it already has is always allowed', async () => {
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) await issue('dev', `t${i}`);
    await expect(issue('dev', 't3')).resolves.toMatch(/^fiot_/);
    await expect(issue('dev', 'one-more')).rejects.toThrow(/up to 10 tokens/);
  });
  it('says so over HTTP, and the reply that carries a token is not to be cached', async () => {
    const ok = await request(app).post('/grafana_token/dev').send({ name: 'first' });
    expect(ok.headers['cache-control']).toBe('no-store');
    for (let i = 0; i < MAX_TOKENS_PER_USER - 1; i++) await issue('dev', `t${i}`);
    const res = await request(app).post('/grafana_token/dev').send({ name: 'too many' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/up to 10 tokens/);
  });
  it("one organization's reads cannot use up everyone's", async () => {
    const devToken = await issue('dev', 'home');
    const winamToken = await issue('winam', 'home');
    put(T, '2026-09-24.csv', `${DAY + 1000},"22.5"\n`);
    put('winam/p/n/m/l', '2026-09-24.csv', `${DAY + 1000},"1"\n`);
    let release;
    const gate = new Promise((r) => { release = r; });
    const auth = { loggedInOrFail: (q, s, n) => n(), can_READ: (q, s, n) => n() };
    const slow = express();
    slow.use('/grafana', createGrafanaRouters(db, dir, { flush: () => gate }, auth).data);
    const ask = (org, tok, topic) => request(slow).get(`/grafana/${org}/data?topic=${topic}&from=${DAY}&to=${DAY + 5000}`).set('Authorization', `Bearer ${tok}`);
    const held = [ask('dev', devToken, T).then((r) => r), ask('dev', devToken, T).then((r) => r)];
    await new Promise((r) => setTimeout(r, 100));
    expect((await ask('dev', devToken, T)).status).toBe(503);                        // dev is at its own limit...
    const other = ask('winam', winamToken, 'winam/p/n/m/l').then((r) => r);          // ...and winam is not told to wait
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect((await other).status).toBe(200);
    for (const r of await Promise.all(held)) expect(r.status).toBe(200);
  });
});

describe('who may issue tokens', () => {
  it('refuses a form post, which another site could send with an administrator\'s session', async () => {
    expect((await request(app).post('/grafana_token/dev').type('form').send('name=x')).status).toBe(415);
    expect((await request(app).post('/grafana_token/dev/revoke').type('form').send('name=x')).status).toBe(415);
    expect(await listTokens(db, 'dev')).toEqual([]);
  });
  it('wants READ on the organization, and nothing else', async () => {
    user = { id: 5, username: 'nobody', permissions: [{ capability: 'READ', org: 'winam', project: '' }] };
    expect((await request(app).post('/grafana_token/dev').send({ name: 'x' })).status).toBe(401);
    expect((await request(app).get('/grafana_token/dev')).status).toBe(401);
    expect((await request(app).get('/grafana_token/dev/dashboard?server=https://x.org')).status).toBe(401);
    expect(await listTokens(db, 'dev')).toEqual([]);
  });
});

describe('a token acts as the user who made it', () => {
  const asLotusReader = () => {
    user = { id: 2, username: 'reader', permissions: [{ capability: 'READ', org: 'dev', project: 'lotus' }] };
  };
  beforeEach(() => {
    put(T, '2026-09-24.csv', `${DAY + 1000},"22.5"\n`);
    put('dev/other/n1/sht/temperature', '2026-09-24.csv', `${DAY + 1000},"9"\n`);
  });
  const get = (path, tok) => request(app).get(path).set('Authorization', `Bearer ${tok}`);

  it('sees only the projects its user may READ', async () => {
    await grant(2, 'READ', 'dev', 'lotus');
    const token = await issueToken(db, 'dev', 'mine', 2);
    expect((await get('/grafana/dev/topics', token)).body.map((t) => t.topic)).toEqual([T]);
    expect((await get(`/grafana/dev/data?topic=${T}&from=${DAY}&to=${DAY + 5000}`, token)).status).toBe(200);
    expect((await get(`/grafana/dev/data?topic=dev/other/n1/sht/temperature&from=${DAY}&to=${DAY + 5000}`, token)).status).toBe(403);
  });
  it('sees every project when its user may READ the whole organization', async () => {
    const token = await issue('dev', 'all');
    expect((await get('/grafana/dev/topics', token)).body).toHaveLength(2);
  });
  it('stops working the moment its user loses READ, and works again if they get it back', async () => {
    const token = await issue('dev', 'home');
    expect((await get('/grafana/dev/health', token)).status).toBe(200);
    await exec('DELETE FROM permissions WHERE id = 1');
    expect((await get('/grafana/dev/health', token)).status).toBe(403);
    await grant(1, 'READ', 'dev');
    expect((await get('/grafana/dev/health', token)).status).toBe(200);
  });
  it('narrows when its user is narrowed', async () => {
    const token = await issue('dev', 'home');
    expect((await get('/grafana/dev/topics', token)).body).toHaveLength(2);
    await exec('DELETE FROM permissions WHERE id = 1');
    await grant(1, 'READ', 'dev', 'lotus');
    expect((await get('/grafana/dev/topics', token)).body.map((t) => t.topic)).toEqual([T]);
  });
  it('is not honoured when it has no user at all', async () => {
    await exec("INSERT INTO grafana_tokens (org, name, token_hash, created_at) VALUES ('dev', 'old', ?, 1)", [hashToken('fiot_old')]);
    expect((await get('/grafana/dev/health', 'fiot_old')).status).toBe(403);
  });
  it('is only for the organization it was made in, whatever else its user may READ', async () => {
    await grant(1, 'READ', 'winam');
    const token = await issue('dev', 'home');
    expect((await get('/grafana/winam/health', token)).status).toBe(403);
  });
  it('can be made by someone who can READ but not administer, and lists only their own', async () => {
    asLotusReader();
    const made = await request(app).post('/grafana_token/dev').send({ name: 'mine' });
    expect(made.status).toBe(201);
    await issue('dev', 'admins', 1);
    expect((await request(app).get('/grafana_token/dev')).body.map((t) => t.name)).toEqual(['mine']);
    user = { id: 1, username: 'admin', permissions: [{ capability: 'ADMIN', org: 'dev', project: '' }, { capability: 'READ', org: 'dev', project: '' }] };
    const all = (await request(app).get('/grafana_token/dev')).body;
    expect(all.map((t) => [t.name, t.mine])).toEqual([['admins', true], ['mine', false]]);
  });
  it("one user cannot revoke or replace another's, but an organization-wide administrator can revoke", async () => {
    await issue('dev', 'admins', 1);
    asLotusReader();
    expect((await request(app).post('/grafana_token/dev/revoke').send({ name: 'admins' })).status).toBe(404);
    expect((await request(app).post('/grafana_token/dev').send({ name: 'admins' })).status).toBe(400);
    const theirs = await request(app).post('/grafana_token/dev').send({ name: 'theirs' });
    expect(theirs.status).toBe(201);
    user = { id: 1, username: 'admin', permissions: [{ capability: 'ADMIN', org: 'dev', project: '' }, { capability: 'READ', org: 'dev', project: '' }] };
    expect((await request(app).post('/grafana_token/dev/revoke').send({ name: 'theirs' })).body).toEqual({ revoked: true });
    expect((await get('/grafana/dev/health', theirs.body.token)).status).toBe(403);
  });
  it("an administrator of one project is not an organization administrator, so cannot revoke others'", async () => {
    await issue('dev', 'admins', 1);
    user = { id: 3, username: 'padmin', permissions: [{ capability: 'ADMIN', org: 'dev', project: 'lotus' }, { capability: 'READ', org: 'dev', project: 'lotus' }] };
    expect((await request(app).post('/grafana_token/dev/revoke').send({ name: 'admins' })).status).toBe(404);
  });
});

describe('issuing tokens over HTTP', () => {
  it('an administrator gets the token once, and can list and revoke it', async () => {
    const made = await request(app).post('/grafana_token/dev').send({ name: 'home' });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^fiot_/);
    const list = await request(app).get('/grafana_token/dev');
    expect(list.body.map((t) => t.name)).toEqual(['home']);
    expect(JSON.stringify(list.body)).not.toContain(made.body.token);
    expect((await request(app).post('/grafana_token/dev/revoke').send({ name: 'home' })).body).toEqual({ revoked: true });
    expect((await request(app).get(`/grafana/dev/health`).set('Authorization', `Bearer ${made.body.token}`)).status).toBe(403);
  });
  it('is for people who can READ that organization only', async () => {
    expect((await request(app).post('/grafana_token/winam').send({ name: 'x' })).status).toBe(401);
    user = null;
    expect((await request(app).post('/grafana_token/dev').send({ name: 'x' })).status).toBe(401);
  });
  it('refuses an odd name', async () => {
    expect((await request(app).post('/grafana_token/dev').send({ name: '../x' })).status).toBe(400);
    expect((await request(app).post('/grafana_token/dev').send({})).status).toBe(400);
  });
});
