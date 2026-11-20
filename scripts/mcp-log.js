#!/usr/bin/env node
/*
 * What Claude has been asking this server through /mcp, from the call log (lib/mcp-log.js) - which
 * tools, which calls were refused and why, which were slow or read far more than they returned.
 * That is the list of what to improve in the tools and in GET /api/data (issue #44, phase 5).
 *
 *   npx --no frugal-iot-mcp-log              the last 7 days
 *   npx --no frugal-iot-mcp-log <days>       the last <days> days
 *   npx --no frugal-iot-mcp-log <days> raw   every call, one line each, oldest first
 *
 * Run from the server's own directory; the log is where config.d/server.yaml's mcplog.dir says,
 * ./logs/mcp by default. It names users and what they looked at, so it is read here and never served.
 *
 * Positional arguments, no flags: npm swallows any --flag it does not recognise. See the npx note
 * in claude.md.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { DEFAULT_DIR } from '../lib/mcp-log.js';

const [daysArg = '7', mode = ''] = process.argv.slice(2);
const days = Number(daysArg);
if (!Number.isInteger(days) || days < 1 || !['', 'raw'].includes(mode)) {
  console.error('Usage: npx --no frugal-iot-mcp-log [days] [raw]');
  process.exit(1);
}

let dir = DEFAULT_DIR;
try {
  const server = yaml.load(readFileSync('config.d/server.yaml', 'utf8')) || {};
  if (server.mcplog && server.mcplog.dir) dir = server.mcplog.dir;
} catch { /* not in the server's directory, or no setting: the default */ }

const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
let files;
try {
  files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since).sort();
} catch {
  console.log(`No MCP call log in ${dir} - nothing has been asked yet, or this is not the server's directory`);
  process.exit(0);
}
const calls = [];
for (const f of files) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    try { calls.push(JSON.parse(line)); } catch { /* a line cut short by a crash */ }
  }
}
if (!calls.length) { console.log(`No calls since ${since}`); process.exit(0); }

const brief = (c) => `${c.time.slice(0, 16).replace('T', ' ')} ${c.username || c.user} ${c.tool} ${JSON.stringify(c.args)}`;

if (mode === 'raw') {
  for (const c of calls) {
    const read = c.read ? ` read ${JSON.stringify(c.read)}` : '';
    console.log(`${brief(c)} -> ${c.ok ? 'ok' : c.error} ${c.ms}ms${read}${c.returned !== undefined ? ` returned ${c.returned}` : ''}`);
  }
  process.exit(0);
}

const count = (key) => {
  const m = new Map();
  for (const c of calls) { const k = key(c); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const section = (title, rows) => {
  console.log(`\n${title}`);
  if (!rows.length) console.log('  none');
  for (const r of rows) console.log(`  ${r}`);
};

console.log(`${calls.length} calls since ${since}, by ${new Set(calls.map((c) => c.user)).size} users`);
section('By tool', count((c) => c.tool).map(([k, n]) => `${String(n).padStart(5)}  ${k}`));
section('By user', count((c) => `${c.username || c.user} (${c.via})`).map(([k, n]) => `${String(n).padStart(5)}  ${k}`));
// The improvement list: what was asked for and refused. too_much_data is the one to read closely -
// it is a question the tools could not answer in one go.
section('Refused, by reason', count((c) => (c.ok ? null : `${c.tool}: ${c.error} - ${c.message}`))
  .filter(([k]) => k).map(([k, n]) => `${String(n).padStart(5)}  ${k}`));
section('Slowest', [...calls].sort((a, b) => b.ms - a.ms).slice(0, 10).map((c) => `${String(c.ms).padStart(6)}ms  ${brief(c)}`));
// Lots read, little returned: a question the server answers by reading far more than it needs to -
// the case for keeping per-day summaries (plan section 7) if it shows up often
section('Most read per value returned', calls
  .filter((c) => c.read && c.read.readings && c.returned)
  .map((c) => ({ c, ratio: c.read.readings / c.returned }))
  .sort((a, b) => b.ratio - a.ratio).slice(0, 10)
  .map(({ c, ratio }) => `${String(Math.round(ratio)).padStart(6)}x  ${c.read.readings} read, ${c.returned} returned  ${brief(c)}`));
