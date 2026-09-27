/*
 * Node enrolment.
 *
 * The property that matters most is the 409: a node id comes from the chip's MAC, so it is public,
 * and if the server re-issued a credential to anyone quoting an existing id then the enrolment
 * secret would amount to "impersonate any node in the organization" - which is the isolation the
 * whole step exists to create.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'sqlite3';
import { readFileSync } from 'fs';
import { enrol, ENROL, enrolmentSecretsFor, makeRateLimiter, forgetNode,
         makeAttemptLog, setGrant, clearGrant, readGrants } from '../../lib/enrol.js';

const SCHEMA = readFileSync('./frugal-iot-createdb.sql', 'utf8');
const SECRET = 'secret-for-myfarm';

let db, synced;
const deps = (over = {}) => ({
  db,
  config: { secrets: { enrolment_myfarm: [SECRET] } },
  limiter: null,
  syncNode: (node, cb) => { synced.push(node); cb(null); },
  ...over,
});
const body = (over = {}) => ({
  org: 'myfarm', project: 'lotus', nodeid: 'esp32-abc', enrolment_secret: SECRET, ...over,
});
const run = (d, b) => new Promise((res) => enrol(d, b, (err, cred) => res({ err, cred })));
const rows = () => new Promise((res, rej) =>
  db.all('SELECT * FROM nodes', [], (e, r) => (e ? rej(e) : res(r))));

beforeEach(() => new Promise((res) => {
  synced = [];
  db = new Database(':memory:');
  // The project has to be registered for enrolment to accept it - a node cannot invent one.
  db.exec(SCHEMA, () => db.run(
    "INSERT INTO projects (org, id, name) VALUES ('myfarm','lotus','Lotus'), ('other','lotus','L2')",
    () => res()));
}));

describe('a node that has never enrolled', () => {
  it('is issued a credential named after its own topic prefix', async () => {
    const { err, cred } = await run(deps(), body());
    expect(err).toBeFalsy();
    expect(cred.username).toBe('myfarm/lotus/esp32-abc');
    expect(cred.password.length).toBeGreaterThanOrEqual(24);
  });

  it('is recorded, so the broker can be rebuilt from the database', async () => {
    const { cred } = await run(deps(), body());
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].password).toBe(cred.password);
    expect(r[0].lora).toBe(0);
  });

  it('gets a different password each time, not a derived one', async () => {
    const a = await run(deps(), body());
    await forgetNode(db, 'myfarm', 'lotus', 'esp32-abc', () => {});
    const b = await run(deps(), body({ nodeid: 'esp32-def' }));
    expect(a.cred.password).not.toBe(b.cred.password);
  });

  it('joins the gateway group only when the build says it can be one', async () => {
    await run(deps(), body({ lora: true }));
    expect(synced[0].lora).toBe(true);
    expect((await rows())[0].lora).toBe(1);
  });
});

describe('a node that is already enrolled', () => {
  it('is refused without proof of its current password', async () => {
    const first = await run(deps(), body());
    const again = await run(deps(), body());
    expect(again.err.code).toBe(ENROL.NEEDS_RESET);
    // and the stored credential is untouched, so the real node keeps working
    expect((await rows())[0].password).toBe(first.cred.password);
  });

  it('is refused with the WRONG current password', async () => {
    await run(deps(), body());
    const again = await run(deps(), body({ current_password: 'not-it' }));
    expect(again.err.code).toBe(ENROL.NEEDS_RESET);
  });

  it('is rotated when it proves it holds the current one', async () => {
    const first = await run(deps(), body());
    const again = await run(deps(), body({ current_password: first.cred.password }));
    expect(again.err).toBeFalsy();
    expect(again.cred.password).not.toBe(first.cred.password);
    expect((await rows())).toHaveLength(1);          // rotated, not duplicated
  });

  it('can enrol afresh once it has been forgotten', async () => {
    await run(deps(), body());
    await new Promise((res) => forgetNode(db, 'myfarm', 'lotus', 'esp32-abc', res));
    const again = await run(deps(), body());
    expect(again.err).toBeFalsy();
  });
});

describe('the project', () => {
  it('is refused if the organization has not registered it', async () => {
    // A name mistyped into a node's captive portal must not create organisation structure
    const { err } = await run(deps(), body({ project: 'lotsu' }));
    expect(err.code).toBe(ENROL.NO_PROJECT);
    expect(err.message).toMatch(/no project/i);
    expect(await rows()).toHaveLength(0);
  });

  it('says what to do about it, naming the project', async () => {
    const { err } = await run(deps(), body({ project: 'lotsu' }));
    expect(err.message).toContain('lotsu');
    expect(err.message).toMatch(/Projects tab/);
  });

  it('is checked before anything is created on the broker', async () => {
    await run(deps(), body({ project: 'lotsu' }));
    expect(synced).toEqual([]);
  });
});

describe('the enrolment secret', () => {
  it('refuses a wrong secret', async () => {
    const { err } = await run(deps(), body({ enrolment_secret: 'wrong' }));
    expect(err.code).toBe(ENROL.REFUSED);
  });

  it('gives the same answer for an unknown organization, so names cannot be probed', async () => {
    const a = await run(deps(), body({ org: 'nosuchorg' }));
    const b = await run(deps(), body({ enrolment_secret: 'wrong' }));
    expect(a.err.code).toBe(b.err.code);
    expect(a.err.message).toBe(b.err.message);
  });

  it('will not let one organization enrol into another', async () => {
    // myfarm's secret, offered for a different organization that has its own
    const d = deps({ config: { secrets: { enrolment_myfarm: [SECRET], enrolment_other: ['other'] } } });
    const { err } = await run(d, body({ org: 'other' }));
    expect(err.code).toBe(ENROL.REFUSED);
  });

  it('accepts any secret in the list, so one can be rotated without stranding nodes', () => {
    const config = { secrets: { enrolment_myfarm: ['new', 'old'] } };
    expect(enrolmentSecretsFor(config, 'myfarm')).toEqual(['new', 'old']);
  });

  it('tolerates a single string as well as a list', () => {
    expect(enrolmentSecretsFor({ secrets: { enrolment_myfarm: 'just-one' } }, 'myfarm'))
      .toEqual(['just-one']);
  });

  it('accepts an older secret still in the list', async () => {
    const d = deps({ config: { secrets: { enrolment_myfarm: ['rotated-in', SECRET] } } });
    const { err } = await run(d, body());
    expect(err).toBeFalsy();
  });
});

describe('when the broker cannot be updated', () => {
  it('refuses rather than issue a credential that would not work', async () => {
    // A node stores what it is given and cannot tell the broker was never told - it would then be
    // unable to connect AND unable to re-enrol, because it has a credential.
    const d = deps({ syncNode: (n, cb) => cb(new Error('broker down')) });
    const { err } = await run(d, body());
    expect(err.code).toBe(ENROL.BROKER);
    expect(await rows()).toHaveLength(0);            // nothing recorded either
  });
});

describe('input checking', () => {
  it.each([
    ['missing org', { org: '' }],
    ['missing project', { project: '' }],
    ['missing nodeid', { nodeid: '' }],
    ['a path in the nodeid', { nodeid: '../etc' }],
    ['an uppercase org', { org: 'MyFarm' }],
    ['a slash in the project', { project: 'a/b' }],
  ])('refuses %s', async (_label, over) => {
    const { err } = await run(deps(), body(over));
    expect(err.code).toBe(ENROL.BAD_REQUEST);
  });

  it('refuses a missing secret, but as a refusal rather than a bad request', async () => {
    // It was BAD_REQUEST until approvals existed (S12). A node flashed with no secret is exactly
    // the one an admin may want to approve, and only a refusal reaches the list they approve from.
    const { err } = await run(deps(), body({ enrolment_secret: '' }));
    expect(err.code).toBe(ENROL.REFUSED);
  });
});

describe('rate limiting', () => {
  it('stops a flood of invented nodes against one organization', () => {
    const limiter = makeRateLimiter({ perOrg: 3, perNode: 99 });
    expect(limiter.allow('myfarm', 'a')).toBe(true);
    expect(limiter.allow('myfarm', 'b')).toBe(true);
    expect(limiter.allow('myfarm', 'c')).toBe(true);
    expect(limiter.allow('myfarm', 'd')).toBe(false);
  });

  it('stops repeated attempts against one real node', () => {
    const limiter = makeRateLimiter({ perOrg: 99, perNode: 2 });
    expect(limiter.allow('myfarm', 'a')).toBe(true);
    expect(limiter.allow('myfarm', 'a')).toBe(true);
    expect(limiter.allow('myfarm', 'a')).toBe(false);
    expect(limiter.allow('myfarm', 'b')).toBe(true);   // a different node is unaffected
  });

  it('does not confine one organization because another is busy', () => {
    const limiter = makeRateLimiter({ perOrg: 2, perNode: 99 });
    limiter.allow('busy', 'a'); limiter.allow('busy', 'b'); 
    expect(limiter.allow('busy', 'c')).toBe(false);
    expect(limiter.allow('quiet', 'a')).toBe(true);
  });

  it('forgets old attempts once the window has passed', () => {
    let t = 1000000;
    const limiter = makeRateLimiter({ perOrg: 1, perNode: 1, windowMs: 1000, now: () => t });
    expect(limiter.allow('myfarm', 'a')).toBe(true);
    expect(limiter.allow('myfarm', 'a')).toBe(false);
    t += 2000;
    expect(limiter.allow('myfarm', 'a')).toBe(true);
  });

  it('is applied by enrol, and a success does not count against the limit', async () => {
    const limiter = makeRateLimiter({ perOrg: 2, perNode: 2 });
    const d = deps({ limiter });
    expect((await run(d, body())).err).toBeFalsy();
    // Without forget() on success, two more attempts would exhaust the per-node allowance
    expect((await run(d, body({ nodeid: 'esp32-two' }))).err).toBeFalsy();
  });
});

/*
 * An admin's decision about one node (S12).
 *
 * The point of approval is a node that can prove nothing - its secret was withdrawn, or it never
 * had one, and nobody can reach it to reflash. The point of denial is a node that must be stopped
 * without touching it.
 */
