/*
 * Generating and persisting the server's own secrets. The behaviour that matters is that a server
 * with no secrets.yaml writes one instead of quietly using a value that changes on every restart -
 * an installation upgraded from before that file existed should fix itself once, not present a
 * symptom (everybody logged out) that does not point at its cause.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { ensureSecrets, addEnrolmentSecret, removeEnrolmentSecret } from '../../lib/secrets.js';
import yaml from 'js-yaml';

let dir;
beforeEach(() => { dir = mkdtempSync(`${tmpdir()}/frugal-secrets-`); mkdirSync(`${dir}/config.d`); });
afterEach(() => { try { chmodSync(`${dir}/config.d`, 0o755); } catch (e) { /* ignore */ }
                  rmSync(dir, { recursive: true, force: true }); });

const read = () => yaml.load(readFileSync(`${dir}/config.d/secrets.yaml`, 'utf8'));

describe('ensureSecrets', () => {
  it('creates the file and both secrets when there is none', () => {
    const r = ensureSecrets(undefined, `${dir}/config.d`, ['session_secret', 'user_secret']);
    expect(r.written).toBe(true);
    expect(r.generated.sort()).toEqual(['session_secret', 'user_secret']);
    const onDisk = read();
    expect(onDisk.session_secret).toBe(r.secrets.session_secret);
    expect(onDisk.user_secret).toBe(r.secrets.user_secret);
  });

  it('writes it 600, since it is a secret whatever else is true', () => {
    ensureSecrets(undefined, `${dir}/config.d`, ['session_secret']);
    expect(statSync(`${dir}/config.d/secrets.yaml`).mode & 0o777).toBe(0o600);
  });

  it('generates secrets that are long and different from each other', () => {
    const r = ensureSecrets(undefined, `${dir}/config.d`, ['session_secret', 'user_secret']);
    expect(r.secrets.session_secret.length).toBeGreaterThanOrEqual(32);
    expect(r.secrets.session_secret).not.toBe(r.secrets.user_secret);
  });

  it('leaves an existing secret alone and adds only what is missing', () => {
    writeFileSync(`${dir}/config.d/secrets.yaml`, 'session_secret: "already-here"\n');
    const r = ensureSecrets({ session_secret: 'already-here' }, `${dir}/config.d`,
      ['session_secret', 'user_secret']);
    expect(r.generated).toEqual(['user_secret']);
    expect(r.secrets.session_secret).toBe('already-here');
    const onDisk = read();
    expect(onDisk.session_secret).toBe('already-here');
    expect(onDisk.user_secret).toBe(r.secrets.user_secret);
  });

  it('writes nothing when everything is already there', () => {
    const r = ensureSecrets({ session_secret: 'a', user_secret: 'b' }, `${dir}/config.d`,
      ['session_secret', 'user_secret']);
    expect(r.generated).toEqual([]);
    expect(() => readFileSync(`${dir}/config.d/secrets.yaml`)).toThrow();  // never created
  });

  it('is stable across calls - a restart reuses what it saved', () => {
    const first = ensureSecrets(undefined, `${dir}/config.d`, ['session_secret']);
    const reloaded = read();                          // what the next startup would read
    const second = ensureSecrets(reloaded, `${dir}/config.d`, ['session_secret']);
    expect(second.generated).toEqual([]);
    expect(second.secrets.session_secret).toBe(first.secrets.session_secret);
  });

  it('still returns usable secrets when the file cannot be written', () => {
    chmodSync(`${dir}/config.d`, 0o500);              // readable, not writable
    const r = ensureSecrets(undefined, `${dir}/config.d`, ['session_secret']);
    expect(r.written).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.secrets.session_secret).toBeTruthy();     // the server can still run
  });
});

/*
 * Adding and withdrawing enrolment secrets from the dashboard (S10).
 *
 * These rewrite one block of a file that holds other secrets and the comments explaining them, so
 * what matters is what they leave behind, not just what they return.
 */
