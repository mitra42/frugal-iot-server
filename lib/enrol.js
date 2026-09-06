/*
 * Node enrolment: how a node gets its own broker credential.
 *
 * The problem this solves (SECURITY-REVIEW.md section 6): every node has the organization's shared
 * broker password compiled into its firmware, so extracting one node's flash yields a credential
 * for everything, and it cannot be rotated without reflashing the fleet. It has to be replaced by a
 * per-node credential the node fetches for itself - because most nodes are flashed from PlatformIO
 * or the Arduino IDE with no dashboard involved, and waiting for a human to approve each one does
 * not work in practice.
 *
 * So: the firmware carries an ENROLMENT SECRET, which grants exactly one thing - "create a node in
 * this organization". No read, no write, no broker access at all. It is rate limited, per
 * organization, and revocable server-side without reflashing anything, none of which is true of the
 * broker password it replaces.
 *
 * The one weakness, and why the 409 below exists: a node id is derived from the chip's MAC, so it is
 * public and anyone can claim to be one. If the server re-issued a credential to any request quoting
 * an existing node id, the enrolment secret would become "impersonate any node in the organization",
 * which is the isolation this whole step exists to create. So a node that already exists must prove
 * it holds the current password.
 */

import { randomBytes } from 'crypto';

// How enrolment can fail, in a shape the route can turn into a status code. Deliberately vague to
// the caller about WHY a secret was refused - a node has no use for the difference, and an attacker
// probing organization names should not learn which ones exist.
export const ENROL = {
  BAD_REQUEST: 'bad_request',
  REFUSED: 'refused',            // wrong or unknown secret, or unknown organization
  RATE_LIMITED: 'rate_limited',
  NEEDS_RESET: 'needs_reset',    // known node, no proof of its current password
  NO_PROJECT: 'no_such_project',  // the organization has no project of that name
  BROKER: 'broker_unavailable',
};

class EnrolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/*
 * Which enrolment secrets an organization accepts.
 *
 * A LIST, not one secret, so a secret can be rotated without stranding nodes that were flashed with
 * the old one and have not enrolled yet. Any secret in the list is accepted; a compromised one is
 * deleted by hand. A node that has already enrolled never presents one again, so it is unaffected
 * either way.
 *
 * Per organization, and that matters: an admin who shares their organization's secret, or leaks it
 * in a firmware image, must not thereby let anyone enrol nodes into a different organization.
 */
export function enrolmentSecretsFor(config, org) {
  const s = (config && config.secrets && config.secrets[`enrolment_${org}`]);
  if (!s) return [];
  return (Array.isArray(s) ? s : [s]).map(String).filter((x) => x.length);
}

// Constant-time-ish comparison. The secrets are long random strings, so a timing attack is not the
// realistic threat here, but there is no reason to leak a prefix match either.
function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i++) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differing === 0;
}

/*
 * Rate limiting, in memory.
 *
 * Two counters, because they answer different questions: per organization stops somebody with a
 * leaked secret filling the database with invented nodes, and per node id stops repeated attempts
 * against one real node. In memory is enough - it survives as long as the process, a restart is a
 * fair reset, and persisting it would mean a disk write per attempt.
 */
export function makeRateLimiter({ perOrg = 20, perNode = 5, windowMs = 3600000, now = Date.now } = {}) {
  const hits = new Map();   // key -> [timestamps]
  const record = (key, limit) => {
    const t = now();
    const kept = (hits.get(key) || []).filter((x) => x > t - windowMs);
    kept.push(t);
    hits.set(key, kept);
    return kept.length <= limit;
  };
  return {
    allow(org, nodeid) {
      // Both are recorded even if the first refuses, so a flood counts against the organization
      const orgOk = record(`org:${org}`, perOrg);
      const nodeOk = record(`node:${org}/${nodeid}`, perNode);
      return orgOk && nodeOk;
    },
    // For tests and for a successful enrolment, which should not count against the limit
    forget(org, nodeid) { hits.delete(`org:${org}`); hits.delete(`node:${org}/${nodeid}`); },
  };
}

const NODEID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[a-z0-9]{1,32}$/;

