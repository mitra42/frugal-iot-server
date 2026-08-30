/*
 * Password reset codes, held nowhere.
 *
 * A code is an HMAC over (user id, email, current password hash, five-minute slot), keyed by a
 * secret this process made at startup. Nothing is written to the database and nothing expires by
 * being deleted - a code stops verifying because the slot has moved on, the password has changed,
 * or the server has restarted. Two slots are accepted, so a code lasts between 5 and 10 minutes.
 *
 * Including the current hashed_password is what makes a code single-use: resetting the password
 * changes the hash, and every code derived from the old one stops matching immediately.
 *
 * Two forms come out of the same digest:
 *   code  - six digits, short enough to read off a phone and type in
 *   token - 32 hex characters, put in the emailed link, where length costs nothing
 * Six digits is only a million guesses, so the six-digit form is worth having only alongside the
 * rate limiting below; the link form does not depend on it.
 */
import crypto from 'crypto';

const SLOT_MS = 5 * 60 * 1000;   // a code is valid for its own slot and the one before it
const SLOTS_ACCEPTED = 2;
// Regenerated every start: a restart invalidates outstanding codes, which is the right way round.
const secret = crypto.randomBytes(32);

// Rate limits, per identifier, in memory. Lost on restart, which also invalidates every code, so
// there is nothing to carry over. Not a defence against a distributed attacker - it is here so that
// a million guesses at a six-digit code cannot be made in the ten minutes one is alive.
const SEND_LIMIT = 3;            // reset emails per identifier
const CHECK_LIMIT = 10;          // verification attempts per identifier
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const buckets = { send: new Map(), check: new Map() };

function slotNow() { return Math.floor(Date.now() / SLOT_MS); }

function digestFor(user, slot) {
  // The password hash is a BLOB from sqlite; a user with no password yet has none.
  const hashed = user.hashed_password ? Buffer.from(user.hashed_password).toString('hex') : '';
  return crypto.createHmac('sha256', secret)
    .update([user.id, user.email || '', hashed, slot].join('\n'))
    .digest();
}
function formsFor(user, slot) {
  const d = digestFor(user, slot);
  return {
    code: String(d.readUInt32BE(0) % 1000000).padStart(6, '0'),
    token: d.toString('hex').slice(0, 32),
  };
}
// Constant-time, and safe on differing lengths - timingSafeEqual throws on those rather than
// returning false.
function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// { code, token } for the current slot - what goes in the email
function resetCodeMake(user) {
  return formsFor(user, slotNow());
}
// True if "supplied" is either form, for this slot or the one before
function resetCodeCheck(user, supplied) {
  if (!supplied) { return false; }
  const now = slotNow();
  let ok = false;
  for (let i = 0; i < SLOTS_ACCEPTED; i++) {
    const { code, token } = formsFor(user, now - i);
    // No early return: keep the work the same whichever slot matches
    ok = sameSecret(supplied, code) || sameSecret(supplied, token) || ok;
  }
  return ok;
}

// True if this identifier may make another attempt of this kind, and counts it if so.
// bucket is 'send' (asking for an email) or 'check' (trying a code).
function resetRateOk(bucket, key) {
  const limit = (bucket === 'send') ? SEND_LIMIT : CHECK_LIMIT;
  const map = buckets[bucket];
  const now = Date.now();
  const hits = (map.get(key) || []).filter((t) => (now - t) < LIMIT_WINDOW_MS);
  if (hits.length >= limit) {
    map.set(key, hits);
    return false;
  }
  hits.push(now);
  map.set(key, hits);
  // Nothing else prunes this, and an attacker can name any identifier they like, so drop entries
  // whose window has passed whenever the map gets big rather than growing without bound.
  if (map.size > 1000) {
    for (const [k, v] of map) {
      if (!v.some((t) => (now - t) < LIMIT_WINDOW_MS)) { map.delete(k); }
    }
  }
  return true;
}
// So a test can start from a clean slate without waiting out the window
function resetRateClear() {
  buckets.send.clear();
  buckets.check.clear();
}

export { resetCodeMake, resetCodeCheck, resetRateOk, resetRateClear, SLOT_MS, SLOTS_ACCEPTED };