describe('an admin decision about a node', () => {
  const grant = (state, over = {}) => new Promise((res) =>
    setGrant(db, { org: 'myfarm', project: 'lotus', nodeid: 'esp32-abc', state, by: 'admin', ...over },
      () => res()));

  it('approved: enrols with no secret at all', async () => {
    await grant('approved');
    const { err, cred } = await run(deps(), body({ enrolment_secret: '' }));
    expect(err).toBeFalsy();
    expect(cred.username).toBe('myfarm/lotus/esp32-abc');
  });

  it('approved: enrols with a withdrawn secret', async () => {
    await grant('approved');
    const { err } = await run(deps(), body({ enrolment_secret: 'the-old-one' }));
    expect(err).toBeFalsy();
  });

  it('approved: admits an already-enrolled node that cannot prove its password', async () => {
    // The recovery case: a node whose filesystem was erased holds nothing to prove itself with
    await run(deps(), body());
    const first = (await rows())[0].password;
    const refused = await run(deps(), body());
    expect(refused.err.code).toBe(ENROL.NEEDS_RESET);
    await grant('approved');
    const { err, cred } = await run(deps(), body());
    expect(err).toBeFalsy();
    expect(cred.password).not.toBe(first);
  });

  it('approved: is consumed, so it admits one node once', async () => {
    await grant('approved');
    await run(deps(), body({ enrolment_secret: '' }));
    expect(await new Promise((res) => readGrants(db, 'myfarm', (e, r) => res(r)))).toEqual([]);
    // And the next attempt is back to needing a secret
    const again = await run(deps(), body({ enrolment_secret: '' }));
    expect(again.err.code).toBe(ENROL.REFUSED);
  });

  it('approved: still will not invent a project', async () => {
    // Approval says "this node may enrol", not "accept whatever structure it asks for"
    await grant('approved', { project: 'nosuch' });
    const { err } = await run(deps(), body({ project: 'nosuch', enrolment_secret: '' }));
    expect(err.code).toBe(ENROL.NO_PROJECT);
  });

  it('denied: refused even with a valid secret', async () => {
    // Checked before the secret, because a denied node usually still holds a good one
    await grant('denied');
    const { err } = await run(deps(), body());
    expect(err.code).toBe(ENROL.DENIED);
  });

  it('denied: cannot come back by claiming a different project', async () => {
    // Which is why the grant is keyed on (org, nodeid) and not on the project the node states
    await grant('denied');
    const { err } = await run(deps(), body({ project: 'lotus' }));
    expect(err.code).toBe(ENROL.DENIED);
  });

  it('cleared: may enrol again on its own secret', async () => {
    await grant('denied');
    await new Promise((res) => clearGrant(db, 'myfarm', 'esp32-abc', () => res()));
    const { err } = await run(deps(), body());
    expect(err).toBeFalsy();
  });
});