describe('enrolment secrets, added and withdrawn', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(`${tmpdir()}/frugal-enrol-`); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = () => ensureSecrets({}, dir, ['session_secret', 'user_secret', 'enrolment_myfarm']);
  const read = () => yaml.load(readFileSync(`${dir}/secrets.yaml`, 'utf8'));
  const add = (org, current) => new Promise((res) => addEnrolmentSecret(dir, org, current, (e, r) => res({ e, r })));
  const remove = (org, secret, current) =>
    new Promise((res) => removeEnrolmentSecret(dir, org, secret, current, (e, r) => res({ e, r })));

  it('adds without disturbing the existing one', async () => {
    // The reason the file holds a list at all: a node flashed with the old secret and not yet
    // enrolled must go on being able to enrol.
    const first = seed().secrets.enrolment_myfarm;
    const { e, r } = await add('myfarm', first);
    expect(e).toBe(null);
    expect(r.list).toEqual([r.secret, first[0]]);
    expect(read().enrolment_myfarm).toEqual([r.secret, first[0]]);
  });

  it('leaves the other secrets and their comments alone', async () => {
    const before = seed().secrets;
    const text0 = readFileSync(`${dir}/secrets.yaml`, 'utf8');
    await add('myfarm', before.enrolment_myfarm);
    const after = read();
    expect(after.session_secret).toBe(before.session_secret);
    expect(after.user_secret).toBe(before.user_secret);
    // The notes say what rotating each secret costs; rewriting the file as YAML would drop them
    const comments = (t) => t.split('\n').filter((l) => l.startsWith('#')).length;
    expect(comments(readFileSync(`${dir}/secrets.yaml`, 'utf8'))).toBe(comments(text0));
  });

  it('withdraws one by value, and says when it was not there', async () => {
    const first = seed().secrets.enrolment_myfarm;
    const { r: added } = await add('myfarm', first);
    const { r } = await remove('myfarm', first[0], added.list);
    expect(r.removed).toBe(true);
    expect(read().enrolment_myfarm).toEqual([added.secret]);
    const { r: miss } = await remove('myfarm', 'never-existed', r.list);
    expect(miss.removed).toBe(false);
  });

  it('withdrawing the last one leaves the organization with none', async () => {
    // A legitimate state - no new node can enrol - and it must still be readable YAML
    const first = seed().secrets.enrolment_myfarm;
    await remove('myfarm', first[0], first);
    const after = read();
    expect(after.enrolment_myfarm == null || after.enrolment_myfarm.length === 0).toBe(true);
    expect(after.user_secret).toBeTruthy();
  });

  it('creates a block for an organization the file has never seen', async () => {
    seed();
    const { e, r } = await add('newfarm', []);
    expect(e).toBe(null);
    expect(read().enrolment_newfarm).toEqual([r.secret]);
    expect(read().enrolment_myfarm).toHaveLength(1);   // and not disturbed the first
  });

  it('keeps the file private', async () => {
    const first = seed().secrets.enrolment_myfarm;
    await add('myfarm', first);
    expect(statSync(`${dir}/secrets.yaml`).mode & 0o777).toBe(0o600);
  });

  it('reports a write it could not do rather than claiming success', async () => {
    seed();
    // The file, not the directory: a read-only directory still permits writing a file that already
    // exists, so it is not the trigger it looks like.
    chmodSync(`${dir}/secrets.yaml`, 0o400);
    const { e, r } = await add('myfarm', ['x']);
    chmodSync(`${dir}/secrets.yaml`, 0o600);
    // An install directory the server cannot write is a legitimate state; the caller then says the
    // change lasts only until the next restart rather than pretending it was saved. The new secret
    // is still returned, because the route puts it in the running config either way.
    expect(e).toBeTruthy();
    expect(r.secret).toBeTruthy();
  });
});
