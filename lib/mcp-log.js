/**
 * A record of every MCP tool call (issue #44, phase 5) - how the tools and GET /api/data get improved.
 *
 * MCP shows the server what Claude asks for, not what the user asked Claude, so this is the only
 * evidence of which questions the tools answer badly: a call refused as too_much_data, a slow one,
 * one that returned little after reading a lot, the same tool called over and over to assemble one
 * answer. It is also a record of what people are looking at, so:
 *
 *   - never served - read on the machine by whoever runs it (scripts/mcp-log.js summarises it)
 *   - not under datadir, which IS served, at /data
 *   - a directory only the server's own user can read
 *   - kept KEEP_DAYS and then deleted, by the same timer that writes it
 *
 * One file per UTC day, logs/mcp/YYYY-MM-DD.jsonl, one JSON object per line:
 *   { time, user, username, via, tool, args, ms, ok, error?, message?, read?, returned? }
 * via is "token:<name>" or "session". read is { topics, files, readings } from lib/data-query.js;
 * returned is how many values went back. Never a token or a password.
 *
 * Written as it happens rather than batched: a call is a person waiting on Claude, so there are tens
 * a day, not the thousands of readings that make the logger batch its writes to spare an SD card.
 */

import { appendFile, mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';

export const DEFAULT_DIR = './logs/mcp';
export const KEEP_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_ARG_CHARS = 2000; // a call's arguments as logged, so one odd call cannot make a huge line

/*
 * { record(entry), prune() } for a directory. config is server.yaml's mcplog: { dir, keepdays,
 * enabled }; enabled: false gives a recorder that does nothing. Failures are reported and never
 * thrown - losing a log line is never worth failing someone's question over.
 */
export function createMcpLog(config = {}, { now = Date.now } = {}) {
  if (config.enabled === false) return { record: async () => {}, prune: async () => 0, dir: null };
  const dir = config.dir || DEFAULT_DIR;
  const keepDays = Math.max(1, Number(config.keepdays) || KEEP_DAYS);
  let made = false;

  async function record(entry) {
    try {
      if (!made) { await mkdir(dir, { recursive: true, mode: 0o700 }); made = true; }
      const t = now();
      let args = JSON.stringify(entry.args === undefined ? {} : entry.args);
      if (args.length > MAX_ARG_CHARS) args = JSON.stringify(`${args.slice(0, MAX_ARG_CHARS)}...`);
      const line = JSON.stringify({ time: new Date(t).toISOString(), ...entry, args: JSON.parse(args) });
      await appendFile(join(dir, `${new Date(t).toISOString().slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 });
    } catch (err) {
      console.error('MCP log: could not record a call -', err.message);
    }
  }

  // Delete days older than keepDays. Returns how many files went.
  async function prune() {
    let files;
    try { files = await readdir(dir); } catch { return 0; }
    const cutoff = now() - keepDays * DAY_MS;
    let removed = 0;
    for (const f of files) {
      const m = FILE.exec(f);
      if (!m || Date.parse(`${m[1]}T00:00:00Z`) + DAY_MS > cutoff) continue;
      try { await unlink(join(dir, f)); removed++; } catch (err) { console.error('MCP log: could not delete', f, '-', err.message); }
    }
    return removed;
  }

  return { record, prune, dir };
}

// Prune now and once a day. The timer never keeps the server alive on its own.
export function startMcpLogPruning(log) {
  if (!log.dir) return null;
  log.prune();
  const timer = setInterval(() => log.prune(), DAY_MS);
  timer.unref();
  return timer;
}