/*
 * Handle one enrolment request.
 *
 * deps: { db, config, limiter, syncNode }  - syncNode(node, cb) creates the broker account
 * body: { org, project, nodeid, enrolment_secret, current_password?, lora? }
 *
 * cb(err, { username, password }) - err.code is one of ENROL above.
 */
export function enrol(deps, body, cb) {
  const { db, config, limiter, syncNode } = deps;
  const org = String((body && body.org) || '');
  const project = String((body && body.project) || '');
  const nodeid = String((body && body.nodeid) || '');
  const secret = String((body && body.enrolment_secret) || '');
  const lora = !!(body && body.lora);

  if (!NAME.test(org) || !NAME.test(project) || !NODEID.test(nodeid)) {
    return cb(new EnrolError(ENROL.BAD_REQUEST, 'org, project and nodeid are required and must be plain names'));
  }
  if (!secret) return cb(new EnrolError(ENROL.BAD_REQUEST, 'enrolment_secret is required'));

  if (limiter && !limiter.allow(org, nodeid)) {
    return cb(new EnrolError(ENROL.RATE_LIMITED, 'Too many enrolment attempts - try later'));
  }

  const accepted = enrolmentSecretsFor(config, org);
  if (!accepted.some((s) => sameSecret(s, secret))) {
    // Same answer whether the organization does not exist or the secret is wrong
    return cb(new EnrolError(ENROL.REFUSED, 'Enrolment refused'));
  }

  /*
   * The project has to be one the organization has actually registered.
   *
   * Without this, a project name mistyped into a node's captive portal is accepted, gets its own
   * broker account, and then appears in the dashboard as a project with a node in it - inventing
   * organisation structure from a typo. The admin dashboard's Projects tab is where projects are
   * added, so the fix is in the operator's hands and the error below says so.
   */
  db.get('SELECT 1 AS ok FROM projects WHERE org = ? AND id = ?', [org, project], (perr, known) => {
    if (perr) return cb(perr);
    if (!known) {
      return cb(new EnrolError(ENROL.NO_PROJECT,
        `Organization ${org} has no project "${project}". Check the spelling on the node, or add ` +
        `the project on the dashboard's Projects tab, then let the node try again.`));
    }
    db.get('SELECT password FROM nodes WHERE org = ? AND project = ? AND nodeid = ?',
    [org, project, nodeid], (err, existing) => {
      if (err) return cb(err);

      if (existing) {
        const proof = String((body && body.current_password) || '');
        if (!proof || !sameSecret(existing.password, proof)) {
          // Trust on first use, and only on first use. See the note at the top of this file.
          return cb(new EnrolError(ENROL.NEEDS_RESET,
            'This node is already enrolled. Only the node itself can be issued a new credential; ' +
            'if its filesystem was erased, clear the binding with frugal-iot-resetnode.'));
        }
      }

      const password = randomBytes(24).toString('base64url');
      const node = { org, project, nodeid, password, lora };
      // The broker first: a node that stored a credential the broker does not know would be unable
      // to connect AND unable to re-enrol, because it has one. Better to refuse and let it retry.
      syncNode(node, (serr) => {
        if (serr) {
          return cb(new EnrolError(ENROL.BROKER,
            'The broker could not be updated - not issuing a credential that would not work'));
        }
        db.run(`INSERT INTO nodes (org, project, nodeid, password, lora, enrolled_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(org, project, nodeid)
                DO UPDATE SET password = excluded.password, lora = excluded.lora,
                              enrolled_at = excluded.enrolled_at`,
          [org, project, nodeid, password, lora ? 1 : 0, Date.now()], (ierr) => {
            if (ierr) return cb(ierr);
            if (limiter) limiter.forget(org, nodeid);   // success is not an attempt worth counting
            cb(null, { username: `${org}/${project}/${nodeid}`, password });
          });
      });
    });
  });
}

// Forget a node, so it can enrol afresh - for a node whose filesystem was erased and which
// therefore cannot prove anything. The one human step, and only in recovery.
export function forgetNode(db, org, project, nodeid, cb) {
  db.run('DELETE FROM nodes WHERE org = ? AND project = ? AND nodeid = ?',
    [org, project, nodeid], function (err) { cb(err, this && this.changes); });
}
