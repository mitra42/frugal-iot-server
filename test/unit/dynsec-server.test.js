/*
 * Handing out derived credentials on a server that may not be able to create them.
 *
 * A derived password is correct whether or not the broker has been told about it, which makes it
 * tempting to hand over unconditionally. On a server that has never driven the plugin that is a
 * silent failure: the logger authenticates as an account the broker has never heard of and records
 * nothing, and the dashboard connects with a credential that was never real. Both look like
 * success from here.
 *
 * Nothing in this file reaches a broker: every case below returns before connecting.
 */

import { describe, it, expect } from 'vitest';
import { syncLoggers, syncUser } from '../../lib/dynsec-server.js';

const SECRETS = {
  user_secret: 'a-user-secret',
  dynsec_admin_user: 'frugal-admin',
  dynsec_admin_password: 'admin-password',
};
// No mqtt.broker either, so any attempt to connect would fail rather than reach a real one
const config = (secrets) => ({ secrets, organizations: { myfarm: {} } });

const loggers = (secrets) => new Promise((res) =>
  syncLoggers(config(secrets), ['myfarm'], (err, creds) => res(creds)));

// readUserRows is the only thing syncUser asks the database for
const db = { all: (sql, args, cb) => cb(null, []) };
const user = { id: 2, username: 'alice', hashed_password: Buffer.from('hash') };
const forUser = (secrets) => new Promise((res) =>
  syncUser(db, config(secrets), user, (err, cred) => res({ err, cred })));

describe('a server that has never been set up to drive the plugin', () => {
  it('gives the logger nothing, so it falls back to the shared password', async () => {
    // The state a server is in between installing this release and enabling the plugin. Handing
    // over <org>-logger there would stop it recording, with nothing to say why.
    const { dynsec_admin_user, dynsec_admin_password, ...rest } = SECRETS;
    expect(await loggers(rest)).toEqual({});
  });

  it('gives a browser nothing, so the dashboard says live data is unavailable', async () => {
    const { dynsec_admin_user, dynsec_admin_password, ...rest } = SECRETS;
    const { err, cred } = await forUser(rest);
    expect(err).toBeFalsy();     // logging in still works; only the live data is missing
    expect(cred).toBe(null);
  });

  it('gives nothing when there is no user_secret either', async () => {
    expect(await loggers({})).toEqual({});
  });
});

describe('a server that is set up but cannot reach the broker', () => {
  it('still hands the logger its derived credential', async () => {
    // Different case, and the common one: the account is almost certainly there from an earlier
    // run, so the credential works and the logger reconnects when the broker comes back.
    const creds = await loggers(SECRETS);
    expect(creds.myfarm).toMatchObject({ username: 'myfarm-logger' });
    expect(creds.myfarm.password).toHaveLength(22);
  });

  it('still hands a browser its derived credential', async () => {
    const { cred } = await forUser(SECRETS);
    expect(cred).toMatchObject({ username: 'user/alice', brokerUpdated: false });
  });
});
