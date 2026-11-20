#!/usr/bin/env node
/*
 * Settings a release's configuration file has that this installation's copy does not - so that a
 * new one (e.g. mcplog in server.yaml) is mentioned at an upgrade instead of passing silently.
 *
 *   node settings-missing.js <packaged file> <local file>
 *
 * Prints one dotted path per line, e.g. "mcplog" or "housekeeping.freespacepercent", and nothing
 * when there are none. Only what is MISSING, never what differs: an installation's own values are
 * meant to differ, and a note on every upgrade would be read once and skipped from then on. A whole
 * new section is reported once, not once per key inside it. Run by scripts/init.zsh, which already
 * keeps the local file untouched - the server uses its default for anything not set.
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const [packaged, local] = process.argv.slice(2);
const load = (f) => yaml.load(readFileSync(f, 'utf8')) || {};
const isMap = (x) => x && typeof x === 'object' && !Array.isArray(x);

export function missing(theirs, ours, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(theirs)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!isMap(ours) || !(k in ours)) out.push(path);
    else if (isMap(v) && isMap(ours[k])) out.push(...missing(v, ours[k], path));
  }
  return out;
}

if (packaged && local) {
  try {
    const found = missing(load(packaged), load(local));
    if (found.length) console.log(found.join('\n'));
  } catch (err) {
    // Never fail an install over a note: an unreadable file is reported and the install goes on
    console.error(`  (could not compare ${local} with ${packaged}: ${err.message})`);
  }
}
