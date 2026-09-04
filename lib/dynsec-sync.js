/*
 * Making the broker match the database, and reporting where it does not.
 *
 * Both directions come from lib/dynsec-plan.js, so "apply" and "check" cannot disagree about what
 * the answer should be - which is what makes "the database is the source of truth and dynsec can be
 * rebuilt from it" a fact rather than a claim.
 */

import { desiredRolesAndGroups, groupsForUser, groupsForNode, groupsForLogger,
         derivePassword, deriveLoggerPassword, names } from './dynsec-plan.js';

// ---- reading the database -------------------------------------------------------------------
// Every (org, project) any permission row mentions, plus every organization in the config, so an
// organization with no permissions yet still gets its groups.
export function readScopes(db, configOrgs, cb) {
  db.all('SELECT DISTINCT org, project FROM permissions', [], (err, rows) => {
    if (err) return cb(err);
    const seen = new Set();
    const scopes = [];
    const add = (org, project) => {
      const k = `${org} ${project || ''}`;
      if (!seen.has(k)) { seen.add(k); scopes.push({ org, project: project || '' }); }
    };
    for (const org of configOrgs || []) add(org, '');
    for (const r of rows) add(r.org, r.project);
    cb(null, scopes);
  });
}

// The id-0 "everyone" rows: what anybody, logged in or not, may read.
export function readPublics(db, cb) {
  db.all("SELECT org, project FROM permissions WHERE id = 0 AND capability = 'READ'", [], (err, rows) =>
    err ? cb(err) : cb(null, rows.map((r) => ({ org: r.org, project: r.project || '' }))));
}

// A user's effective rows - the same "or id = 0" the session itself uses, so the broker and the web
// side can never disagree about what somebody has.
export function readUserRows(db, id, cb) {
  db.all('SELECT capability, org, project FROM permissions WHERE id = ? or id = 0', [id], cb);
}

// ---- applying -------------------------------------------------------------------------------
/*
 * Create every role and group the plan calls for, and set their ACLs. Idempotent: re-running is how
 * the rebuild tool works, and how a release that adds a rule delivers it.
 */
export function applyRolesAndGroups(dynsec, scopes, publics, cb) {
  const { roles, groups } = desiredRolesAndGroups(scopes, publics);
  const create = [];
  const acls = [];
  for (const [rolename, list] of Object.entries(roles)) {
    create.push({ command: 'createRole', rolename });
    for (const a of list) {
      acls.push({ command: 'addRoleACL', rolename, acltype: a.acltype, topic: a.topic,
                  priority: 0, allow: !!a.allow });
    }
  }
  for (const groupname of Object.keys(groups)) create.push({ command: 'createGroup', groupname });

  const links = [];
  for (const [groupname, g] of Object.entries(groups)) {
    for (const rolename of g.roles) links.push({ command: 'addGroupRole', groupname, rolename });
  }
  // Unauthenticated connections land in the public group, so an embedded page needs no credential.
  links.push({ command: 'setAnonymousGroup', groupname: names.publicGroup });

  dynsec.idempotent(create, (err) => {
    if (err) return cb(err);
    dynsec.idempotent(acls, (err2) => {
      if (err2) return cb(err2);
      dynsec.idempotent(links, cb);
    });
  });
}

/*
 * One user: make sure the client exists, its password is the derived one, and its group membership
 * matches its permissions - adding and REMOVING, because a revoked permission has to take effect.
 */
