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
import { appendFileSync, chmodSync, existsSync, writeFileSync } from 'fs';

const HEADER = `# Secrets belonging to this server. Never served to a browser - lib/config-for-user.js
# withholds this whole section. Not in git, and worth backing up alongside frugal-iot.db.
`;

// What each secret is for, written into the file beside it so whoever reads the file later knows
// what rotating it would cost.
const NOTES = {
  session_secret: 'Signs the session cookie. Changing it ends every session.',
  user_secret: "Mixed into each user's derived MQTT password. Changing it invalidates every browser's\n# broker credential until its next login, and nothing else.",
};

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

  for (const n of generated) secrets[n] = generate();

  const path = `${configDir}/secrets.yaml`;
  const body = generated.map((n) => `\n# ${NOTES[n] || n}\n${n}: "${secrets[n]}"\n`).join('');
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
