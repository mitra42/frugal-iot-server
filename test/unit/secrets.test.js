/*
 * Generating and persisting the server's own secrets. The behaviour that matters is that a server
 * with no secrets.yaml writes one instead of quietly using a value that changes on every restart -
 * an installation upgraded from before that file existed should fix itself once, not present a
 * symptom (everybody logged out) that does not point at its cause.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { ensureSecrets } from '../../lib/secrets.js';
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
