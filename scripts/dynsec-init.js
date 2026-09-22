#!/usr/bin/env node
/*
 * Create the broker's initial dynamic-security state, without mosquitto_ctrl.
 *
 *   npx --no frugal-iot-dynsec-init [output-path]
 *
 * Run from the server's own directory, the one holding frugal-iot.db.
 *
 * Why this exists. `mosquitto_ctrl dynsec init` does the same job and is what install-pi.sh uses,
 * but it comes from the mosquitto-clients package, and on the production server that package cannot
 * be installed: its broker was built for an older Ubuntu from the mosquitto PPA, and the
 * mosquitto-clients in the distribution demands an exactly-matching libmosquitto1 - so apt would
 * downgrade the library out from under the running broker. Without this, per-user broker accounts
 * could be set up on a Pi and not on production.
 *
 * What it writes is the file the plugin keeps its state in: one admin client, the admin role that
 * lets it drive $CONTROL, and the defaults mosquitto_ctrl sets. Everything else - every user, node,
 * logger, group and role - is created by the server from the database afterwards, so this file is a
 * starting point rather than something to maintain (npx --no frugal-iot-rebuild-dynsec).
 *
 * It does NOT install the file: writing to /var/lib/mosquitto needs root, and running this whole
 * script under sudo would leave config.d/secrets.yaml owned by root, which the server then could
 * not rewrite. So it writes here, as you, and prints the one command that moves it into place.
 */

import { pbkdf2Sync, randomBytes } from 'crypto';
import { existsSync, writeFileSync, appendFileSync, chmodSync, readFileSync } from 'fs';

const SECRETS = './config.d/secrets.yaml';
const ADMIN = 'frugal-admin';
const TARGET = '/var/lib/mosquitto/dynamic-security.json';
const out = process.argv[2] || './dynamic-security.json';

/*
 * How mosquitto stores a dynsec password, confirmed by reproducing a file mosquitto_ctrl wrote:
 * PBKDF2-HMAC-SHA512, the iteration count from the file, a 12-byte salt, 64 bytes out, both salt
 * and hash base64. The 101 iterations are mosquitto's own default and are not a typo - this file is
 * read only at startup and by the plugin itself, so it is not a password-store hash in the usual
 * sense; changing the number here would be harmless but pointless.
 */
function hash(password, iterations = 101) {
  const salt = randomBytes(12);
  return {
    salt: salt.toString('base64'),
    password: pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('base64'),
    iterations,
  };
}

function fail(message, ...rest) {
  console.error(message);
  for (const line of rest) console.error(line);
  process.exit(1);
}

if (existsSync(out)) {
  fail(`${out} already exists - not overwriting it.`,
    'If the broker is using it, replacing it would delete every account it knows about and',
    'every node would stop connecting. Move it aside first if you really mean to start again.');
}
if (!existsSync(SECRETS)) {
  fail(`No ${SECRETS}.`,
    "If you are in the server's own directory - the one holding frugal-iot.db - then this",
    'installation predates that file. It is created by:  npx --no frugal-iot-init',
    '',
    'Run that first. Do not create the file by hand and run this before upgrading the server:',
    'a release that predates config-for-user.js serves the whole configuration to any logged-in',
    'browser, so the admin credential this writes would go out with it.');
}
if (/^dynsec_admin_user:/m.test(readFileSync(SECRETS, 'utf8'))) {
  fail(`${SECRETS} already has a dynsec_admin_user.`,
    'This server already has an admin credential, so the broker most likely already has its',
    'state file. Check with: npx --no frugal-iot-diagnostic');
}

const password = randomBytes(24).toString('base64url');
const { salt, password: hashed, iterations } = hash(password);

// The shape mosquitto_ctrl produces. Only the admin client and its role: the server creates
// everything else from the database.
const state = {
  defaultACLAccess: {
    publishClientSend: false,
    publishClientReceive: true,
    subscribe: false,
    unsubscribe: true,
  },
  clients: [{
    username: ADMIN,
    textname: 'Dynsec admin user',
    roles: [{ rolename: 'admin' }],
    password: hashed,
    salt,
    iterations,
  }],
  groups: [],
  roles: [{
    rolename: 'admin',
    acls: [
      { acltype: 'publishClientSend', topic: '$CONTROL/dynamic-security/#', priority: 0, allow: true },
      { acltype: 'publishClientReceive', topic: '$CONTROL/dynamic-security/#', priority: 0, allow: true },
      { acltype: 'publishClientReceive', topic: '$SYS/#', priority: 0, allow: true },
      { acltype: 'subscribePattern', topic: '$CONTROL/dynamic-security/#', priority: 0, allow: true },
      { acltype: 'subscribePattern', topic: '$SYS/#', priority: 0, allow: true },
    ],
  }],
};

writeFileSync(out, JSON.stringify(state, null, 2) + '\n');
chmodSync(out, 0o600);

appendFileSync(SECRETS, [
  '',
  '# The broker account the server uses to create and remove other accounts, over',
  '# $CONTROL/dynamic-security/v1. Created by frugal-iot-dynsec-init.',
  `dynsec_admin_user: "${ADMIN}"`,
  `dynsec_admin_password: "${password}"`,
  '',
].join('\n'));
chmodSync(SECRETS, 0o600);

console.log(`Wrote ${out}, and the admin credential to ${SECRETS}.`);
console.log('');
console.log('The password is not printed: it is in that file, which is never served to a browser.');
console.log('');
console.log('Next, as root - the broker reads this file AFTER dropping privileges, so it has to');
console.log('belong to the mosquitto user or the broker will not start:');
console.log('');
console.log(`  sudo install -o mosquitto -g mosquitto -m 600 ${out} ${TARGET}`);
console.log('');
console.log('Then add these two lines to the broker configuration - the plugin path differs by');
console.log('distribution, so find yours with:  ls /usr/lib/*/mosquitto_dynamic_security.so');
console.log('');
console.log('  plugin /usr/lib/<arch>/mosquitto_dynamic_security.so');
console.log(`  plugin_opt_config_file ${TARGET}`);
console.log('');
console.log('and restart the broker, then build the accounts from the database:');
console.log('');
console.log('  sudo systemctl restart mosquitto');
console.log('  sudo systemctl restart frugaliot');
console.log('  npx --no frugal-iot-rebuild-dynsec');
console.log('  npx --no frugal-iot-rebuild-dynsec check');
