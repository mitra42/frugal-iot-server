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
 *  - A float or exponential topic with no "width", or one too small to hold its own min..max. Width
 *    is what decides how many decimals a reading is shown to; without it the UI guesses.
 *
 *  - A numeric topic with no "units". Often right - plenty of readings are dimensionless - but
 *    worth a look, because the UI has nothing to put after the number. The topics that are
 *    deliberately dimensionless are listed in UNITS_EXEMPT below, and are not mentioned.
 *
 * And, separately, things that are never deliberate and so count as errors:
 *
 *  - A devices.yaml entry naming a module, or a leaf within a module, that does not exist. That
 *    silently loses a row from a card, with nothing to say why.
 *
 * Usage:
 *   node scripts/check-schema.js                     # checks ./config.d/schema
 *   node scripts/check-schema.js <dir> [<dir> ...]   # each dir holding topics.yaml and modules.yaml
 *   node scripts/check-schema.js -q <dir>            # say nothing unless there is something to say
 *   node scripts/check-schema.js --resolve <otakey>  # which devices.yaml entry that OTA key uses
 *
 * -q (--quiet) prints nothing at all when a schema is clean, so it can run from a release script
 * without burying the one line that matters. Warnings and errors print exactly as they otherwise
 * would, and the exit code is the same either way.
 *
 * Exits 0 for warnings, so it can run from a prerelease script without blocking a release for
 * something that may well be deliberate. Exits 1 for an error, or if it could not read a schema.
 * Both callers guard it with "|| true", so neither blocks on either.
 */

import yaml from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// The types the logger records when a topic does not say - keep in step with shouldLog() in
// frugal-iot-logger/index.js
const TYPES_LOGGED_BY_DEFAULT = ['float', 'int', 'bool'];
// The types with decimals to decide, and so the ones that need a width
const NUMERIC_TYPES = ['float', 'exponential'];
/*
 * Topics that are dimensionless on purpose, so "no units" is the right answer rather than
 * something to look at. Without this the same three warnings appear at every release, which is
 * exactly how a real one comes to be skimmed past. Add a name here only once you are sure the
 * reading genuinely has no unit - not because you have not decided yet.
 */
const UNITS_EXEMPT = [
  'controlfloat',   // a control's value, in whatever the thing it controls is measured in
  'hdop',           // dilution of precision - a ratio
  'loadcell',       // raw ADC counts until a calibration turns them into grams
];

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
  if (topics === null) return { warnings: [`${dir}/topics.yaml does not exist`], errors: [], missing: true };
  const modules = loadYaml(path.join(dir, 'modules.yaml')) || {};
  const devices = loadYaml(path.join(dir, 'devices.yaml')) || {};
  const warnings = [];
  const errors = [];

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
    // Width decides the decimals a reading is shown to, derived as width - intWidth - 1 where
    // intWidth comes from min..max. Only a float has decimals to decide.
    const hasDecimals = NUMERIC_TYPES.includes(topic.type);
    if (hasDecimals && (topic.width === undefined)) {
      warnings.push(`topic "${name}" is a ${topic.type} with no "width", so the UI has to guess how`
        + ` many decimals to show. Width counts every character including the sign and the point.`);
    }
    if (!hasDecimals && (topic.width !== undefined)) {
      warnings.push(`topic "${name}" is a ${topic.type}, which has no decimals, so "width" does nothing`);
    }
    if (hasDecimals && (topic.width !== undefined)) {
      const intWidth = Math.max(String(Math.trunc(topic.min ?? 0)).length,
                                String(Math.trunc(topic.max ?? 0)).length);
      if (topic.width < intWidth) {
        warnings.push(`topic "${name}" has width ${topic.width} but its range needs ${intWidth}`
          + ` characters before any decimal point, so values will overflow it`);
      }
    }
    if (hasDecimals && (topic.units === undefined) && !UNITS_EXEMPT.includes(name)) {
      warnings.push(`topic "${name}" has no "units" - fine if it is dimensionless, but the UI has`
        + ` nothing to put after the number`);
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
  // A device entry picks the rows on a card, by twig (module/leaf) or by bare control module id.
  // Naming something that does not exist loses a row silently, so these are errors not warnings.
  for (const [key, device] of Object.entries(devices)) {
    for (const listName of ['front', 'summary']) {
      for (const entry of ((device && device[listName]) || [])) {
        const [moduleName, leaf] = entry.split('/');
        const module = modules[moduleName];
        if (!module) {
          errors.push(`devices "${key}" ${listName} names module "${moduleName}", which is not in modules.yaml`);
        } else if (leaf !== undefined) {
          const leaves = ((module.topics) || []).map((t) => t.leaf);
          if (!leaves.includes(leaf)) {
            errors.push(`devices "${key}" ${listName} names "${entry}", but module "${moduleName}"`
              + ` has ${leaves.length ? leaves.join(', ') : 'no leaves'}`);
          }
        } else if (!moduleName.startsWith('control')) {
          warnings.push(`devices "${key}" ${listName} names module "${moduleName}" with no leaf.`
            + ` Only a control module renders as a whole - did you mean a "${moduleName}/leaf" twig?`);
        }
      }
    }
    // Longest match wins, so this is not a fault - but it is worth knowing which entry a key lands on
    const shadowed = Object.keys(devices).filter((k) => (k !== key) && k.startsWith(key));
    if (shadowed.length) {
      warnings.push(`devices "${key}" is also a prefix of ${shadowed.join(', ')}; the longest match`
        + ` wins, so those take precedence for their own keys`);
    }
  }

  // summary is opt-out - a module contributes unless it says otherwise
  for (const [moduleName, module] of Object.entries(modules)) {
    if (module && (module.summary === true)) {
      warnings.push(`module "${moduleName}" sets "summary: true", which is already the default -`
        + ` only "summary: false" does anything`);
    }
  }

  return { warnings, errors };
}

