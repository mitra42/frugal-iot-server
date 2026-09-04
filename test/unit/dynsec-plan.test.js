/*
 * The database -> dynsec mapping. Pure, so all of it can be checked without a broker; the shapes it
 * produces were verified against a real one in SECURITY-REVIEW.md section 8 (Q1, Q3, Q5).
 */
import { describe, it, expect } from 'vitest';
import { derivePassword, deriveLoggerPassword, groupsForUser, groupsForNode, groupsForLogger,
         desiredRolesAndGroups, names } from '../../lib/dynsec-plan.js';

const row = (capability, org, project = '') => ({ capability, org, project });

describe('derivePassword', () => {
  const hash = Buffer.from('deadbeef'.repeat(8), 'hex');

  it('is stable for the same inputs - two concurrent logins must agree', () => {
    expect(derivePassword('s', 'fred', hash)).toBe(derivePassword('s', 'fred', hash));
  });

  it('changes when the user changes their password, because the stored hash changes', () => {
    const other = Buffer.from('cafebabe'.repeat(8), 'hex');
    expect(derivePassword('s', 'fred', hash)).not.toBe(derivePassword('s', 'fred', other));
  });

  it('differs per user and per user_secret', () => {
    expect(derivePassword('s', 'fred', hash)).not.toBe(derivePassword('s', 'jane', hash));
    expect(derivePassword('s', 'fred', hash)).not.toBe(derivePassword('t', 'fred', hash));
  });

  it('is long enough that the broker hashing it at 101 iterations does not matter', () => {
    // 22 base64url characters ~ 132 bits: not guessable however cheaply it is hashed
    expect(derivePassword('s', 'fred', hash)).toHaveLength(22);
    expect(derivePassword('s', 'fred', hash)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('refuses to invent a password with no user_secret', () => {
    expect(() => derivePassword('', 'fred', hash)).toThrow(/user_secret/);
  });

  it('reveals nothing about the login password - it never sees one', () => {
    // Derived from the stored PBKDF2 hash, so there is no plaintext in the inputs at all
    expect(derivePassword('s', 'fred', hash)).not.toContain('deadbeef');
  });
});

describe('groupsForUser', () => {
  it('maps READ and WRITE to their groups', () => {
    const g = groupsForUser([row('READ', 'dev'), row('WRITE', 'dev')]);
    expect(g.groups).toEqual(['dev-read', 'dev-write']);
  });

  it('scopes a project-scoped row to the project group', () => {
    const g = groupsForUser([row('READ', 'dev', 'lotus')]);
    expect(g.groups).toEqual(['dev-lotus-read']);
  });

  it('gives org-wide READ plus project-scoped WRITE both groups', () => {
    const g = groupsForUser([row('READ', 'dev'), row('WRITE', 'dev', 'lotus')]);
    expect(g.groups).toEqual(['dev-lotus-write', 'dev-read']);
  });

  it('ignores capabilities the broker has no concept of', () => {
    const g = groupsForUser([row('ADMIN', 'dev'), row('OTAUPDATE', 'dev'), row('OTAFLASH', 'dev')]);
    expect(g.groups).toEqual([]);
  });

  it('always attaches the shared public role, so public read needs no group churn', () => {
    expect(groupsForUser([]).roles).toEqual([names.publicRole]);
  });

  it('handles no permissions at all', () => {
    expect(groupsForUser([]).groups).toEqual([]);
    expect(groupsForUser(undefined).groups).toEqual([]);
  });
});

describe('desiredRolesAndGroups', () => {
  const plan = () => desiredRolesAndGroups(
    [{ org: 'dev', project: '' }, { org: 'dev', project: 'lotus' }, { org: 'varta', project: '' }],
    [{ org: 'dev', project: 'lotus' }],
  );

  it('gives every node one rule for its own subtree, not one rule per node', () => {
    expect(plan().roles[names.ownSubtreeRole])
      .toEqual([{ acltype: 'publishClientSend', topic: '%u/#', allow: true }]);
  });

  it('lets a browser send set/ but NOT publish a reading', () => {
    const acls = plan().roles['dev-write'];
    expect(acls).toEqual([{ acltype: 'publishClientSend', topic: 'dev/+/+/set/#', allow: true }]);
    // the org tree itself is not writable, so a forged reading is refused
    expect(acls.some((a) => a.topic === 'dev/#')).toBe(false);
  });

  it('scopes a project write rule to that project', () => {
    expect(plan().roles['dev-lotus-write'])
      .toEqual([{ acltype: 'publishClientSend', topic: 'dev/lotus/+/set/#', allow: true }]);
  });

  it('puts public read on one shared role, scoped to the project that is public', () => {
    const acls = plan().roles[names.publicRole];
    expect(acls.map((a) => a.topic)).toEqual(['dev/lotus/#', 'dev/lotus/#']);
    expect(acls.map((a) => a.acltype).sort()).toEqual(['publishClientReceive', 'subscribePattern']);
    // dev as a whole is NOT public - that is the point of the project column
    expect(acls.some((a) => a.topic === 'dev/#')).toBe(false);
  });

  it('points the anonymous group at that same role, so embedded pages need no credential', () => {
    expect(plan().groups[names.publicGroup].roles).toEqual([names.publicRole]);
  });

  it('lets nodes read the whole organization, for cross-node controls', () => {
    expect(plan().groups['dev-nodes'].roles).toEqual(['dev-read', names.ownSubtreeRole]);
  });

  it('gives gateways the broader publish they cannot avoid needing', () => {
    expect(plan().roles['dev-gateway'])
      .toEqual([{ acltype: 'publishClientSend', topic: 'dev/#', allow: true }]);
    expect(plan().groups['dev-gateways'].roles).toEqual(['dev-gateway']);
  });

  it('grows with organizations and projects, never with users or nodes', () => {
    const one = Object.keys(desiredRolesAndGroups([{ org: 'dev', project: '' }], []).groups).length;
    const two = Object.keys(desiredRolesAndGroups(
      [{ org: 'dev', project: '' }, { org: 'dev', project: 'lotus' }], []).groups).length;
    expect(two).toBe(one + 2);   // the project's read and write groups, and nothing else
  });
});

describe('the logger', () => {
  it('reads its organization and can send set/, and that is all', () => {
    expect(groupsForLogger('dev')).toEqual(['dev-read', 'dev-write']);
  });

  it('is in no group that would let it publish a reading', () => {
    // dev-write is publishClientSend dev/+/+/set/# - see desiredRolesAndGroups. The point of the
    // logger having its own account is that it cannot invent sensor data.
    const { roles } = desiredRolesAndGroups([{ org: 'dev', project: '' }], []);
    for (const g of groupsForLogger('dev')) {
      for (const acl of roles[g] || []) {
        if (acl.acltype === 'publishClientSend') expect(acl.topic).toContain('/set/');
      }
    }
  });

  it('is named per organization and cannot collide with an organization id', () => {
    // org ids are 1-10 lower-case letters/digits, so none can contain a hyphen
    expect(names.loggerClient('dev')).toBe('dev-logger');
    expect(names.loggerClient('dev')).toMatch(/-logger$/);
  });

  it('has a derived password, stable and distinct per organization', () => {
    expect(deriveLoggerPassword('s', 'dev')).toBe(deriveLoggerPassword('s', 'dev'));
    expect(deriveLoggerPassword('s', 'dev')).not.toBe(deriveLoggerPassword('s', 'varta'));
    expect(deriveLoggerPassword('s', 'dev')).not.toBe(deriveLoggerPassword('t', 'dev'));
    expect(deriveLoggerPassword('s', 'dev')).toHaveLength(22);
  });

  it('never derives the same password as a user, even with a name that lines up', () => {
    const hash = Buffer.from('ab'.repeat(32), 'hex');
    expect(deriveLoggerPassword('s', 'dev')).not.toBe(derivePassword('s', 'dev', hash));
  });

  it('refuses to invent one with no user_secret', () => {
    expect(() => deriveLoggerPassword('', 'dev')).toThrow(/user_secret/);
  });
});

describe('groupsForNode', () => {
  it('puts a plain node in the nodes group only', () => {
    expect(groupsForNode('dev', 'lotus')).toEqual(['dev-nodes']);
  });

  it('adds the gateway group only for a LoRa-capable build', () => {
    expect(groupsForNode('dev', 'lotus', { lora: true })).toEqual(['dev-gateways', 'dev-nodes']);
  });

  it('names a node client after its own topic prefix, which is what %u expands to', () => {
    expect(names.nodeClient('dev', 'lotus', 'esp32-abc')).toBe('dev/lotus/esp32-abc');
  });
});
