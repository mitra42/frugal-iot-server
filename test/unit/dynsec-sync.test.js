/*
 * applyUser and applyRolesAndGroups, against a fake plugin.
 *
 * The fake records every command and can be told to fail one, which is how the two bugs found on
 * the real broker are kept fixed: a re-run must not abort on an "already ..." error, and a role the
 * client already has must not be re-added (the plugin answers "Internal error", which is
 * indistinguishable from a real fault).
 */
import { describe, it, expect } from 'vitest';

// vitest has no "done" callback, and the code under test is callback-style (claude.md prefers
// callbacks), so each test hands its body a resolve function instead.
const cbTest = (fn) => () => new Promise((resolve, reject) => {
  try { fn(resolve); } catch (e) { reject(e); }
});
import { applyUser, applyRolesAndGroups, checkRolesAndGroups } from '../../lib/dynsec-sync.js';

// roleAcls is what getRole answers for each role, as {rolename: [acl, ...]}
function fakeDynsec({ client = null, roles = [], groups = [], roleAcls = {}, failWith = null } = {}) {
  const sent = [];
  const run = (commands, cb) => {
    sent.push(...commands);
    const bad = failWith && commands.find((c) => c.command === failWith.command);
    const responses = commands.map((c) => (c.command === 'getRole'
      ? { command: c.command, data: { role: { rolename: c.rolename, acls: roleAcls[c.rolename] || [] } } }
      : { command: c.command }));
    cb(bad ? new Error(`${failWith.command}: ${failWith.message}`) : null, responses);
  };
  return {
    sent,
    raw: run,
    // Mirrors the real helper: anything matching /already/ is "nothing to do"
    idempotent: (commands, cb) => run(commands, (err, res) =>
      (err && /already/i.test(err.message) ? cb(null, res) : cb(err, res))),
    getClient: (username, cb) => cb(null, client),
    listRoles: (cb) => cb(null, roles),
    listGroups: (cb) => cb(null, groups),
    getAnonymousGroup: (cb) => cb(null, 'public'),
    end: (cb) => cb && cb(),
  };
}

// The organization's registered projects, which the discovery ACLs are built from
const PROJECTS = [{ org: 'dev', project: 'lotus' }];

const opts = (rows) => ({
  username: 'fred', hashedPassword: Buffer.from('ab'.repeat(32), 'hex'), rows, userSecret: 'sekrit',
});

describe('applyUser', () => {
  it('names the broker account "user/<login>", never the bare login', cbTest((done) => {
    // A bare "myfarm" would collide with the organization's own broker account and break it
    const d = fakeDynsec();
    applyUser(d, opts([{ capability: 'READ', org: 'dev', project: '' }]), (err, res) => {
      expect(err).toBeFalsy();
      expect(res.username).toBe('user/fred');
      expect(d.sent.find((c) => c.command === 'createClient').username).toBe('user/fred');
      done();
    });
  }));

  it('adds the groups the permissions call for', cbTest((done) => {
    const d = fakeDynsec();
    applyUser(d, opts([{ capability: 'READ', org: 'dev', project: '' },
                       { capability: 'WRITE', org: 'dev', project: '' }]), () => {
      const added = d.sent.filter((c) => c.command === 'addGroupClient').map((c) => c.groupname);
      expect(added.sort()).toEqual(['dev-read', 'dev-write']);
      done();
    });
  }));

  it('REMOVES a group whose permission has gone - revocation has to take effect', cbTest((done) => {
    const d = fakeDynsec({ client: { groups: [{ groupname: 'dev-read' }, { groupname: 'dev-write' }] } });
    applyUser(d, opts([{ capability: 'READ', org: 'dev', project: '' }]), () => {
      const removed = d.sent.filter((c) => c.command === 'removeGroupClient').map((c) => c.groupname);
      expect(removed).toEqual(['dev-write']);
      done();
    });
  }));

  it('never removes the public group, which is not driven by a permission row', cbTest((done) => {
    const d = fakeDynsec({ client: { groups: [{ groupname: 'public' }] } });
    applyUser(d, opts([]), () => {
      expect(d.sent.filter((c) => c.command === 'removeGroupClient')).toEqual([]);
      done();
    });
  }));

  it('does not re-add a role the client already has', cbTest((done) => {
    // The real plugin answers "Internal error" for that, which says nothing and looks like a fault
    const d = fakeDynsec({ client: { roles: [{ rolename: 'public-read' }] } });
    applyUser(d, opts([]), () => {
      expect(d.sent.filter((c) => c.command === 'addClientRole')).toEqual([]);
      done();
    });
  }));

  it('adds the public role when the client does not have it', cbTest((done) => {
    const d = fakeDynsec({ client: { roles: [] } });
    applyUser(d, opts([]), () => {
      expect(d.sent.filter((c) => c.command === 'addClientRole').map((c) => c.rolename))
        .toEqual(['public-read']);
      done();
    });
  }));

  it('sets the password every time, so a changed login password propagates', cbTest((done) => {
    const d = fakeDynsec();
    applyUser(d, opts([]), (err, res) => {
      const set = d.sent.find((c) => c.command === 'setClientPassword');
      expect(set.password).toBe(res.password);
      done();
    });
  }));
});

