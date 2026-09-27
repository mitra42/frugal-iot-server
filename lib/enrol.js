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
  DENIED: 'denied',              // an admin has denied this node
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
 *
 * The numbers were set for a node that retries every half hour - twice an hour, well under a limit
 * of five. THAT IS NOT WHAT A DEEP-SLEEPING NODE DOES. nextEnrolTime lives in RAM, which deep sleep
 * discards, so such a node asks once per WAKE: at the default ten-minute cycle that is six an hour,
 * over the old per-node limit, and three such nodes exhausted the whole organization's twenty. A
 * fleet flashed together and waiting to be approved is the ordinary case, not an attack, and the
 * limit turned it into `rate_limited` rows that hid the real reason each node was being refused.
 *
 * So: twelve per node (a five-minute cycle) and a hundred and twenty per organization (twenty such
 * nodes). What this costs is small, because the limiter is no longer the only thing bounding the
 * damage - makeAttemptLog evicts to perOrg rows, throttles repeats to one write a minute, and
 * writes nothing at all for a rate-limited request. And the per-node number never protected much:
 * the only thing it guards by counting is the `current_password` proof, which is 24 random bytes
 * and is not reachable by guessing at five an hour or at fifty.
 */
export function makeRateLimiter({ perOrg = 120, perNode = 12, windowMs = 3600000, now = Date.now,
                                  sweepAbove = 1000 } = {}) {
  const hits = new Map();   // key -> [timestamps]
  const record = (key, limit) => {
    const t = now();
    const kept = (hits.get(key) || []).filter((x) => x > t - windowMs);
    kept.push(t);
    hits.set(key, kept);
    /*
     * Sweep expired keys, rather than only expired timestamps within a key.
     *
     * Nothing removed a key once made, which was a slow leak even when every key was a valid node
     * id, and is a faster one now that the limiter runs BEFORE the shape check and so sees whatever
     * an unauthenticated caller sent. Only above a threshold, so the ordinary case - a handful of
     * nodes in a handful of organizations - never walks the map at all.
     */
    if (hits.size > sweepAbove) {
      for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= t - windowMs) hits.delete(k);
    }
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
 * The record of nodes that asked and were refused, for the dashboard's Nodes card (SECURITY.md S12).
 *
 * This is how an admin learns a node's id at all: an id is not discoverable from the server, but a
 * node that keeps asking puts itself in this list, and the admin approves it from there. The rows
 * are therefore UNTRUSTED - anyone can make an id appear by attempting enrolment - so each keeps
 * when it asked and from where, for the admin to recognise rather than to trust.
 *
 * Bounded, and PERSISTED once useDatabase() is called - see the node_attempts table for why that
 * changed. Briefly: "losing the list on a restart costs nothing, a node still retrying reappears
 * within minutes" was wrong on the interval. A node retries every HALF HOUR, so a restart made a
 * node that was asking indistinguishable from a node that was not asking at all, for up to thirty
 * minutes - and that is exactly the question an administrator restarts a server to investigate.
 */
export function makeAttemptLog({ perOrg = 50, now = Date.now, minWriteMs = 60000 } = {}) {
  const rows = new Map();   // "org/nodeid" -> {org, project, nodeid, at, from, reason, count, written}
  let db = null;            // set by useDatabase(), because the database is opened after this is made
  const keyOf = (org, nodeid) => `${org}/${nodeid}`;

  const write = (r) => {
    if (!db) return;
    r.written = r.at;
    db.run(`INSERT INTO node_attempts (org, project, nodeid, reason, from_addr, at, count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(org, nodeid)
            DO UPDATE SET project = excluded.project, reason = excluded.reason,
                          from_addr = excluded.from_addr, at = excluded.at, count = excluded.count`,
      [r.org, r.project || '', r.nodeid, r.reason || '', r.from || '', r.at, r.count],
      // Best effort: this is a diagnostic aid, and failing to record one must not turn an
      // enrolment refusal into a 500.
      (err) => { if (err) console.error("Could not record enrolment attempt:", err.message); });
  };
  const drop = (org, nodeid) => {
    rows.delete(keyOf(org, nodeid));
    if (db) db.run('DELETE FROM node_attempts WHERE org = ? AND nodeid = ?', [org, nodeid], () => {});
  };

  return {
    /*
     * Adopt a database: load what is already there, and write through from then on.
     *
     * Separate from the constructor only because of when each happens - the log is made at module
     * level so that POST /enrol and GET /nodes_list share one, and the database is opened later.
     * Until this is called the log behaves exactly as it used to, in memory alone, so a caller
     * that never calls it (a test) needs no database.
     */
    useDatabase(database, cb) {
      db = database;
      db.all('SELECT org, project, nodeid, reason, from_addr, at, count FROM node_attempts', [],
        (err, saved) => {
          if (err) return cb(err);
          for (const r of saved || []) {
            rows.set(keyOf(r.org, r.nodeid), {
              org: r.org, project: r.project, nodeid: r.nodeid, from: r.from_addr,
              reason: r.reason, at: r.at, count: r.count, written: r.at,
            });
          }
          cb(null, (saved || []).length);
        });
    },
    /*
     * durable: false records in memory but does not write. Used for a rate-limited request, which
     * is the one kind that arrives faster than the limiter caps - the limiter refuses it but this
     * is still called, so without that flag an unauthenticated flood would be a database write per
     * request. A node that is genuinely retrying has already been written by its first few
     * attempts, so nothing an administrator needs is lost.
     */
    record({ org, project, nodeid, from, reason, durable = true }) {
      const key = keyOf(org, nodeid);
      const existing = rows.get(key);
      const row = {
        org, project, nodeid, from, reason,
        at: now(),
        count: existing ? existing.count + 1 : 1,
        written: existing ? (existing.written || 0) : 0,
      };
      rows.set(key, row);
      // A new node, or one whose refusal reason has changed, is written at once - those are what an
      // administrator is waiting to see. A node repeating the same refusal is throttled, because
      // the only thing changing is a timestamp and a count.
      if (durable && (!existing || existing.reason !== reason || row.at - row.written >= minWriteMs)) {
        write(row);
      }
      // Oldest out first, per organization, so one organization cannot crowd out another
      const mine = [...rows.values()].filter((r) => r.org === org).sort((a, b) => a.at - b.at);
      for (const r of mine.slice(0, Math.max(0, mine.length - perOrg))) drop(r.org, r.nodeid);
    },
    forOrg(org) { return [...rows.values()].filter((r) => r.org === org); },
    forget(org, nodeid) { drop(org, nodeid); },
  };
}

// An admin's decision about one node, from the node_grants table
export function readGrant(db, org, nodeid, cb) {
  db.get('SELECT state, project FROM node_grants WHERE org = ? AND nodeid = ?', [org, nodeid], cb);
}
export function setGrant(db, { org, project, nodeid, state, by }, cb) {
  db.run(`INSERT INTO node_grants (org, project, nodeid, state, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(org, nodeid)
          DO UPDATE SET project = excluded.project, state = excluded.state,
                        created_by = excluded.created_by, created_at = excluded.created_at`,
    [org, project || '', nodeid, state, by || '', Date.now()], cb);
}
export function clearGrant(db, org, nodeid, cb) {
  db.run('DELETE FROM node_grants WHERE org = ? AND nodeid = ?', [org, nodeid],
    function (err) { cb(err, this && this.changes); });
}
export function readGrants(db, org, cb) {
  db.all('SELECT project, nodeid, state, created_by, created_at FROM node_grants WHERE org = ?',
    [org], cb);
}

/*
 * Handle one enrolment request.
 *
 * deps: { db, config, limiter, syncNode, attempts?, from? }
 *   syncNode(node, cb)  creates the broker account
 *   attempts            makeAttemptLog(), so a refusal reaches the dashboard's Nodes card
 *   from                the caller's address, recorded with a refusal
 * body: { org, project, nodeid, enrolment_secret, current_password?, lora? }
 *
 * cb(err, { username, password }) - err.code is one of ENROL above.
 */
export function enrol(deps, body, cb) {
  const { db, config, limiter, syncNode, attempts, from } = deps;
  const org = String((body && body.org) || '');
  const project = String((body && body.project) || '');
  const nodeid = String((body && body.nodeid) || '');
  const secret = String((body && body.enrolment_secret) || '');
  const lora = !!(body && body.lora);

  /*
   * EVERY refusal is worth showing an admin, including a malformed one. It is the only way they
   * learn that a node exists and is asking at all.
   *
   * The shape check used to be excluded, on the grounds that a request which is not even
   * org/project/nodeid tells an admin nothing they could act on. That was wrong twice over: a node
   * whose project is mistyped (a capital letter, a hyphen) fails the shape check, and then the ONE
   * symptom of the typo - "nothing appears anywhere" - is identical to the node being dead, off the
   * network, or pointed at a different server. Seeing the row is what distinguishes them, even
   * though approving it would not help. What an admin can act on is the FIRMWARE.
   *
   * Two conditions on recording, both because the strings below the shape check are arbitrary input
   * from an unauthenticated request:
   *   - the organization must be a nameable one, or there is no admin who could ever see the row
   *     and nothing bounds how many organizations an attacker can invent;
   *   - project and nodeid are truncated, since they are shown in a table.
   */
  const refuse = (code, message, durable = true) => {
    if (attempts && NAME.test(org)) {
      attempts.record({
        org, project: project.slice(0, 64), nodeid: nodeid.slice(0, 64), from, reason: code, durable,
      });
    }
    return cb(new EnrolError(code, message));
  };

  // Before the shape check, not after it as it used to be. Now that a malformed request is recorded,
  // it has to be capped the same way a well-formed one is, or a flood of invented node ids would
  // reach the log unlimited.
  if (limiter && !limiter.allow(org, nodeid.slice(0, 64))) {
    // durable: false - the one refusal that by definition arrives faster than the limit allows
    return refuse(ENROL.RATE_LIMITED, 'Too many enrolment attempts - try later', false);
  }

  if (!NAME.test(org) || !NAME.test(project) || !NODEID.test(nodeid)) {
    return refuse(ENROL.BAD_REQUEST, 'org, project and nodeid are required and must be plain names');
  }

  /*
   * What the admin has decided about this node, before anything else is considered.
   *
   *   denied    refused whatever it presents, and the reason it is checked before the secret: a
   *             denied node usually still holds a perfectly good secret.
   *   approved  the secret is not required, and neither is proof of a current password - which is
   *             the whole point, since this exists for a node that can prove nothing. Consumed on
   *             success, so one approval admits one node once.
   *
   * The project must still be registered either way. An approval says "this node may enrol", not
   * "invent whatever structure it asks for".
   */
  readGrant(db, org, nodeid, (gerr, grant) => {
    if (gerr) return cb(gerr);
    if (grant && grant.state === 'denied') {
      return refuse(ENROL.DENIED, 'This node has been denied by an administrator');
    }
    const approved = !!(grant && grant.state === 'approved');

    if (!approved) {
      // A missing secret is a refusal, not a malformed request - a node flashed with none is
      // precisely the node an admin may want to approve, so it has to reach the list above rather
      // than being turned away as a bad request.
      const accepted = enrolmentSecretsFor(config, org);
      if (!secret || !accepted.some((x) => sameSecret(x, secret))) {
        // Same answer whether the organization does not exist or the secret is wrong
        return refuse(ENROL.REFUSED, 'Enrolment refused');
      }
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
      return refuse(ENROL.NO_PROJECT,
        `Organization ${org} has no project "${project}". Check the spelling on the node, or add ` +
        `the project on the dashboard's Projects tab, then let the node try again.`);
    }
    db.get('SELECT password FROM nodes WHERE org = ? AND project = ? AND nodeid = ?',
    [org, project, nodeid], (err, existing) => {
      if (err) return cb(err);

      if (existing && !approved) {
        const proof = String((body && body.current_password) || '');
        if (!proof || !sameSecret(existing.password, proof)) {
          // Trust on first use, and only on first use. See the note at the top of this file.
          return refuse(ENROL.NEEDS_RESET,
            'This node is already enrolled. Only the node itself can be issued a new credential; ' +
            'if its filesystem was erased, an administrator can approve it on the dashboard, or ' +
            'clear the binding with frugal-iot-resetnode.');
        }
      }

      const password = randomBytes(24).toString('base64url');
      const node = { org, project, nodeid, password, lora };
      // The broker first: a node that stored a credential the broker does not know would be unable
      // to connect AND unable to re-enrol, because it has one. Better to refuse and let it retry.
      syncNode(node, (serr) => {
        if (serr) {
          return refuse(ENROL.BROKER,
            'The broker could not be updated - not issuing a credential that would not work');
        }
        db.run(`INSERT INTO nodes (org, project, nodeid, password, lora, enrolled_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(org, project, nodeid)
                DO UPDATE SET password = excluded.password, lora = excluded.lora,
                              enrolled_at = excluded.enrolled_at`,
          [org, project, nodeid, password, lora ? 1 : 0, Date.now()], (ierr) => {
            if (ierr) return cb(ierr);
            if (limiter) limiter.forget(org, nodeid);   // success is not an attempt worth counting
            if (attempts) attempts.forget(org, nodeid); // nor a failure still worth showing
            const done = () => cb(null, { username: `${org}/${project}/${nodeid}`, password });
            // An approval admits one node once. Left in place it would be a standing invitation to
            // anyone quoting a public node id.
            if (approved) return clearGrant(db, org, nodeid, done);
            done();
          });
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