describe('the record of nodes that asked and were refused', () => {
  it('shows an admin a node they had no other way to learn about', async () => {
    const attempts = makeAttemptLog();
    await run(deps({ attempts, from: '192.168.1.50' }), body({ enrolment_secret: 'wrong' }));
    const [row] = attempts.forOrg('myfarm');
    expect(row).toMatchObject({ nodeid: 'esp32-abc', project: 'lotus', reason: ENROL.REFUSED,
                                from: '192.168.1.50', count: 1 });
  });

  it('counts repeats rather than filling up with them', async () => {
    const attempts = makeAttemptLog();
    for (let i = 0; i < 4; i++) await run(deps({ attempts }), body({ enrolment_secret: 'wrong' }));
    expect(attempts.forOrg('myfarm')).toHaveLength(1);
    expect(attempts.forOrg('myfarm')[0].count).toBe(4);
  });

  it('forgets a node once it succeeds', async () => {
    const attempts = makeAttemptLog();
    await run(deps({ attempts }), body({ enrolment_secret: 'wrong' }));
    await run(deps({ attempts }), body());
    expect(attempts.forOrg('myfarm')).toEqual([]);
  });

  it('is bounded, oldest first, and per organization', async () => {
    let t = 1000;
    const attempts = makeAttemptLog({ perOrg: 2, now: () => t++ });
    for (const id of ['a', 'b', 'c']) {
      await run(deps({ attempts }), body({ nodeid: id, enrolment_secret: 'wrong' }));
    }
    await run(deps({ attempts }), body({ org: 'other', nodeid: 'z', enrolment_secret: 'wrong' }));
    expect(attempts.forOrg('myfarm').map((r) => r.nodeid).sort()).toEqual(['b', 'c']);
    expect(attempts.forOrg('other')).toHaveLength(1);   // one organization cannot crowd out another
  });

  /*
   * A malformed request IS recorded, which it was not at first.
   *
   * The reasoning for excluding it - "nothing an admin could act on" - missed that the fix for a
   * mistyped project is in the firmware, not on the dashboard, and that until the row appears the
   * symptom is identical to the node being dead or pointed at another server entirely.
   */
  it('records a request whose project is not a legal name, so the typo is visible', async () => {
    const attempts = makeAttemptLog();
    const { err } = await run(deps({ attempts }), body({ project: 'Lotus' }));
    expect(err.code).toBe(ENROL.BAD_REQUEST);
    expect(attempts.forOrg('myfarm')).toMatchObject([
      { nodeid: 'esp32-abc', project: 'Lotus', reason: ENROL.BAD_REQUEST },
    ]);
  });

  it('records nothing under an organization that is not a nameable one', async () => {
    // There is no admin who could ever see the row, and nothing would bound how many organizations
    // an unauthenticated caller could invent.
    const attempts = makeAttemptLog();
    await run(deps({ attempts }), body({ org: 'Not An Org' }));
    expect(attempts.forOrg('Not An Org')).toEqual([]);
  });

  it('truncates the untrusted strings it is about to show in a table', async () => {
    const attempts = makeAttemptLog();
    await run(deps({ attempts }), body({ nodeid: 'x'.repeat(500), project: 'y'.repeat(500) }));
    const [row] = attempts.forOrg('myfarm');
    expect(row.nodeid).toHaveLength(64);
    expect(row.project).toHaveLength(64);
  });
});

