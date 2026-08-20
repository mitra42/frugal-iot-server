#!/usr/bin/env node
/*
 * Warn about things in a sensor schema that are easy to get wrong and expensive to get wrong.
 *
 * It only warns - it never changes anything. Each of these needs somebody to decide what the right
 * value is for that particular sensor, and a script guessing would be worse than a script asking.
 *
 * What it looks for:
 *
 *  - A topic that does not say whether it is logged. With no "log" setting, any float, int or bool
 *    with "rw: r" is recorded and anything else is not, which is easy to be surprised by in either
 *    direction - a sensor silently not recorded, or one recorded that nobody wanted.
 *
 *  - A logged topic with no "duplicates" rule. Without one, every reading that arrives is written
 *    to disk as it arrives. On a server running from an SD card that wears the card out, and it
 *    fills the disk with readings that mostly repeat the one before.
 *
 *  - A "duplicates" rule that cannot do anything, because it sets neither significantvalue nor
 *    significantdate.
 *
 *  - A module topic overriding a field that its topic does not define, which is usually a
 *    misspelling.
 *
 * Usage:
 *   node scripts/check-schema.js                     # checks ./config.d/schema
 *   node scripts/check-schema.js <dir> [<dir> ...]   # each dir holding topics.yaml and modules.yaml
 *
 * Exits 0 whatever it finds, so it can run from a prerelease script without blocking a release for
 * something that may well be deliberate. Exits 1 only if it could not read a schema at all.
 */

import yaml from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// The types the logger records when a topic does not say - keep in step with shouldLog() in
// frugal-iot-logger/index.js
const TYPES_LOGGED_BY_DEFAULT = ['float', 'int', 'bool'];

function loadYaml(file) {
  if (!existsSync(file)) return null;
  return yaml.load(readFileSync(file, 'utf8')) || {};
}

/*
 * Check one directory holding topics.yaml and (optionally) modules.yaml.
 * Returns an array of warning strings.
 */
function checkSchemaDir(dir) {
  const topics = loadYaml(path.join(dir, 'topics.yaml'));
  if (topics === null) return [`${dir}/topics.yaml does not exist`];
  const modules = loadYaml(path.join(dir, 'modules.yaml')) || {};
  const warnings = [];

  for (const [name, topic] of Object.entries(topics)) {
    if (!topic || (typeof topic !== 'object')) {
      warnings.push(`topic "${name}" is not a set of settings`);
      continue;
    }
    // Whether it is logged, and whether that was actually stated
    const wouldBeLogged = TYPES_LOGGED_BY_DEFAULT.includes(topic.type) && (topic.rw === 'r');
    if (topic.log === undefined) {
      warnings.push(`topic "${name}" does not say whether it is logged`
        + ` - with type "${topic.type}" and rw "${topic.rw}" it ${wouldBeLogged ? 'IS' : 'is not'} recorded.`
        + ` Add "log: ${wouldBeLogged}" if that is what you want.`);
    }
    const logged = (topic.log === undefined) ? wouldBeLogged : topic.log;
    if (logged && !topic.duplicates) {
      warnings.push(`topic "${name}" is logged but has no "duplicates" rule, so every reading is`
        + ` written to disk as it arrives. Add significantvalue (how far it has to move) and`
        + ` significantdate (how long since the last one, in milliseconds).`);
    }
    if (topic.duplicates
        && (topic.duplicates.significantvalue === undefined)
        && (topic.duplicates.significantdate === undefined)) {
      warnings.push(`topic "${name}" has a "duplicates" rule setting neither significantvalue nor`
        + ` significantdate, so it does nothing`);
    }
  }

  // A module topic can override any field of the topic it is built from. A field the topic does not
  // have is usually a spelling mistake, and one that quietly does nothing.
  for (const [moduleName, module] of Object.entries(modules)) {
    for (const topic of ((module && module.topics) || [])) {
      const from = topic.leaf_from || topic.leaf;
      const base = topics[from];
      if (!base) {
        warnings.push(`module "${moduleName}" has topic "${topic.leaf}" built from "${from}",`
          + ` which is not in topics.yaml`);
        continue;
      }
      for (const field of Object.keys(topic)) {
        if (['leaf', 'leaf_from', 'name'].includes(field)) continue; // Always local to the module
        if (base[field] === undefined) {
          warnings.push(`module "${moduleName}" topic "${topic.leaf}" sets "${field}", which`
            + ` "${from}" in topics.yaml does not have - a misspelling?`);
        }
      }
    }
  }
  return warnings;
}

const dirs = (process.argv.length > 2) ? process.argv.slice(2) : ['config.d/schema'];
let unreadable = 0;
let total = 0;

for (const dir of dirs) {
  const warnings = checkSchemaDir(dir);
  if ((warnings.length === 1) && warnings[0].endsWith('does not exist')) {
    console.error(`${dir}: ${warnings[0]}`);
    unreadable++;
    continue;
  }
  if (!warnings.length) {
    console.log(`${dir}: nothing to report`);
    continue;
  }
  console.log(`${dir}: ${warnings.length} thing(s) worth a look`);
  for (const w of warnings) console.log(`  ${w}`);
  total += warnings.length;
}

if (total) {
  console.log(`\n${total} warning(s) - these are for you to decide about, nothing has been changed.`);
}
process.exit(unreadable ? 1 : 0);
