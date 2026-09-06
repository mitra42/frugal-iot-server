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
import { enrol, ENROL, enrolmentSecretsFor, makeRateLimiter, forgetNode } from '../../lib/enrol.js';

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

  it('refuses a missing secret before looking anything up', async () => {
    const { err } = await run(deps(), body({ enrolment_secret: '' }));
    expect(err.code).toBe(ENROL.BAD_REQUEST);
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
