#!/usr/bin/env node
/*
 * Make the broker's dynamic-security state match this server's database, or just report where it
 * differs.
 *
 *   npx --no frugal-iot-rebuild-dynsec          apply
 *   npx --no frugal-iot-rebuild-dynsec check    report only, change nothing
 *
 * Run from the server's own directory. Everything it writes is either stored in the database or
 * derivable from it, so it is safe to re-run: after restoring a database, after a release that adds
 * a rule, or when something looks wrong. "check" is what scripts/diagnostic.zsh calls.
 *
 * "check", not "--check": npm parses the whole command line itself and swallows any --flag it does
 * not recognise, so "npx --no frugal-iot-rebuild-dynsec --check" arrives here with no arguments and
 * would silently APPLY instead of reporting. That is the npx trap in claude.md, and this command hit
 * it - "--check" is still accepted for a direct "node scripts/rebuild-dynsec.js --check".
 */

import sqlite3 from 'sqlite3';
import { MqttLogger } from 'frugal-iot-logger';
import { dynsecConnect } from '../lib/dynsec.js';
import {
  readScopes, readPublics, readUserRows,
  applyRolesAndGroups, applyUser, applyNode, applyLogger, checkRolesAndGroups,
} from '../lib/dynsec-sync.js';
import { names } from '../lib/dynsec-plan.js';

const userClientName = names.userClient;

const ARGS = process.argv.slice(2);
const CHECK = ARGS.includes('check') || ARGS.includes('--check');
const DB = './frugal-iot.db';

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// The same reader the server uses, so this sees exactly the configuration the server sees -
// config.yaml plus config.d, including config.d/secrets.yaml.
//
// It logs a line per file it reads, which is fine at server startup and noise in a command whose
// output scripts/diagnostic.zsh includes - so it is quietened for the duration of the read only.
const realLog = console.log;
console.log = () => {};
new MqttLogger().readYamlConfig('.', (err, config) => {
  console.log = realLog;
  if (err) return fail(`Could not read the configuration: ${err.message}`);
  const orgs = Object.keys((config && config.organizations) || {});
  const userSecret = config.secrets && config.secrets.user_secret;
  if (!CHECK && !userSecret) {
    return fail('No user_secret in config.d/secrets.yaml - run: npx --no frugal-iot-init');
  }

  const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY, (dberr) => {
    if (dberr) return fail(`Could not open ${DB}: ${dberr.message}. Run this from the server's own directory.`);

    dynsecConnect(config, (cerr, dynsec) => {
      if (cerr) {
        // Being unable to reach the plugin is a normal state on a broker that has none, so say what
        // it means rather than only what failed.
        console.error(`Cannot reach the dynamic security plugin: ${cerr.message}`);
        console.error('If this broker has no plugin, per-user accounts are unavailable and that is');
        console.error('all this means. frugal-iot-diagnostic reports which case you are in.');
        process.exit(2);
      }

      readScopes(db, orgs, (e1, scopes) => {
        if (e1) return fail(e1.message);
        readPublics(db, (e2, publics) => {
          if (e2) return fail(e2.message);

          if (CHECK) {
            checkRolesAndGroups(dynsec, scopes, publics, (e3, differences) => {
              if (e3) return fail(e3.message);
              db.all('SELECT id, username FROM users WHERE id > 0 AND username IS NOT NULL', [], (e4, users) => {
                if (e4) return fail(e4.message);
                dynsec.listClients((e5, clients) => {
                  if (e5) return fail(e5.message);
                  for (const u of users) {
                    const want = userClientName(u.username);
                    if (!clients.includes(want)) differences.push(`client missing: ${want}`);
                  }
                  for (const org of orgs) {
                    const want = names.loggerClient(org);
                    if (!clients.includes(want)) differences.push(`client missing: ${want}`);
                  }
                  report(differences);
                  dynsec.end(() => process.exit(differences.length ? 3 : 0));
                });
              });
            });
            return;
          }

          applyRolesAndGroups(dynsec, scopes, publics, (e3) => {
            if (e3) return fail(`Setting up roles and groups: ${e3.message}`);
            console.log(`Roles and groups for ${scopes.length} organization/project scope(s), ` +
                        `${publics.length} publicly readable`);
            syncUsers(db, dynsec, userSecret, (e4, n) => {
              if (e4) return fail(`Syncing users: ${e4.message}`);
              console.log(`${n} user account(s)`);
              syncNodes(db, dynsec, (e5, m) => {
                if (e5) return fail(`Syncing nodes: ${e5.message}`);
                console.log(`${m} node account(s)`);
                syncLoggers(dynsec, orgs, userSecret, (e6, k) => {
                  if (e6) return fail(`Syncing logger accounts: ${e6.message}`);
                  console.log(`${k} logger account(s)`);
                  dynsec.end(() => process.exit(0));
                });
              });
            });
          });
        });
      });
    });
  });
});

function report(differences) {
  if (!differences.length) {
    console.log('The broker matches the database.');
  } else {
    console.log(`${differences.length} difference(s) between the database and the broker:`);
    for (const d of differences) console.log(`  ${d}`);
    console.log('Run without --check to correct them.');
  }
}

// One at a time on purpose: a Pi Zero has one core, there is no hurry, and a batch that fails
// half-way is harder to reason about than a sequence that stops.
function syncUsers(db, dynsec, userSecret, cb) {
  db.all('SELECT id, username, hashed_password FROM users WHERE id > 0 AND username IS NOT NULL', [], (err, users) => {
    if (err) return cb(err);
    let i = 0;
    const next = () => {
      if (i >= users.length) return cb(null, users.length);
      const u = users[i++];
      readUserRows(db, u.id, (e, rows) => {
        if (e) return cb(e);
        applyUser(dynsec, { username: u.username, hashedPassword: u.hashed_password, rows, userSecret },
          (e2) => (e2 ? cb(e2) : next()));
      });
    };
    next();
  });
}

function syncLoggers(dynsec, orgs, userSecret, cb) {
  let i = 0;
  const next = () => {
    if (i >= orgs.length) return cb(null, orgs.length);
    applyLogger(dynsec, { org: orgs[i++], userSecret }, (e) => (e ? cb(e) : next()));
  };
  next();
}

function syncNodes(db, dynsec, cb) {
  // The nodes table arrives with S6; until then there is nothing to do and that is not an error.
  db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'", [], (err, t) => {
    if (err) return cb(err);
    if (!t.length) return cb(null, 0);
    db.all('SELECT org, project, nodeid, password, lora FROM nodes', [], (e, nodes) => {
      if (e) return cb(e);
      let i = 0;
      const next = () => {
        if (i >= nodes.length) return cb(null, nodes.length);
        const n = nodes[i++];
        applyNode(dynsec, { ...n, lora: !!n.lora }, (e2) => (e2 ? cb(e2) : next()));
      };
      next();
    });
  });
}
