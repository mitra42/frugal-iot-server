/*
 * Sharing production's logins with a bridged Pi (S11).
 *
 * The interesting behaviour is not "the rows arrive" but what happens to what was already there:
 * a local account of the same name must not be overwritten, and a permission that stops being sent
 * has to stop existing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'sqlite3';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { replicaFor, applyReplica, bridgeForToken, newBridgeToken,
         REPLICA_ID_OFFSET, isReplicatedId } from '../../lib/replica.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');

let prod, pi;
const open = () => new Promise((res) => {
  const db = new Database(':memory:');
  db.exec(SCHEMA, () => res(db));
});
const run = (db, sql, args = []) => new Promise((res, rej) =>
  db.run(sql, args, (e) => (e ? rej(e) : res())));
const all = (db, sql, args = []) => new Promise((res, rej) =>
  db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));
const replica = (db, org) => new Promise((res, rej) =>
  replicaFor(db, org, (e, p) => (e ? rej(e) : res(p))));
const apply = (db, org, payload) => new Promise((res) =>
  applyReplica(db, org, payload, (err, result) => res({ err, result })));

// A real login, so the Pi's own pbkdf2 comparison can be tested against a replicated hash
const HASH = crypto.pbkdf2Sync('correct horse', 'saltysalt', 310000, 32, 'sha256');

beforeEach(async () => {
  prod = await open();
  pi = await open();
  await run(prod, `INSERT INTO users (id, username, hashed_password, salt, name) VALUES
    (2, 'alice', ?, ?, 'Alice'), (3, 'bob', ?, ?, 'Bob')`,
    [HASH, Buffer.from('saltysalt'), HASH, Buffer.from('saltysalt')]);
  await run(prod, `INSERT INTO permissions (id, capability, org, project) VALUES
    (2, 'READ', 'myfarm', ''), (2, 'WRITE', 'myfarm', ''), (3, 'READ', 'myfarm', 'lotus'),
    (3, 'READ', 'other', ''), (0, 'READ', 'myfarm', 'public')`);
});

describe('what production sends', () => {
  it('only the people who have a permission in that organization', async () => {
    const p = await replica(prod, 'other');
    expect(p.users.map((u) => u.username)).toEqual(['bob']);   // and not alice
  });

  it('includes the id-0 "everyone" rows', async () => {
    // The Pi reads permissions as "id = ? or id = 0", so without these it would disagree with
    // production about what is public
    const p = await replica(prod, 'myfarm');
    expect(p.permissions.filter((x) => x.id === 0)).toHaveLength(1);
  });

  it('carries the hash and salt in a form JSON survives', async () => {
    const p = await replica(prod, 'myfarm');
    const round = JSON.parse(JSON.stringify(p));
    const back = Buffer.from(round.users.find((u) => u.username === 'alice').hashed_password, 'base64');
    expect(back.equals(HASH)).toBe(true);
  });

  it('sends nothing that could be mistaken for a password', async () => {
    const p = await replica(prod, 'myfarm');
    expect(JSON.stringify(p)).not.toContain('correct horse');
    for (const u of p.users) expect(Object.keys(u)).not.toContain('password');
  });
});

describe('what the Pi does with it', () => {
  it('a replicated login can be verified locally, against the replicated hash', async () => {
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    const [alice] = await all(pi, 'SELECT * FROM users WHERE username = ?', ['alice']);
    // Exactly the comparison frugal-iot-server.js's LocalStrategy makes
    const hashed = crypto.pbkdf2Sync('correct horse', alice.salt, 310000, 32, 'sha256');
    expect(crypto.timingSafeEqual(alice.hashed_password, hashed)).toBe(true);
  });

  it('keeps replicated ids clear of locally created ones', async () => {
    // addorganization creates a login on the Pi too, and both machines allocate from 2 upwards
    await run(pi, "INSERT INTO users (username, name) VALUES ('myfarm', 'Local org login')");
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    const rows = await all(pi, 'SELECT id, username FROM users WHERE username IN (?,?)', ['myfarm', 'alice']);
    const local = rows.find((r) => r.username === 'myfarm');
    const replicated = rows.find((r) => r.username === 'alice');
    expect(isReplicatedId(local.id)).toBe(false);
    expect(replicated.id).toBe(REPLICA_ID_OFFSET + 2);
  });

  it('will not take a name a local account already has', async () => {
    // Overwriting it would silently change who can log in as that person
    await run(pi, "INSERT INTO users (username, name) VALUES ('alice', 'Local Alice')");
    const { result } = await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    expect(result.skipped).toEqual(['alice']);
    const [row] = await all(pi, 'SELECT id, name FROM users WHERE username = ?', ['alice']);
    expect(row.name).toBe('Local Alice');
    expect(isReplicatedId(row.id)).toBe(false);
  });

  it('a revoked permission stops existing on the next pull', async () => {
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    expect(await all(pi, "SELECT * FROM permissions WHERE capability = 'WRITE'")).toHaveLength(1);
    await run(prod, "DELETE FROM permissions WHERE id = 2 AND capability = 'WRITE'");
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    expect(await all(pi, "SELECT * FROM permissions WHERE capability = 'WRITE'")).toHaveLength(0);
  });

  it('a user removed from production stops being anybody here', async () => {
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    await run(prod, 'DELETE FROM permissions WHERE id = 2');
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    expect(await all(pi, 'SELECT * FROM users WHERE username = ?', ['alice'])).toHaveLength(0);
  });

  it('leaves local permissions alone', async () => {
    await run(pi, "INSERT INTO permissions (id, capability, org, project) VALUES (2, 'ADMIN', 'myfarm', '')");
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    const local = await all(pi, "SELECT * FROM permissions WHERE id = 2 AND capability = 'ADMIN'");
    expect(local).toHaveLength(1);
  });

  it('refuses a feed that grants permissions in another organization', async () => {
    const payload = await replica(prod, 'myfarm');
    payload.permissions.push({ id: 3, capability: 'ADMIN', org: 'somewhere-else', project: '' });
    const { err } = await apply(pi, 'myfarm', payload);
    expect(err).toBeTruthy();
    expect(await all(pi, "SELECT * FROM permissions WHERE org = 'somewhere-else'")).toHaveLength(0);
  });

  it('refuses a feed for the wrong organization', async () => {
    const { err } = await apply(pi, 'myfarm', await replica(prod, 'other'));
    expect(err).toBeTruthy();
  });

  it('does not replicate over id 0, which is local on every machine', async () => {
    await apply(pi, 'myfarm', await replica(prod, 'myfarm'));
    const zero = await all(pi, 'SELECT * FROM permissions WHERE id = 0');
    expect(zero).toHaveLength(1);
    expect(zero[0].project).toBe('public');
  });

  it('is idempotent - pulling twice changes nothing', async () => {
    const payload = await replica(prod, 'myfarm');
    await apply(pi, 'myfarm', payload);
    const first = await all(pi, 'SELECT * FROM permissions ORDER BY id, capability, project');
    await apply(pi, 'myfarm', payload);
    expect(await all(pi, 'SELECT * FROM permissions ORDER BY id, capability, project')).toEqual(first);
  });
});

describe('the bridge token', () => {
  it('identifies one organization and site, and nothing without one', async () => {
    const token = newBridgeToken();
    await run(prod, 'INSERT INTO bridges (org, site, token, created_at) VALUES (?,?,?,?)',
      ['myfarm', 'northfield', token, Date.now()]);
    const found = await new Promise((res) => bridgeForToken(prod, token, (e, b) => res(b)));
    expect(found).toMatchObject({ org: 'myfarm', site: 'northfield' });
    expect(await new Promise((res) => bridgeForToken(prod, 'nope', (e, b) => res(b)))).toBeFalsy();
    expect(await new Promise((res) => bridgeForToken(prod, '', (e, b) => res(b)))).toBeFalsy();
  });
});
