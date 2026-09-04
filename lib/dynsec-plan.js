/*
 * What the broker's dynamic-security state should look like, given the database.
 *
 * Pure: no MQTT, no sqlite, no clock. Given rows it returns the objects that should exist and the
 * commands to make it so - which is what lets the whole mapping be tested without a broker, and
 * what makes "rebuild dynsec from the database" and "report what differs" the same code path.
 *
 * The shapes here follow what was measured on mosquitto 2.0.21 - see SECURITY-REVIEW.md section 8:
 *  - %u expands in a dynsec role ACL, so one rule covers every node
 *  - a client can be in several groups and gets the union
 *  - a role can be attached straight to a client, which is how public read is done without
 *    adding every user to a group
 */

import { createHmac } from 'crypto';

// A permission row's project is '' for organization-wide - see frugal-iot-createdb.sql.
const ORGWIDE = '';

// Names. Kept in one place because both the plan and the diff have to agree on them.
export const names = {
  readRole:    (org, project) => (project ? `${org}-${project}-read`  : `${org}-read`),
  writeRole:   (org, project) => (project ? `${org}-${project}-write` : `${org}-write`),
  readGroup:   (org, project) => (project ? `${org}-${project}-read`  : `${org}-read`),
  writeGroup:  (org, project) => (project ? `${org}-${project}-write` : `${org}-write`),
  nodesGroup:  (org) => `${org}-nodes`,
  gatewayGroup:(org) => `${org}-gateways`,
  gatewayRole: (org) => `${org}-gateway`,
  ownSubtreeRole: 'own-subtree',      // one for the whole broker: publishClientSend %u/#
  publicRole:     'public-read',      // one for the whole broker: the id-0 "everyone" rows
  publicGroup:    'public',           // what setAnonymousGroup points at
  nodeClient:  (org, project, nodeid) => `${org}/${project}/${nodeid}`,

  /*
   * A user's broker account name. Prefixed, and it has to be.
   *
   * addorganization.zsh creates a LOGIN USER named after the organization ("myfarm"), and the
   * organization's own broker account in the password file has that same name. A dynsec client
   * called "myfarm" would therefore take over that name - and because a dynsec answer is final for
   * a client it knows (SECURITY-REVIEW.md section 8, Q4), the organization's shared password would
   * stop working, taking every node, browser and the logger with it. Namespacing the user keeps the
   * two apart until S8 retires the shared account deliberately.
   *
   * "user/" also cannot collide with a node, which is "org/project/nodeid" - no organization id may
   * be "user", because addorganization allows only lower-case letters and digits... which "user"
   * satisfies. So an organization literally called "user" would collide; rejected in
   * add_permission's caller rather than here, where it would be invisible.
   */
  userClient: (username) => `user/${username}`,

  // The logger's own account, one per organization. Cannot collide with anything: an organization
  // id is 1-10 lower-case letters and digits (addorganization.zsh enforces it), so no org is called
  // "<org>-logger", and clients and groups are separate namespaces in dynsec anyway.
  loggerClient: (org) => `${org}-logger`,
};

// Topic filters, in one place for the same reason.
const topics = {
  orgTree:     (org, project) => (project ? `${org}/${project}/#` : `${org}/#`),
  // A browser may command a device but must not forge a reading, so write is set/ only. The extra
  // "+" for an organization-wide rule is the project level: org/project/node/set/...
  setOnly:     (org, project) => (project ? `${org}/${project}/+/set/#` : `${org}/+/+/set/#`),
  ownSubtree:  '%u/#',
  bridgeState: '$SYS/broker/connection/+/state',
};

/*
 * The password a user's browser gets. Derived rather than stored or random - see SECURITY-REVIEW.md
 * section 9: derived from the STORED HASH, so the server can recompute it at any time (a session
 * restored from a cookie has no plaintext), it is the same for two concurrent logins, and a leak
 * tells an attacker nothing about the login password.
 */
export function derivePassword(userSecret, username, hashedPassword) {
  if (!userSecret) throw new Error('No user_secret - run frugal-iot-init');
  const hp = Buffer.isBuffer(hashedPassword) ? hashedPassword : Buffer.from(String(hashedPassword || ''));
  return createHmac('sha256', userSecret)
    .update(String(username)).update(':').update(hp)
    .digest('base64url').slice(0, 22);            // 22 base64url chars = 132 bits
}

/*
 * Which groups a user should be in, and which roles attached directly, from their permission rows.
 * Rows are {capability, org, project}; id-0 rows must already be merged in by the caller, exactly as
 * the session's own query does (WHERE id = ? or id = 0).
 */
