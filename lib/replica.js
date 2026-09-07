/*
 * Sharing a production server's logins with a bridged Pi (SECURITY.md S11).
 *
 * The problem: a bridge relays TOPICS, not accounts. A person who logs into production therefore has
 * no account on the Pi's broker, and the Pi is often the only thing reachable - it goes on working
 * when the link is down, which is why it is there.
 *
 * What travels: username, the stored password hash, its salt, and the permission rows for one
 * organization. Nothing derived from a password, and no secret shared - the Pi authenticates the
 * login itself against that hash (the same pbkdf2 comparison production does) and derives its own
 * broker credential from its OWN user_secret. So the two brokers hand out different passwords for
 * the same person, and neither could compute the other's.
 *
 * Direction: the Pi PULLS. It sits behind a home router that production cannot reach, and its
 * broker bridge is already an outbound connection for the same reason.
 *
 * Revocation: each pull REPLACES that organization's replicated rows. A permission that stops being
 * sent stops existing, with nothing to diff and no way for a stale row to survive.
 */

import { randomBytes } from 'crypto';

/*
 * Replicated users take local id OFFSET + their production id.
 *
 * They cannot use production's ids directly: addorganization creates a login on the Pi too, and
 * both machines allocate from AUTOINCREMENT starting at 2, so the ids would collide. The offset
 * holds only while no installation has OFFSET-2 local users of its own, which is a safe bet for a
 * farm and is asserted below rather than assumed.
 */
export const REPLICA_ID_OFFSET = 1000;

export function isReplicatedId(id) { return Number(id) >= REPLICA_ID_OFFSET; }

export function newBridgeToken() { return randomBytes(32).toString('base64url'); }

// ---- production side ---------------------------------------------------------------------------
/*
 * What one organization's bridge is allowed to know: its people and what they may do.
 *
 * Deliberately not the whole users table - a Pi hosting one organization has no business knowing
 * about anyone else's. id 0 ("everyone") is included, because the Pi's own permission checks read
 * "id = ? or id = 0" and would otherwise disagree with production about what is public.
 */
export function replicaFor(db, org, cb) {
  db.all(`SELECT DISTINCT id FROM permissions WHERE org = ? AND id > 0`, [org], (err, ids) => {
    if (err) return cb(err);
    const list = ids.map((r) => r.id);
    const marks = list.map(() => '?').join(',') || 'NULL';
    db.all(`SELECT id, username, hashed_password, salt, name, email
            FROM users WHERE id IN (${marks}) AND username IS NOT NULL`, list, (uerr, users) => {
      if (uerr) return cb(uerr);
      db.all('SELECT id, capability, org, project FROM permissions WHERE org = ? AND (id > 0 OR id = 0)',
        [org], (perr, permissions) => {
          if (perr) return cb(perr);
          cb(null, {
            org,
            at: Date.now(),
            // Buffers do not survive JSON, and the Pi needs them back as BLOBs or its
            // timingSafeEqual comparison throws instead of failing
            users: users.map((u) => ({
              id: u.id,
              username: u.username,
              hashed_password: u.hashed_password ? Buffer.from(u.hashed_password).toString('base64') : null,
              salt: u.salt ? Buffer.from(u.salt).toString('base64') : null,
              name: u.name,
              email: u.email,
            })),
            permissions,
          });
        });
    });
  });
}

// Which bridge a token belongs to, or nothing. Constant-timeish is not the concern here: a token is
// 32 random bytes, and the lookup is by exact match.
export function bridgeForToken(db, token, cb) {
  if (!token) return cb(null, null);
  db.get('SELECT org, site FROM bridges WHERE token = ?', [token], cb);
}

export function noteBridgePull(db, org, site, cb) {
  cb = cb || (() => {});
  db.run('UPDATE bridges SET last_pull = ? WHERE org = ? AND site = ?', [Date.now(), org, site], cb);
}

// ---- the Pi's side -----------------------------------------------------------------------------
/*
 * Apply one organization's replica, replacing whatever was there.
 *
 * cb(err, {users, permissions, skipped}) - skipped names logins that could not be taken because a
 * LOCAL account already uses that name. Overwriting one would silently change who can log in as
 * whom, so it is refused and reported.
 */
