/*
 * Secrets this server generates for itself, in config.d/secrets.yaml.
 *
 * frugal-iot-init writes that file, but a server upgraded from a release that predates it has none,
 * and telling the operator to go and run init is a poor answer: the symptom (everybody logged out
 * on every restart) does not point at the cause, so it would be lived with rather than fixed. So
 * generate what is missing and write it down, which fixes itself once and stays fixed.
 *
 * Synchronous on purpose. This runs once, before the server listens, and doing it with callbacks
 * would mean restructuring the startup sequence around a single small file write.
 */

import { randomBytes } from 'crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';

const HEADER = `# Secrets belonging to this server. Never served to a browser - lib/config-for-user.js
# withholds this whole section. Not in git, and worth backing up alongside frugal-iot.db.
`;

// What each secret is for, written into the file beside it so whoever reads the file later knows
// what rotating it would cost.
const NOTES = {
  session_secret: 'Signs the session cookie. Changing it ends every session.',
  user_secret: "Mixed into each user's derived MQTT password. Changing it invalidates every browser's\n# broker credential until its next login, and nothing else.",
};

// An organization's enrolment secret is written as a LIST, because rotating it means adding a new
// one while the old is still accepted - otherwise every node already flashed with the old value,
// and not yet enrolled, is stranded. Delete a line to withdraw that secret.
const LIST_NOTE = (name) => {
  const org = name.replace(/^enrolment_/, '');
  return `Enrolment secrets for organization "${org}" - any of them is accepted by POST /enrol.
# A node presents one once, to be issued its own broker credential; it grants nothing else, no read
# and no write. To rotate: add a new line above and leave the old one until every node flashed with
# it has enrolled, then delete it. To withdraw one immediately, delete its line.`;
};
const isList = (name) => name.startsWith('enrolment_');

function generate() {
  return randomBytes(32).toString('base64url');
}

/*
 * Make sure every name in `names` has a value, generating and persisting any that do not.
 *
 * Returns { secrets, generated, written, error }:
 *   secrets   - name -> value, always complete, so the caller can use it unconditionally
 *   generated - names that had to be made up on this run
 *   written   - true if they reached the file, false if they exist only for this process
 *   error     - why the write failed, when it did
 *
 * A failed write is not fatal: the server works, and its sessions simply end when it restarts.
 * That can happen legitimately - a read-only install directory, or running as a user who does not
 * own it - so it is reported rather than thrown.
 */
export function ensureSecrets(existing, configDir, names) {
  const secrets = { ...(existing || {}) };
  const generated = names.filter((n) => !secrets[n]);
  if (!generated.length) return { secrets, generated, written: true };

  for (const n of generated) secrets[n] = isList(n) ? [generate()] : generate();

  const path = `${configDir}/secrets.yaml`;
  const body = generated.map((n) => (isList(n)
    ? `\n# ${LIST_NOTE(n)}\n${n}:\n  - "${secrets[n][0]}"\n`
    : `\n# ${NOTES[n] || n}\n${n}: "${secrets[n]}"\n`)).join('');
  try {
    if (existsSync(path)) {
      appendFileSync(path, body);
    } else {
      writeFileSync(path, HEADER + body);
    }
    chmodSync(path, 0o600);
    return { secrets, generated, written: true };
  } catch (e) {
    return { secrets, generated, written: false, error: e.message };
  }
}

/*
 * Adding and withdrawing an organization's enrolment secrets, for the dashboard (SECURITY.md S10).
 *
 * Rewrites just that organization's block, leaving the rest of the file - and its comments, which
 * say what each secret costs to rotate - untouched. Loading and re-emitting the whole file as YAML
 * would be less code and would throw those comments away.
 *
 * Synchronous, like ensureSecrets: one small file, changed by hand at human speed.
 */

const ENROL_NAME = (org) => `enrolment_${org}`;

// The organization's block, whether or not it is there: "enrolment_x:" and the indented list items
// under it. Anything else - a comment, another secret - ends the match.
const blockFor = (org) =>
  new RegExp(`^${ENROL_NAME(org)}:[ \\t]*\\n(?:[ \\t]+-[^\\n]*\\n)*`, 'm');

function renderBlock(org, list) {
  const items = list.map((v) => `  - "${v}"`).join('\n');
  return `${ENROL_NAME(org)}:\n${items}${items ? '\n' : ''}`;
}

/*
 * Write `list` as the organization's enrolment secrets.
 *
 * cb(err) - callers report and carry on. An unwritable file means the change lasts only until the
 * next restart, which is worth saying rather than pretending it was saved.
 */
function writeEnrolmentSecrets(configDir, org, list, cb) {
  const path = `${configDir}/secrets.yaml`;
  try {
    const block = renderBlock(org, list);
    if (!existsSync(path)) {
      writeFileSync(path, HEADER + `\n# ${LIST_NOTE(ENROL_NAME(org))}\n${block}`);
    } else {
      const text = readFileSync(path, 'utf8');
      const re = blockFor(org);
      if (re.test(text)) {
        writeFileSync(path, text.replace(re, block));
      } else {
        // No block of its own yet - an organization added since the file was written
        appendFileSync(path, `\n# ${LIST_NOTE(ENROL_NAME(org))}\n${block}`);
      }
    }
    chmodSync(path, 0o600);
    cb(null);
  } catch (e) {
    cb(e);
  }
}

/*
 * Add a secret, keeping the existing ones.
 *
 * That is the whole point of a list: a node already flashed with the old value, and not yet
 * enrolled, would be stranded if adding replaced it. cb(err, {secret, list}).
 */
export function addEnrolmentSecret(configDir, org, current, cb) {
  const list = [generate(), ...(current || [])];
  writeEnrolmentSecrets(configDir, org, list, (err) => cb(err, { secret: list[0], list }));
}

// Withdraw one secret, by value. cb(err, {list, removed}).
export function removeEnrolmentSecret(configDir, org, secret, current, cb) {
  const list = (current || []).filter((v) => v !== secret);
  const removed = list.length !== (current || []).length;
  if (!removed) return cb(null, { list, removed });
  writeEnrolmentSecrets(configDir, org, list, (err) => cb(err, { list, removed }));
}