export function groupsForUser(rows) {
  const groups = new Set();
  const roles = new Set();
  for (const r of rows || []) {
    const project = r.project || ORGWIDE;
    if (r.capability === 'READ')  groups.add(names.readGroup(r.org, project));
    if (r.capability === 'WRITE') groups.add(names.writeGroup(r.org, project));
  }
  // Every user also gets whatever is public, as one role rather than per-organization membership.
  roles.add(names.publicRole);
  return { groups: [...groups].sort(), roles: [...roles].sort() };
}

/*
 * The roles and groups that should exist, given every organization/project in use and which
 * organizations are publicly readable.
 *
 *   scopes    [{org, project}]  - '' project meaning organization-wide
 *   publics   [{org, project}]  - the id-0 READ rows, as ACLs on the one shared public role
 */
export function desiredRolesAndGroups(scopes, publics) {
  const roles = {};
  const groups = {};

  // One rule for every node on the broker: publish only your own subtree.
  roles[names.ownSubtreeRole] = [
    { acltype: 'publishClientSend', topic: topics.ownSubtree, allow: true },
  ];

  // Public read, as ACL pairs on a single role - so withdrawing it is one removeRoleACL, for
  // everybody, rather than removing every user from a group.
  roles[names.publicRole] = [];
  for (const { org, project } of publics || []) {
    const t = topics.orgTree(org, project || ORGWIDE);
    roles[names.publicRole].push({ acltype: 'subscribePattern', topic: t, allow: true });
    roles[names.publicRole].push({ acltype: 'publishClientReceive', topic: t, allow: true });
  }
  groups[names.publicGroup] = { roles: [names.publicRole] };

  const orgs = new Set();
  for (const { org, project } of scopes || []) {
    const p = project || ORGWIDE;
    orgs.add(org);

    roles[names.readRole(org, p)] = [
      { acltype: 'subscribePattern', topic: topics.orgTree(org, p), allow: true },
      { acltype: 'publishClientReceive', topic: topics.orgTree(org, p), allow: true },
    ];
    roles[names.writeRole(org, p)] = [
      { acltype: 'publishClientSend', topic: topics.setOnly(org, p), allow: true },
    ];
    groups[names.readGroup(org, p)] = { roles: [names.readRole(org, p)] };
    groups[names.writeGroup(org, p)] = { roles: [names.writeRole(org, p)] };
  }

  // Per organization: nodes read the whole organization (cross-node controls) and publish only
  // their own subtree; gateways additionally publish anywhere in the organization, because a
  // gateway republishes other nodes' readings under its own account and MQTT cannot delegate.
  for (const org of orgs) {
    if (!roles[names.readRole(org, ORGWIDE)]) {
      roles[names.readRole(org, ORGWIDE)] = [
        { acltype: 'subscribePattern', topic: topics.orgTree(org, ORGWIDE), allow: true },
        { acltype: 'publishClientReceive', topic: topics.orgTree(org, ORGWIDE), allow: true },
      ];
    }
    roles[names.gatewayRole(org)] = [
      { acltype: 'publishClientSend', topic: topics.orgTree(org, ORGWIDE), allow: true },
    ];
    groups[names.nodesGroup(org)] = { roles: [names.readRole(org, ORGWIDE), names.ownSubtreeRole] };
    groups[names.gatewayGroup(org)] = { roles: [names.gatewayRole(org)] };
  }
  return { roles, groups };
}

/*
 * The logger's password for one organization. Derived, like a user's, so nothing has to be stored
 * and the server can recompute it whenever it starts - which is when it hands it to the logger.
 *
 * A separate label in the HMAC input from a user's, so a logger account and a user account can
 * never derive the same password even if the names lined up.
 */
export function deriveLoggerPassword(userSecret, org) {
  if (!userSecret) throw new Error('No user_secret - run frugal-iot-init');
  return createHmac('sha256', userSecret)
    .update('logger:').update(String(org))
    .digest('base64url').slice(0, 22);
}

/*
 * The logger reads everything in its organization and publishes ONLY set/ topics.
 *
 * It does need write: it is what publishes the platform API's device commands
 * (frugal-iot-logger/index.js:1384). What it must not be able to do is publish a reading, because
 * then a confused or compromised logger could invent sensor data - and the readings are the whole
 * point of the system. The <org>-write role is set/-only, which is exactly that.
 */
export function groupsForLogger(org) {
  return [names.readGroup(org, ORGWIDE), names.writeGroup(org, ORGWIDE)].sort();
}

// Whether a node should be a gateway - declared by the firmware at enrolment, not by what it is
// doing at the time, because any node that sees WiFi can promote itself (see S7).
export function groupsForNode(org, project, { lora = false } = {}) {
  const groups = [names.nodesGroup(org)];
  if (lora) groups.push(names.gatewayGroup(org));
  return groups.sort();
}