export function applyReplica(db, org, payload, cb) {
  if (!payload || payload.org !== org || !Array.isArray(payload.users) || !Array.isArray(payload.permissions)) {
    return cb(new Error('Not a replica for this organization'));
  }
  // A feed that named other organizations would be granting permissions the Pi does not host
  const foreign = payload.permissions.find((p) => p.org !== org);
  if (foreign) return cb(new Error(`Replica for ${org} carried a permission for ${foreign.org}`));

  const skipped = [];
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE');
    // Everything replicated for THIS organization goes; other organizations, and local rows, stay.
    db.run('DELETE FROM permissions WHERE org = ? AND id >= ?', [org, REPLICA_ID_OFFSET]);

    let pending = payload.users.length;
    const afterUsers = () => {
      let left = payload.permissions.length;
      const done = (err) => {
        if (err) { return db.run('ROLLBACK', () => cb(err)); }
        // A replicated user with no permissions left anywhere is nobody on this machine
        db.run(`DELETE FROM users WHERE id >= ? AND id NOT IN (SELECT id FROM permissions)`,
          [REPLICA_ID_OFFSET], (derr) => {
            if (derr) { return db.run('ROLLBACK', () => cb(derr)); }
            db.run('COMMIT', (cerr) => cb(cerr, {
              users: payload.users.length - skipped.length,
              permissions: payload.permissions.length,
              skipped,
            }));
          });
      };
      if (!left) return done(null);
      for (const p of payload.permissions) {
        // id 0 is "everyone" and is local on every machine - never replicated over the top of it
        const id = Number(p.id) === 0 ? 0 : REPLICA_ID_OFFSET + Number(p.id);
        db.run(`INSERT OR IGNORE INTO permissions (id, capability, org, project)
                VALUES (?, ?, ?, ?)`,
          [id, p.capability, p.org, p.project || ''], (err) => {
            if (err && left > 0) { left = -1; return done(err); }
            if (--left === 0) done(null);
          });
      }
    };
    if (!pending) return afterUsers();
    for (const u of payload.users) {
      const id = REPLICA_ID_OFFSET + Number(u.id);
      if (!Number.isFinite(Number(u.id)) || Number(u.id) <= 0) {
        skipped.push(u.username); if (--pending === 0) afterUsers(); continue;
      }
      const hash = u.hashed_password ? Buffer.from(u.hashed_password, 'base64') : null;
      const salt = u.salt ? Buffer.from(u.salt, 'base64') : null;
      // Take the row only if this name is free or already replicated. A local account of the same
      // name is left alone: replacing it would change who can log in as that person.
      db.get('SELECT id FROM users WHERE username = ?', [u.username], (gerr, existing) => {
        if (gerr) { skipped.push(u.username); if (--pending === 0) afterUsers(); return; }
        if (existing && !isReplicatedId(existing.id)) {
          skipped.push(u.username);
          if (--pending === 0) afterUsers();
          return;
        }
        db.run(`INSERT INTO users (id, username, hashed_password, salt, organization, name, email)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET username = excluded.username,
                  hashed_password = excluded.hashed_password, salt = excluded.salt,
                  name = excluded.name, email = excluded.email`,
          [id, u.username, hash, salt, org, u.name || u.username, u.email || null], () => {
            if (--pending === 0) afterUsers();
          });
      });
    }
  });
}

/*
 * Fetch one organization's replica from production and apply it.
 *
 * Configured in config.d/replica.yaml on the Pi:
 *
 *   url: https://frugaliot.example.org      the production server
 *   organizations: [myfarm]                 the ones this Pi hosts
 *   intervalSeconds: 900                    how often to re-pull
 *
 * with the token in config.d/secrets.yaml as replica_token - a secret, and so not in config.d
 * anywhere a browser could reach it (lib/config-for-user.js withholds that whole section).
 *
 * Never fatal. A Pi whose link is down keeps the replica it already has, and people go on logging
 * in against it: working without the internet is the reason the Pi exists, so a failed pull is an
 * expected state rather than an error.
 */
export function pullReplica(config, db, { onUser } = {}, cb) {
  cb = cb || (() => {});
  const settings = (config && config.replica) || {};
  const token = config && config.secrets && config.secrets.replica_token;
  const orgs = settings.organizations || [];
  if (!settings.url || !token || !orgs.length) {
    return cb(null, { skipped: 'not configured' });
  }
  const base = String(settings.url).replace(/\/+$/, '');
  let i = 0;
  const results = [];
  const next = () => {
    if (i >= orgs.length) return cb(null, { orgs: results });
    const org = orgs[i++];
    fetch(`${base}/replica/${encodeURIComponent(org)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((payload) => new Promise((res, rej) =>
        applyReplica(db, org, payload, (err, result) => (err ? rej(err) : res(result)))))
      .then((result) => {
        results.push({ org, ...result });
        console.log(`Replica ${org}: ${result.users} user(s), ${result.permissions} permission(s)` +
          (result.skipped.length ? `, skipped ${result.skipped.join(', ')} (a local account has that name)` : ''));
        // Each replicated user's broker account, so they can connect here as well as on production
        if (onUser) {
          db.all('SELECT DISTINCT id FROM permissions WHERE org = ? AND id >= ?',
            [org, REPLICA_ID_OFFSET], (err, ids) => {
              for (const r of (ids || [])) onUser(r.id);
              next();
            });
        } else {
          next();
        }
      })
      .catch((err) => {
        // Expected whenever the link is down; the existing replica stays in place
        console.log(`Replica ${org} not refreshed: ${err.message}`);
        results.push({ org, error: err.message });
        next();
      });
  };
  next();
}

/*
 * Pull now, and then on a timer.
 *
 * The timer lives in the server rather than in cron: it is part of being a bridge, so it should
 * start and stop with the server rather than being a separate thing to install and remember.
 */
export function startReplica(config, db, deps) {
  const settings = (config && config.replica) || {};
  if (!settings.url) return null;
  const seconds = Number(settings.intervalSeconds) || 900;
  console.log(`Replicating users from ${settings.url} every ${seconds}s:`,
    (settings.organizations || []).join(', ') || '(no organizations listed)');
  pullReplica(config, db, deps);
  const timer = setInterval(() => pullReplica(config, db, deps), seconds * 1000);
  timer.unref();      // a pending timer should not hold the process open at shutdown
  return timer;
}
