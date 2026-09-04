#!/usr/bin/env node
/*
 * Forget a node, so it can enrol again.
 *
 *   npx --no frugal-iot-resetnode <org> <project> <nodeid>
 *
 * Run from the server's own directory.
 *
 * A node proves it is itself by presenting the credential it already holds, so only the node can be
 * issued a new one - otherwise anyone with the organization's enrolment secret could take over any
 * node by quoting its id, which is public (it comes from the chip's MAC). The cost of that is this
 * command: a node whose filesystem has been erased can prove nothing, and somebody has to say "yes,
 * that really is my node".
 *
 * Rare in the field. Common while developing, where erasing flash is routine - two ways to avoid it
 * there are to keep using the older configure_mqtt(host, user, password) form, which does not enrol
 * at all, or to give a development organization its own looser policy.
 *
 * Positional arguments, no flags: npm swallows any --flag it does not recognise, so a flag would
 * arrive here as nothing at all. See the npx note in claude.md.
 */

import sqlite3 from 'sqlite3';
import { MqttLogger } from 'frugal-iot-logger';
import { forgetNode } from '../lib/enrol.js';
import { dropNode } from '../lib/dynsec-server.js';

const [org, project, nodeid] = process.argv.slice(2);
if (!org || !project || !nodeid) {
  console.error('Usage: npx --no frugal-iot-resetnode <org> <project> <nodeid>');
  console.error('Example: npx --no frugal-iot-resetnode myfarm lotus esp32-abc123');
  process.exit(1);
}

const realLog = console.log;
console.log = () => {};                       // the config reader logs a line per file
new MqttLogger().readYamlConfig('.', (err, config) => {
  console.log = realLog;
  if (err) {
    console.error(`Could not read the configuration: ${err.message}`);
    process.exit(1);
  }
  const db = new sqlite3.Database('./frugal-iot.db', (dberr) => {
    if (dberr) {
      console.error(`Could not open ./frugal-iot.db: ${dberr.message}`);
      console.error("Run this from the server's own directory.");
      process.exit(1);
    }
    forgetNode(db, org, project, nodeid, (ferr, changes) => {
      if (ferr) { console.error(ferr.message); process.exit(1); }
      if (!changes) {
        console.log(`No enrolled node ${org}/${project}/${nodeid} - nothing to forget.`);
        console.log('It can enrol as soon as it asks. Check the spelling if you expected one.');
        process.exit(0);
      }
      console.log(`Forgot ${org}/${project}/${nodeid} - it will enrol again on its next attempt.`);
      // Remove the broker account too, so nothing is left that the database no longer knows about.
      // Best effort: enrolling recreates it, and a broker that cannot be reached now is reported by
      // frugal-iot-diagnostic as drift.
      dropNode(config, org, project, nodeid, (derr) => {
        if (derr) {
          console.log(`The broker account was not removed: ${derr.message}`);
          console.log('Harmless - re-enrolling replaces it. frugal-iot-rebuild-dynsec tidies up.');
        }
        db.close(() => process.exit(0));
      });
    });
  });
});
