#!/usr/bin/env node
/*
 * Load an organization's recorded readings into OpenSearch - the history from before its OpenSearch
 * forwarder was switched on, or a gap from while OpenSearch was down.
 *
 *   npx --no frugal-iot-backfill-opensearch <org>                       everything
 *   npx --no frugal-iot-backfill-opensearch <org> 2026-09-01            only files from that day on
 *   npx --no frugal-iot-backfill-opensearch <org> dry-run               count, and send nothing
 *
 * Run from the server's own directory. It uses the organization's OpenSearch forwarder as set up on
 * the dashboard's Forwarders card (a switched-off one is not used), and its "Only these topics" list.
 * Safe to repeat, and to run while the server is: a reading's id comes from its topic and time, so one
 * already in OpenSearch is replaced rather than doubled.
 *
 * Positional arguments, no flags: npm swallows any --flag it does not recognise. See the npx note in
 * claude.md.
 */

import sqlite3 from 'sqlite3';
import { MqttLogger, backfillOpenSearch } from 'frugal-iot-logger';
import { initializeSchema } from '../lib/database.js';
import { enabledConfigs } from '../lib/forwarders.js';

const [org, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('dry-run');
const since = rest.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!org || rest.some((a) => a !== 'dry-run' && a !== since)) {
  console.error('Usage: npx --no frugal-iot-backfill-opensearch <org> [YYYY-MM-DD] [dry-run]');
  process.exit(1);
}

const realLog = console.log;
console.log = () => {};                       // the config reader logs a line per file
new MqttLogger().readYamlConfig('.', (err, config) => {
  console.log = realLog;
  if (err) { console.error(`Could not read the configuration: ${err.message}`); process.exit(1); }
  if (!(config.organizations || {})[org]) { console.error(`No organization "${org}"`); process.exit(1); }
  const db = new sqlite3.Database('./frugal-iot.db', async (dberr) => {
    if (dberr) { console.error(`Could not open ./frugal-iot.db: ${dberr.message}`); process.exit(1); }
    try {
      await initializeSchema(db); // makes the table if this database is from before it existed
      const fromDb = (await enabledConfigs(db, org, config.opensearch)).filter((c) => c.type === 'opensearch');
      // Still honoured while YAML forwarders are supported, so a server not yet moved over works
      const fromFile = (config.organizations[org].forwarders || []).filter((c) => c && c.type === 'opensearch');
      const forwarders = [...fromDb, ...fromFile];
      if (forwarders.length === 0) {
        console.error(`${org} has no OpenSearch forwarder - add one on the dashboard's Forwarders card first`);
        process.exitCode = 1;
        return;
      }
      for (const fconfig of forwarders) {
        const { sent, skippedFiles } = await backfillOpenSearch({
          config: fconfig, org, dataDir: config.server.datadir, since, dryRun,
          progress: (n) => process.stdout.write(`\r${n} readings`),
        });
        console.log(`\n${dryRun ? 'Would send' : 'Sent'} ${sent} readings to ${fconfig.node}` +
          (skippedFiles ? `; ${skippedFiles} files skipped by its topics list` : ''));
      }
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });
});