describe('applyRolesAndGroups', () => {
  const scopes = [{ org: 'dev', project: '' }];

  it('is not stopped by "already exists" - it is re-run constantly', cbTest((done) => {
    const d = fakeDynsec({ failWith: { command: 'createRole', message: 'Role already exists' } });
    applyRolesAndGroups(d, scopes, [], PROJECTS, [], (err) => { expect(err).toBeFalsy(); done(); });
  }));

  it('is not stopped by "already in this role" either - the bug that aborted a real apply', cbTest((done) => {
    const d = fakeDynsec({ failWith: { command: 'addGroupRole', message: 'Group is already in this role' } });
    applyRolesAndGroups(d, scopes, [], PROJECTS, [], (err) => { expect(err).toBeFalsy(); done(); });
  }));

  it('does report a real failure', cbTest((done) => {
    const d = fakeDynsec({ failWith: { command: 'createRole', message: 'Out of memory' } });
    applyRolesAndGroups(d, scopes, [], PROJECTS, [], (err) => { expect(err).toBeTruthy(); done(); });
  }));

  it('given just a new project, adds the rule that lets its nodes announce - what syncProject does', cbTest((done) => {
    const d = fakeDynsec();
    applyRolesAndGroups(d, [], [], [{ org: 'kopernik', project: 'developers' }], [], (err) => {
      expect(err).toBeFalsy();
      expect(d.sent).toContainEqual(expect.objectContaining({
        command: 'addRoleACL', rolename: 'kopernik-discover', acltype: 'publishClientSend', topic: 'kopernik/developers',
      }));
      done();
    });
  }));

  it('points the anonymous group at the public role', cbTest((done) => {
    const d = fakeDynsec();
    applyRolesAndGroups(d, scopes, [], PROJECTS, [], () => {
      expect(d.sent.find((c) => c.command === 'setAnonymousGroup').groupname).toBe('public');
      done();
    });
  }));
});

describe('checkRolesAndGroups', () => {
  it('reports what is missing and changes nothing', cbTest((done) => {
    const d = fakeDynsec({ roles: ['own-subtree'], groups: [] });
    checkRolesAndGroups(d, [{ org: 'dev', project: '' }], [], PROJECTS, [], (err, differences) => {
      expect(err).toBeFalsy();
      expect(differences.some((x) => x.includes('dev-read'))).toBe(true);
      expect(d.sent.filter((c) => /^create|^add|^remove|^set/.test(c.command))).toEqual([]);
      done();
    });
  }));

  it('reports a role that exists but is missing a rule', cbTest((done) => {
    // The case that said "matches" on production: <org>-discover existed, created empty with the
    // organization, and the project registered afterwards never got its rule
    const d = fakeDynsec({ roles: ['dev-discover'], roleAcls: { 'dev-discover': [] } });
    checkRolesAndGroups(d, [{ org: 'dev', project: '' }], [], PROJECTS, [], (err, differences) => {
      expect(err).toBeFalsy();
      expect(differences).toContain('rule missing: dev-discover allow publishClientSend dev/lotus');
      done();
    });
  }));

  it('does not report a rule that is there', cbTest((done) => {
    const d = fakeDynsec({ roles: ['dev-discover'], roleAcls: {
      'dev-discover': [{ acltype: 'publishClientSend', topic: 'dev/lotus', priority: 0, allow: true }],
    } });
    checkRolesAndGroups(d, [{ org: 'dev', project: '' }], [], PROJECTS, [], (err, differences) => {
      expect(differences.filter((x) => x.includes('dev-discover'))).toEqual([]);
      done();
    });
  }));
});
