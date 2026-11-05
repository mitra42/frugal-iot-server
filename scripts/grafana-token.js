#!/usr/bin/env node
/*
 * Issue, list or revoke the tokens Grafana uses to read an organization's history (docs/GRAFANA.md).
 *
 *   npx --no frugal-iot-grafana-token add <org> <username> <name>   prints the token - once, it is not kept
 *   npx --no frugal-iot-grafana-token list <org>
 *   npx --no frugal-iot-grafana-token revoke <org> <name>
 *
 * Run from the server's own directory. Adding a name that exists replaces its token, which is how
 * one is rotated. A token is read-only, for that one organization, and acts as <username>: it sees
 * what that user may READ, and stops working when they lose access.
 *
 * Positional arguments, no flags: npm swallows any --flag it does not recognise. See the npx note
 * in claude.md.
 */

import sqlite3 from 'sqlite3';
import { initializeSchema } from '../lib/database.js';
import { addMissingColumns } from '../lib/schema-columns.js';
import { issueToken, listTokens, revokeToken } from '../lib/grafana.js';

const [action, org, ...rest] = process.argv.slice(2);
const [username, name] = action === 'add' ? rest : [undefined, rest[0]];
const usage = () => {
  console.error('Usage: npx --no frugal-iot-grafana-token add <org> <username> <name>');
  console.error('       npx --no frugal-iot-grafana-token list <org>');
  console.error('       npx --no frugal-iot-grafana-token revoke <org> <name>');
  process.exit(1);
};
if (!['add', 'list', 'revoke'].includes(action) || !org || (action === 'add' && !username) || (action !== 'list' && !name)) usage();
if (name && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(name)) {
  console.error('The name must be 1-40 characters: letters, digits, space, _ . -');
  process.exit(1);
}

const db = new sqlite3.Database('./frugal-iot.db', async (err) => {
  if (err) { console.error(`Could not open ./frugal-iot.db: ${err.message}`); process.exit(1); }
  try {
    await initializeSchema(db); // adds the table to a database from before it existed; changes nothing else
    await new Promise((res, rej) => addMissingColumns(db, (e) => (e ? rej(e) : res())));
    if (action === 'add') {
      const user = await new Promise((res, rej) => db.get('SELECT id FROM users WHERE username = ?', [username], (e, r) => (e ? rej(e) : res(r))));
      if (!user) throw new Error(`No user "${username}"`);
      const token = await issueToken(db, org, name, user.id);
      console.log(`Token for ${org} "${name}" (acting as ${username}) - shown once, put it in Grafana now:\n\n${token}\n`);
    } else if (action === 'list') {
      const rows = await listTokens(db, org);
      if (rows.length === 0) console.log(`No Grafana tokens for ${org}`);
      for (const r of rows) {
        console.log(`${r.name}\tissued ${new Date(r.created_at).toISOString()}\tlast used ${r.last_used ? new Date(r.last_used).toISOString() : 'never'}`);
      }
    } else {
      const done = await revokeToken(db, org, name);
      console.log(done ? `Revoked "${name}" for ${org}` : `No token "${name}" for ${org}`);
      if (!done) process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  db.close();
});