export function applyUser(dynsec, { username, hashedPassword, rows, userSecret }, cb) {
  const want = groupsForUser(rows);
  const password = derivePassword(userSecret, username, hashedPassword);
  // The broker account is "user/<login>", never the bare login - see names.userClient for why.
  const client_id = names.userClient(username);
  dynsec.idempotent([{ command: 'createClient', username: client_id, password }], (err) => {
    if (err) return cb(err);
    dynsec.getClient(client_id, (err2, client) => {
      if (err2) return cb(err2);
      const haveGroups = ((client && client.groups) || []).map((g) => g.groupname || g);
      const haveRoles = ((client && client.roles) || []).map((r) => r.rolename || r);
      const cmds = [{ command: 'setClientPassword', username: client_id, password }];
      for (const g of want.groups) {
        if (!haveGroups.includes(g)) cmds.push({ command: 'addGroupClient', groupname: g, username: client_id });
      }
      for (const g of haveGroups) {
        if (!want.groups.includes(g) && g !== names.publicGroup) {
          cmds.push({ command: 'removeGroupClient', groupname: g, username: client_id });
        }
      }
      // Only roles the client does not already have. Re-adding one answers "Internal error", which
      // says nothing about what is wrong and is not distinguishable from a real failure - the same
      // wording mosquitto_ctrl gets, so it is the plugin's, not ours. Reading the client first and
      // sending only what is missing avoids having to interpret it at all.
      for (const r of want.roles) {
        if (!haveRoles.includes(r)) cmds.push({ command: 'addClientRole', username: client_id, rolename: r });
      }
      dynsec.idempotent(cmds, (err3) => cb(err3, { username: client_id, password, groups: want.groups }));
    });
  });
}

// One node. Its password is random and stored in the database, not derived - a node keeps its copy
// in LittleFS and cannot recompute anything (SECURITY-REVIEW.md section 9).
export function applyNode(dynsec, { org, project, nodeid, password, lora }, cb) {
  const username = names.nodeClient(org, project, nodeid);
  const groups = groupsForNode(org, project, { lora });
  dynsec.idempotent([{ command: 'createClient', username, password }], (err) => {
    if (err) return cb(err);
    const cmds = [{ command: 'setClientPassword', username, password }];
    for (const g of groups) cmds.push({ command: 'addGroupClient', groupname: g, username });
    dynsec.idempotent(cmds, (err2) => cb(err2, { username, groups }));
  });
}

/*
 * The logger's account for one organization. Its password is derived, so this is safe to re-run and
 * the server can compute the same value to hand the logger at startup.
 */
export function applyLogger(dynsec, { org, userSecret }, cb) {
  const username = names.loggerClient(org);
  const password = deriveLoggerPassword(userSecret, org);
  const groups = groupsForLogger(org);
  dynsec.idempotent([{ command: 'createClient', username, password }], (err) => {
    if (err) return cb(err);
    dynsec.getClient(username, (err2, client) => {
      if (err2) return cb(err2);
      const have = ((client && client.groups) || []).map((g) => g.groupname || g);
      const cmds = [{ command: 'setClientPassword', username, password }];
      for (const g of groups) {
        if (!have.includes(g)) cmds.push({ command: 'addGroupClient', groupname: g, username });
      }
      dynsec.idempotent(cmds, (err3) => cb(err3, { username, password, groups }));
    });
  });
}

export function removeUser(dynsec, username, cb) {
  dynsec.raw([{ command: 'deleteClient', username: names.userClient(username) }], (err) => {
    if (err && /not found/i.test(err.message)) return cb(null);
    cb(err);
  });
}

// ---- checking -------------------------------------------------------------------------------
/*
 * What differs between the database and the broker, changing nothing. This is what
 * frugal-iot-rebuild-dynsec --check reports and what scripts/diagnostic.zsh calls: reporting drift
 * is useful more often than repairing it.
 */
export function checkRolesAndGroups(dynsec, scopes, publics, cb) {
  const { roles, groups } = desiredRolesAndGroups(scopes, publics);
  const differences = [];
  dynsec.listRoles((err, haveRoles) => {
    if (err) return cb(err);
    for (const r of Object.keys(roles)) {
      if (!haveRoles.includes(r)) differences.push(`role missing: ${r}`);
    }
    dynsec.listGroups((err2, haveGroups) => {
      if (err2) return cb(err2);
      for (const g of Object.keys(groups)) {
        if (!haveGroups.includes(g)) differences.push(`group missing: ${g}`);
      }
      dynsec.getAnonymousGroup((err3, anon) => {
        // Not an error if the plugin will not say - only report a definite mismatch
        if (!err3 && anon !== names.publicGroup) {
          differences.push(`anonymous group is ${anon || '(unset)'}, expected ${names.publicGroup}`);
        }
        cb(null, differences);
      });
    });
  });
}
