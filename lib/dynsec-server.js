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
import { readUserRows, applyUser, applyLogger, applyNode, removeUser,
         applyRolesAndGroups, applyBridge, removeBridge } from './dynsec-sync.js';
import { derivePassword, deriveLoggerPassword, names } from './dynsec-plan.js';

let unavailableReported = false;

/*
 * Has this server ever been set up to drive the plugin?
 *
 * The distinction matters when handing out a DERIVED credential. A derived password is correct
 * whether or not the broker has been told about it *this second* - so when the plugin is merely
 * unreachable for a moment, the account almost certainly exists from an earlier run and the
 * credential works. But when this server has no admin credential at all, the account has never
 * existed, and handing one out gives the holder something that cannot work: a logger authenticating
 * as an account the broker has never heard of records nothing, and a browser shows an empty
 * dashboard - both silently, and both worse than falling back to the shared credential that still
 * works until S8 retires it.
 *
 * This is the state a server is in for the minutes between installing a release that expects the
 * plugin and enabling the plugin, and that window is exactly when it must not break.
 */
function dynsecConfigured(config) {
  const s = (config && config.secrets) || {};
  return !!(s.dynsec_admin_user && s.dynsec_admin_password);
}

/*
 * Another server owns this broker: derive credentials, never try to create them.
 *
 * For working on the server or the client against live data - a laptop pointed at the production
 * broker. It has no admin credential and must not have one, but the accounts it needs already
 * exist, created by the server that does. Given the same user_secret it derives exactly the same
 * passwords, so what it hands a browser works.
 *
 * Declared in config.d/secrets.yaml rather than config.d/mqtt.yaml, for two reasons: that file is
 * never committed, so this cannot be switched on by accident in a checkout; and it is where the
 * borrowed user_secret has to go anyway, which is the real access control here. Without that
 * secret a checkout of this repository cannot reach live data at all, whatever it sets.
 *
 * What does NOT work on such a server, by design: enrolling a node, resetting one, and
 * frugal-iot-rebuild-dynsec - all of which create or delete accounts.
 */
