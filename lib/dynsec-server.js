/*
 * The server's own use of dynamic security: keeping one user's broker account in step with the
 * database, at the moments the database changes.
 *
 * Every function here is best-effort and never fatal. A broker with no plugin, or one that is
 * briefly unreachable, must not stop somebody logging in or an administrator granting a permission -
 * the dashboard is more useful with live data missing than not at all. Failures are logged with
 * enough context to act on, and scripts/diagnostic.zsh reports the resulting drift.
 */

import { dynsecConnect } from './dynsec.js';
import { readUserRows, applyUser, removeUser } from './dynsec-sync.js';
import { derivePassword } from './dynsec-plan.js';

let unavailableReported = false;

// A connection per operation rather than one held open. These happen at login and at permission
// changes - rare, and never in a hot path - and a short-lived connection cannot go stale, which on
// a Pi that sleeps or loses its network it otherwise would.
function withDynsec(config, cb) {
  dynsecConnect(config, (err, dynsec) => {
    if (err) return cb(err);
    cb(null, dynsec, () => dynsec.end(() => {}));
  });
}

function reportUnavailable(what, err) {
  // Once per process for the ordinary "this broker has no plugin" case, so a server without one
  // does not fill its journal - and on an SD card, its card. Everything else is worth a line.
  const ordinary = /No dynsec_admin_user|did not answer|No answer from the broker/.test(err.message);
  if (ordinary && unavailableReported) return;
  if (ordinary) unavailableReported = true;
  console.log(`Broker accounts not updated (${what}): ${err.message}`);
}

/*
 * Make the broker match the database for one user, and return the password their browser should
 * use. Call this whenever what the database says about them changes: at login, when a permission is
 * granted or revoked, and when they change their password (which changes the derived credential).
 *
 * cb(err, {username, password}) - err only for a caller that wants to know; callers here log and
 * carry on.
 */
export function syncUser(db, config, user, cb) {
  cb = cb || (() => {});
  const userSecret = config.secrets && config.secrets.user_secret;
  if (!userSecret) {
    const err = new Error('No user_secret in config.d/secrets.yaml - run frugal-iot-init');
    reportUnavailable(`user ${user.username}`, err);
    return cb(err);
  }
  readUserRows(db, user.id, (err, rows) => {
    if (err) return cb(err);
    withDynsec(config, (cerr, dynsec, done) => {
      if (cerr) {
        reportUnavailable(`user ${user.username}`, cerr);
        // Still hand back the credential: it is derived, so it is correct whether or not the broker
        // has been told about it yet, and a later rebuild will make the broker agree.
        return cb(null, {
          username: `user/${user.username}`,
          password: derivePassword(userSecret, user.username, user.hashed_password),
          brokerUpdated: false,
        });
      }
      applyUser(dynsec, {
        username: user.username, hashedPassword: user.hashed_password, rows, userSecret,
      }, (aerr, res) => {
        done();
        if (aerr) {
          console.error(`Could not update the broker account for ${user.username}: ${aerr.message}`);
          return cb(aerr);
        }
        cb(null, { ...res, brokerUpdated: true });
      });
    });
  });
}

// Same, by id - for the permission routes, which have an id and no user object.
export function syncUserById(db, config, id, cb) {
  cb = cb || (() => {});
  db.get('SELECT id, username, hashed_password FROM users WHERE id = ?', [id], (err, user) => {
    if (err) return cb(err);
    // id 0 is "everyone" and is not an account anybody logs in as, so there is nothing to sync -
    // but a change to its rows affects EVERY user, which only a rebuild can put right. Say so.
    if (!user || !user.username) {
      if (Number(id) === 0) {
        console.log('A permission for "everyone" changed. Every user\'s broker account is affected:');
        console.log('  run  npx --no frugal-iot-rebuild-dynsec  to apply it to all of them.');
      }
      return cb(null, null);
    }
    syncUser(db, config, user, cb);
  });
}

// When an account goes away. Not wired up yet - nothing deletes users - but the rebuild tool cannot
// notice a user that is no longer in the database, so this is what the deletion path will need.
export function dropUser(config, username, cb) {
  cb = cb || (() => {});
  withDynsec(config, (cerr, dynsec, done) => {
    if (cerr) { reportUnavailable(`removing ${username}`, cerr); return cb(cerr); }
    removeUser(dynsec, username, (err) => { done(); cb(err); });
  });
}