/*
 * Surviving a restart, which is the whole reason this stopped being memory-only: a node retries
 * every half hour, so a restart hid a node that was asking for up to thirty minutes - and that is
 * indistinguishable from a node that is not asking at all, which is the question being asked.
 */
describe('the record of attempts, across a restart', () => {
  it('reloads what was there, so a node that is asking stays visible', async () => {
    const before = makeAttemptLog();
    await new Promise((res) => before.useDatabase(db, res));
    await run(deps({ attempts: before, from: '10.0.0.9' }), body({ enrolment_secret: 'wrong' }));

    const after = makeAttemptLog();                       // a fresh process, same database
    const loaded = await new Promise((res) => after.useDatabase(db, (e, n) => res(n)));
    expect(loaded).toBe(1);
    expect(after.forOrg('myfarm')).toMatchObject([
      { nodeid: 'esp32-abc', reason: ENROL.REFUSED, from: '10.0.0.9', count: 1 },
    ]);
  });

  it('does not persist a rate-limited attempt', async () => {
    // The one refusal that by definition arrives faster than the limiter allows, so persisting it
    // would be a database write per request from an unauthenticated endpoint.
    const attempts = makeAttemptLog();
    await new Promise((res) => attempts.useDatabase(db, res));
    const limiter = makeRateLimiter({ perNode: 0, perOrg: 0 });
    const { err } = await run(deps({ attempts, limiter }), body());
    expect(err.code).toBe(ENROL.RATE_LIMITED);
    expect(attempts.forOrg('myfarm')).toHaveLength(1);    // visible to the admin
    const rows = await new Promise((res) =>
      db.all('SELECT * FROM node_attempts', [], (e, r) => res(r)));
    expect(rows).toEqual([]);                             // but not written
  });

  it('forgets the persisted row too once the node succeeds', async () => {
    const attempts = makeAttemptLog();
    await new Promise((res) => attempts.useDatabase(db, res));
    await run(deps({ attempts }), body({ enrolment_secret: 'wrong' }));
    await run(deps({ attempts }), body());
    const rows = await new Promise((res) =>
      db.all('SELECT * FROM node_attempts', [], (e, r) => res(r)));
    expect(rows).toEqual([]);
  });
});
