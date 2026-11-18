#!/usr/bin/env node
/*
 * Print one of the server's own derived broker credentials: the username on the first line, the
 * password on the second.
 *
 *   node <package>/scripts/broker-credential.js logger <org>     reads the whole organization
 *   node <package>/scripts/broker-credential.js orgadmin <org>   publishes anywhere in it
 *
 * Run from the server's own directory, the one holding config.d/secrets.yaml. Not an npx command:
 * it is for the installers and the diagnostic, which need an account that can log in to the broker
 * now that there is no shared organization password (S8). Both accounts are created from the
 * database by frugal-iot-rebuild-dynsec and at server startup, so they exist only after one of those.
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { names, deriveLoggerPassword, deriveOrgAdminPassword } from '../lib/dynsec-plan.js';

const [kind, org] = process.argv.slice(2);
const kinds = {
  logger:   { username: names.loggerClient,   password: deriveLoggerPassword },
  orgadmin: { username: names.orgAdminClient, password: deriveOrgAdminPassword },
};
if (!kinds[kind] || !org) {
  console.error('Usage: broker-credential.js logger|orgadmin <org>');
  process.exit(1);
}

let secrets;
try {
  secrets = yaml.load(readFileSync('config.d/secrets.yaml', 'utf8')) || {};
} catch (e) {
  console.error(`Cannot read config.d/secrets.yaml (${e.code || e.message}) - run this from the server's own directory`);
  process.exit(1);
}
if (!secrets.user_secret) {
  console.error('No user_secret in config.d/secrets.yaml - start the server once, or run: npx --no frugal-iot-init');
  process.exit(1);
}
console.log(kinds[kind].username(org));
console.log(kinds[kind].password(secrets.user_secret, org));
