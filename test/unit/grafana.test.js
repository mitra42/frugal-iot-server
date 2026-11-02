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
  createGrafanaRouters, issueToken, tokenOwner, revokeToken, listTokens,
  validTopic, downsample, parseTime, loadTopicData, listTopics,
} from '../../lib/grafana.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');
const T = 'dev/lotus/n1/sht/temperature';
const DAY = Date.parse('2026-09-24T00:00:00Z');

let db, dir, app, user;

const open = () => new Promise((res) => { const d = new Database(':memory:'); d.exec(SCHEMA, () => res(d)); });
const put = (topic, file, text, gz = false) => {
  const d = join(dir, ...topic.split('/'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), gz ? gzipSync(text) : text);
};

beforeEach(async () => {
  db = await open();
  dir = mkdtempSync(join(tmpdir(), 'grafana-test-'));
  user = { username: 'admin', permissions: [{ capability: 'ADMIN', org: 'dev' }] };
  const auth = {
    loggedInOrFail: (req, res, next) => (user ? next() : res.sendStatus(401)),
    can_ADMIN: (req, res, next) =>
      (user && user.permissions.some((p) => p.capability === 'ADMIN' && p.org === req.params.org) ? next() : res.sendStatus(401)),
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
    const token = await issueToken(db, 'dev', 'home');
    expect(token).toMatch(/^fiot_/);
    expect(await tokenOwner(db, token)).toEqual({ org: 'dev', name: 'home' });
    const rows = await new Promise((r) => db.all('SELECT * FROM grafana_tokens', (e, x) => r(x)));
    expect(JSON.stringify(rows)).not.toContain(token);
  });
  it('an unknown or empty token is nobody', async () => {
    expect(await tokenOwner(db, 'fiot_nope')).toBeUndefined();
    expect(await tokenOwner(db, '')).toBeUndefined();
  });
  it('issuing a name again replaces its token', async () => {
    const first = await issueToken(db, 'dev', 'home');
    const second = await issueToken(db, 'dev', 'home');
    expect(await tokenOwner(db, first)).toBeUndefined();
    expect(await tokenOwner(db, second)).toBeTruthy();
    expect(await listTokens(db, 'dev')).toHaveLength(1);
  });
  it('a revoked token stops working', async () => {
    const token = await issueToken(db, 'dev', 'home');
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

describe('listTopics', () => {
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
    token = await issueToken(db, 'dev', 'home');
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
  it('is for administrators of that organization only', async () => {
    expect((await request(app).post('/grafana_token/winam').send({ name: 'x' })).status).toBe(401);
    user = null;
    expect((await request(app).post('/grafana_token/dev').send({ name: 'x' })).status).toBe(401);
  });
  it('refuses an odd name', async () => {
    expect((await request(app).post('/grafana_token/dev').send({ name: '../x' })).status).toBe(400);
    expect((await request(app).post('/grafana_token/dev').send({})).status).toBe(400);
  });
});
