#!/usr/bin/env node
/*
 * List, and optionally delete, retained MQTT messages.
 *
 * Nodes publish nearly everything retained, so the broker keeps the last value of every topic and
 * hands it to each new subscriber - which is how a dashboard can show a reading straight away
 * instead of waiting for the next one. The cost is that a topic published by mistake outlives the
 * mistake: rename a module, misspell a field, test a node with the wrong id, and that topic stays
 * on the broker for ever, appearing on every dashboard. Restarting the broker does not clear it and
 * neither does fixing the node. The only way to remove one is to publish an empty message to that
 * exact topic, which is what this does.
 *
 * Run from the server's own directory, the one holding frugal-iot.db, so that the organization's
 * broker password can be read from config.d/organizations/.
 *
 * Usage:
 *   npx --no frugal-iot-clearretained '<topic-pattern>'          # list what is retained
 *   npx --no frugal-iot-clearretained '<topic-pattern>' delete   # delete it
 *
 * Quote the pattern, or the shell expands the wildcards before this ever sees them. In MQTT
 * patterns "+" matches exactly one level and "#" matches the rest:
 *   'myfarm/#'                          everything the organization holds - look before deleting
 *   'myfarm/lotus/esp8266-fb94bb/#'     one node
 *   'myfarm/lotus/+/sht/temperture/#'   a misspelled field, on every node in the project
 *
 * "delete" is a bare word rather than "--delete" because npm parses the whole command line of an
 * "npx" invocation itself: it treats any --flag it does not recognise as an unknown config setting
 * and passes only the values on, so "--delete" would silently never reach this script and it would
 * quietly list instead of deleting. "--delete" is still accepted for running it directly.
 *
 * This talks to the broker through the "mqtt" library rather than mosquitto_sub and mosquitto_pub,
 * so it works anywhere the server itself runs. On the production server those commands cannot be
 * installed at all: its broker came from the mosquitto PPA built for an older Ubuntu, and the
 * mosquitto-clients in the distribution demand an exactly-matching libmosquitto1, so apt would have
 * to downgrade the library out from under the running broker.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import mqtt from 'mqtt';

const SCRIPT = 'frugal-iot-clearretained';

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(`Usage: ${SCRIPT} '<topic-pattern>' [delete] [--host H] [--port N] [--user U] [--password P] [--wait S]`);
  console.error(`Example: ${SCRIPT} 'myfarm/lotus/+/sht/temperture/#'`);
  console.error(`         ${SCRIPT} 'myfarm/lotus/+/sht/temperture/#' delete`);
  process.exit(1);
}

// ---- arguments ----
const opts = { host: 'localhost', port: 1883, user: null, password: null, wait: 3 };
let pattern = null;
let doDelete = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '--delete': doDelete = true; break;
    case '--host': opts.host = argv[++i]; break;
    case '--port': opts.port = Number(argv[++i]); break;
    case '--user': opts.user = argv[++i]; break;
    case '--password': opts.password = argv[++i]; break;
    case '--wait': opts.wait = Number(argv[++i]); break;
    default:
      if (a.startsWith('-')) usage(`unknown option '${a}'`);
      else if (pattern === null) pattern = a;
      else if (a === 'delete') doDelete = true;
      else usage(`unexpected argument '${a}'`);
  }
}
if (!pattern) usage('no topic pattern given');

// A bare "#" would be every topic on the broker, across every organization. Almost always a
// mistake, and the one case where a slip is unrecoverable, so it is not accepted at all.
if (pattern === '#' || pattern === '+/#') {
  console.error(`Error: refusing the pattern '${pattern}' - that is every topic on the broker.`);
  console.error("Name the organization at least, as in 'myfarm/#'.");
  process.exit(1);
}

// ---- credentials ----
// The broker requires them, and the organization's are in its config file - the same place the
// server reads them from. The first element of the topic pattern is the organization.
if (!opts.user) {
  opts.user = pattern.split('/')[0];
  const configFile = `config.d/organizations/${opts.user}.yaml`;
  let parsed;
  try {
    parsed = yaml.load(readFileSync(configFile, 'utf8'));
  } catch (e) {
    console.error(`Error: cannot read ${configFile} (${e.code || e.message}), so the broker password`);
    console.error(`for '${opts.user}' cannot be found. Run this from the server's own directory, or`);
    console.error('give credentials with --user and --password.');
    process.exit(1);
  }
  opts.password = parsed && parsed.mqtt_password;
  if (!opts.password) {
    console.error(`Error: no mqtt_password in ${configFile}`);
    process.exit(1);
  }
}

// ---- collect what is retained ----
console.log(`Looking for retained messages matching '${pattern}' on ${opts.host}:${opts.port} as ${opts.user} ...`);

const client = mqtt.connect(`mqtt://${opts.host}:${opts.port}`, {
  username: opts.user,
  password: opts.password,
  connectTimeout: 5000,
  // A fresh session every time: we want the retained messages delivered on subscribe, not a
  // continuation of some earlier one.
  clean: true,
});

const topics = new Set();

client.on('error', (err) => {
  // ECONNREFUSED arrives with an empty message, so fall back to the code - otherwise this prints
  // "Error:" and nothing, which says neither "wrong password" nor "nothing listening there".
  console.error(`Error: could not talk to the broker: ${err.message || err.code || err}`);
  client.end(true);
  process.exit(1);
});

client.on('message', (topic, _payload, packet) => {
  // Only messages the broker had already kept. A node reporting normally while we listen arrives
  // with the retain flag clear, and clearing that would be removing something nobody asked us to.
  if (packet.retain) topics.add(topic);
});

client.on('connect', () => {
  client.subscribe(pattern, { qos: 0 }, (err) => {
    if (err) {
      console.error(`Error: could not subscribe to '${pattern}': ${err.message}`);
      client.end(true);
      process.exit(1);
    }
    // Retained messages arrive immediately on subscribing, so this only has to cover the round
    // trip; a busy broker on a slow Pi may want more, hence --wait.
    setTimeout(finish, opts.wait * 1000);
  });
});

async function finish() {
  const list = [...topics].sort();
  if (list.length === 0) {
    console.log('Nothing retained matches that pattern.');
    client.end();
    return;
  }
  for (const t of list) console.log(`  ${t}`);
  console.log(`${list.length} retained topic(s).`);

  if (!doDelete) {
    console.log('');
    console.log(`Nothing has been changed. To delete these, run the same command again with "delete"`);
    console.log('as the last word.');
    client.end();
    return;
  }

  // Deleting one means publishing a zero-length retained message to it, which is how MQTT spells
  // "forget this". At QoS 1 so the broker acknowledges each rather than dropping it under load.
  console.log(`Deleting ${list.length} retained topic(s) ...`);
  let failed = 0;
  for (const t of list) {
    try {
      await new Promise((resolve, reject) => {
        client.publish(t, '', { retain: true, qos: 1 }, (err) => (err ? reject(err) : resolve()));
      });
      console.log(`  cleared ${t}`);
    } catch (e) {
      console.error(`  FAILED  ${t}: ${e.message}`);
      failed++;
    }
  }
  console.log('');
  console.log('Done. Run the same command without "delete" - it should report nothing.');
  console.log('If a topic comes back, a node is still publishing it: fix or restart the node, then re-run.');
  // A bridged broker forwards these deletions to the other end, so clearing here clears there too.
  client.end(false, {}, () => process.exit(failed ? 1 : 0));
}