// Which devices.yaml entry an OTA key uses: exact device id, then exact key, then longest prefix.
function resolveDeviceEntry(devices, otakey) {
  if (devices[otakey]) return [otakey, 'an exact match'];
  const prefixes = Object.keys(devices).filter((k) => otakey.startsWith(k));
  if (!prefixes.length) return [null, 'no match, so the defaults apply'];
  const longest = prefixes.sort((a, b) => b.length - a.length)[0];
  return [longest, prefixes.length > 1 ? `the longest of ${prefixes.length} matching prefixes` : 'a prefix'];
}

const argv = process.argv.slice(2);
const quiet = argv.includes('-q') || argv.includes('--quiet');
const resolveAt = argv.indexOf('--resolve');
if (resolveAt !== -1) {
  const otakey = argv[resolveAt + 1];
  const dir = argv.find((a, i) => !a.startsWith('--') && (i !== resolveAt + 1)) || 'config.d/schema';
  if (!otakey) {
    console.error('--resolve needs an OTA key, e.g. --resolve sht30_c3_pico');
    process.exit(1);
  }
  const devices = loadYaml(path.join(dir, 'devices.yaml')) || {};
  const [entry, how] = resolveDeviceEntry(devices, otakey);
  console.log(`${otakey} uses ${entry ? `the "${entry}" entry` : 'no entry'} (${how})`);
  process.exit(0);
}

const named = argv.filter((a) => !a.startsWith('-'));
const dirs = named.length ? named : ['config.d/schema'];
let unreadable = 0;
let totalWarnings = 0;
let totalErrors = 0;

for (const dir of dirs) {
  const { warnings, errors, missing } = checkSchemaDir(dir);
  if (missing) {
    console.error(`${dir}: ${warnings[0]}`);
    unreadable++;
    continue;
  }
  if (!warnings.length && !errors.length) {
    // Under -q a clean schema says nothing, so whatever a release script does print is a finding
    if (!quiet) console.log(`${dir}: nothing to report`);
    continue;
  }
  if (warnings.length) {
    console.log(`${dir}: ${warnings.length} thing(s) worth a look`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (errors.length) {
    console.log(`${dir}: ${errors.length} thing(s) that cannot be right`);
    for (const e of errors) console.log(`  ERROR ${e}`);
  }
  totalWarnings += warnings.length;
  totalErrors += errors.length;
}

if (totalWarnings) {
  console.log(`\n${totalWarnings} warning(s) - these are for you to decide about, nothing has been changed.`);
}
if (totalErrors) {
  console.log(`${totalErrors} error(s) - a card will silently lose a row until these are fixed.`);
}
process.exit((unreadable || totalErrors) ? 1 : 0);