function brokerManagedElsewhere(config) {
  return !!(config && config.secrets && config.secrets.broker_managed_elsewhere);
}

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
  // Borrowing another server's broker: the account is already there, so derive and hand it over
  // without trying to reach a plugin this server has no credential for.
  if (brokerManagedElsewhere(config)) {
    return cb(null, {
      username: names.userClient(user.username),
      password: derivePassword(userSecret, user.username, user.hashed_password),
      brokerUpdated: false,
    });
  }
  // Nothing to hand a browser on a server that has never driven the plugin: the account cannot
  // exist, so the dashboard says live data is unavailable rather than failing to connect with a
  // credential that was never real. See dynsecConfigured.
  if (!dynsecConfigured(config)) {
    reportUnavailable(`user ${user.username}`,
      new Error('No dynsec_admin_user in config.d/secrets.yaml'));
    return cb(null, null);
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

/*
 * The logger's own account for every organization, and the credentials it should use.
 *
 * Called once at startup, BEFORE the logger connects - it cannot authenticate as an account that
 * does not exist yet. Returns what to hand it either way: the password is derived, so it is correct
 * whether or not the broker has been told, and a broker that is unreachable leaves the logger
 * falling back to the organization's shared password, which still works until S8 retires it.
 */
export function syncLoggers(config, orgs, cb) {
  cb = cb || (() => {});
  const userSecret = config.secrets && config.secrets.user_secret;
  const creds = {};
  // No credentials at all means the logger falls back to the organization's shared password, which
  // works until S8. That is the right answer whenever an account of its own could not exist.
  if (!userSecret || (!dynsecConfigured(config) && !brokerManagedElsewhere(config))) {
    reportUnavailable('logger accounts',
      new Error(userSecret ? 'No dynsec_admin_user in config.d/secrets.yaml'
                           : 'No user_secret in config.d/secrets.yaml'));
    return cb(null, creds);
  }
  for (const org of orgs) {
    creds[org] = { username: names.loggerClient(org), password: deriveLoggerPassword(userSecret, org) };
  }
  // Same as for a user: the accounts exist, this server just did not make them. Two loggers on one
  // account is fine - mqtt.js generates a client id per connection, and MQTT evicts by client id,
  // not by user - so a laptop recording alongside production does not disturb it.
  if (brokerManagedElsewhere(config)) return cb(null, creds);
  withDynsec(config, (cerr, dynsec, done) => {
    // Configured but not answering: the accounts are almost certainly there from an earlier run,
    // so the derived credentials are handed over and the logger reconnects when the broker returns.
    if (cerr) { reportUnavailable('logger accounts', cerr); return cb(null, creds); }
    let i = 0;
    const next = () => {
      if (i >= orgs.length) { done(); return cb(null, creds); }
      const org = orgs[i++];
      applyLogger(dynsec, { org, userSecret }, (err) => {
        if (err) {
          console.error(`Could not set up the logger account for ${org}: ${err.message}`);
          // Same reasoning one organization down: do not hand over a credential this run failed to
          // create, or that organization records nothing at all.
          delete creds[org];
        }
        next();
      });
    };
    next();
  });
}

/*
 * One node's broker account, at enrolment. Unlike a user's, this is NOT best effort: a node stores
 * whatever it is given and has no way to notice the broker was never told, so it would be left
 * unable to connect and unable to re-enrol. enrol() refuses rather than issue such a credential,
 * and the node retries.
 */
export function syncNode(config, node, cb) {
  withDynsec(config, (cerr, dynsec, done) => {
    if (cerr) { reportUnavailable(`node ${node.nodeid}`, cerr); return cb(cerr); }
    applyNode(dynsec, node, (err) => { done(); cb(err); });
  });
}

// Remove a node's broker account, for frugal-iot-resetnode. Best effort: the point of resetting is
// that the node will enrol again, which recreates it.
export function dropNode(config, org, project, nodeid, cb) {
  cb = cb || (() => {});
  withDynsec(config, (cerr, dynsec, done) => {
    if (cerr) { reportUnavailable(`removing node ${nodeid}`, cerr); return cb(cerr); }
    dynsec.raw([{ command: 'deleteClient', username: names.nodeClient(org, project, nodeid) }], (err) => {
      done();
      cb(err && !/not found/i.test(err.message) ? err : null);
    });
  });
}

/*
 * Create or re-issue one Pi bridge's broker account, and its role.
 *
 * Both the role and the client, because a bridge's role names the bridge - unlike a user, whose
 * groups exist already. applyRolesAndGroups is given just this one bridge: it is idempotent and
 * only ever adds, so the roles and groups of everything else are left as they are.
 *
 * Unlike addbridge-prod.zsh this needs no root and no shell: the account goes into the plugin
 * rather than the password file, and the ACL into a dynsec role rather than /etc/mosquitto/aclfile.
 * That is what lets an organization's admin add a bridge from the dashboard.
 */
export function syncBridge(config, { org, site, createdAt }, cb) {
  const userSecret = config.secrets && config.secrets.user_secret;
  if (!userSecret) return cb(new Error('No user_secret in config.d/secrets.yaml'));
  if (!dynsecConfigured(config)) {
    return cb(new Error('This server has no dynamic security credential, so it cannot create '
      + 'broker accounts. Use frugal-iot-addbridge-prod from a shell on the server instead.'));
  }
  withDynsec(config, (cerr, dynsec, done) => {
    if (cerr) { reportUnavailable(`bridge ${site}`, cerr); return cb(cerr); }
    applyRolesAndGroups(dynsec, [], [], [], [{ org, site }], (rerr) => {
      if (rerr) { done(); return cb(rerr); }
      applyBridge(dynsec, { org, site, createdAt, userSecret }, (err, res) => { done(); cb(err, res); });
    });
  });
}

// Remove a bridge's account and its role, for when a Pi is retired.
export function dropBridge(config, site, cb) {
  cb = cb || (() => {});
  withDynsec(config, (cerr, dynsec, done) => {
    if (cerr) { reportUnavailable(`removing bridge ${site}`, cerr); return cb(cerr); }
    removeBridge(dynsec, site, (err) => {
      done();
      cb(err && !/not found/i.test(err.message) ? err : null);
    });
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
