/*
 * Deleting retained messages server-side.
 *
 * The guards are the interesting part: this is the one route that publishes into an organization's
 * topic tree with an account that may write anywhere in it, so what it refuses matters more than
 * what it does. Nothing here connects to a broker - every case below is refused before that.
 */

import { describe, it, expect } from 'vitest';
import { deleteRetained, adminCredentialFor } from '../../lib/retained.js';
import { deriveOrgAdminPassword, names } from '../../lib/dynsec-plan.js';

const config = {
  mqtt: { broker: 'mqtt://localhost:1883' },
  secrets: { user_secret: 'a-test-secret' },
  organizations: { myfarm: { mqtt_password: 'shared' } },
};

function refusal(org, topics, cfg = config) {
  return new Promise((resolve) => deleteRetained(cfg, org, topics, (err) => resolve(err)));
}

describe('deleteRetained refuses', () => {
  it('a topic outside the organization', async () => {
    const err = await refusal('myfarm', ['other/lotus/n1/sht/temperature']);
    expect(err.status).toBe(403);
  });
  it('a topic that only looks like a prefix', async () => {
    // "myfarmish/..." starts with "myfarm" but is a different organization
    const err = await refusal('myfarm', ['myfarmish/lotus/n1/sht/temperature']);
    expect(err.status).toBe(403);
  });
  it('a wildcard', async () => {
    // The browser sends the topics it listed, not the pattern it listed them with. A "#" arriving
    // here would mean "everything in the organization" with nobody having looked at it first.
    for (const t of ['myfarm/#', 'myfarm/+/n1/sht/temperature']) {
      expect((await refusal('myfarm', [t])).status).toBe(400);
    }
  });
  it('an empty list, and one that is not a list', async () => {
    expect((await refusal('myfarm', [])).status).toBe(400);
    expect((await refusal('myfarm', 'myfarm/x')).status).toBe(400);
  });
  it('more topics than any organization has', async () => {
    const many = new Array(5001).fill('myfarm/lotus/n1/sht/temperature');
    expect((await refusal('myfarm', many)).status).toBe(400);
  });
  it('an organization name that is not one', async () => {
    expect((await refusal('../etc', ['../etc/x'])).status).toBe(400);
  });
  it('a configuration with no broker', async () => {
    const err = await refusal('myfarm', ['myfarm/lotus/n1/sht/x'], { secrets: config.secrets });
    expect(err.status).toBe(500);
  });
});

describe('which credential it publishes as', () => {
  it('the derived per-organization admin account when there is a user_secret', () => {
    const cred = adminCredentialFor(config, 'myfarm');
    expect(cred.username).toBe(names.orgAdminClient('myfarm'));
    expect(cred.password).toBe(deriveOrgAdminPassword('a-test-secret', 'myfarm'));
  });
  it("the organization's shared account when there is not", () => {
    // A broker with no dynamic security plugin, which is the state a server upgrades from.
    const cred = adminCredentialFor({ organizations: config.organizations }, 'myfarm');
    expect(cred).toEqual({ username: 'myfarm', password: 'shared' });
  });
  it('nothing at all when neither is available', () => {
    expect(adminCredentialFor({ organizations: {} }, 'myfarm')).toBe(null);
  });
  it('a password that does not collide with the logger\'s', () => {
    // Both are HMACs of the same secret over a string containing the organization name, so the
    // labels have to differ - "orgadmin:" and "logger:" - or the two accounts would share one.
    const admin = deriveOrgAdminPassword('s', 'myfarm');
    expect(admin).not.toBe(deriveOrgAdminPassword('s', 'myfar') + 'm');
    expect(admin).toHaveLength(22);
  });
});
