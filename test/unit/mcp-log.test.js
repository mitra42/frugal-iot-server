/**
 * The MCP call log (lib/mcp-log.js): one line per call in a file per UTC day, private, pruned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMcpLog } from '../../lib/mcp-log.js';

const T = Date.parse('2026-11-20T10:00:00Z');
const DAY = 86400000;

describe('MCP call log', () => {
  let dir;
  beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'mcplog-')), 'mcp'); });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('appends one JSON line per call to the day\'s file, readable by the server only', async () => {
    const log = createMcpLog({ dir }, { now: () => T });
    await log.record({ user: 2, tool: 'get_series', args: { devices: ['dev/lotus/a'] }, ok: true, ms: 5 });
    await log.record({ user: 2, tool: 'list_scope', args: {}, ok: false, error: 'busy' });
    const lines = readFileSync(join(dir, '2026-11-20.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ time: '2026-11-20T10:00:00.000Z', user: 2, tool: 'get_series', args: { devices: ['dev/lotus/a'] } });
    expect(lines[1].error).toBe('busy');
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, '2026-11-20.jsonl')).mode & 0o077).toBe(0);
  });

  it('cuts down huge arguments rather than writing them whole', async () => {
    const log = createMcpLog({ dir }, { now: () => T });
    await log.record({ tool: 'get_series', args: { devices: Array(500).fill('dev/lotus/a-very-long-node-name/sht/temperature') } });
    const line = JSON.parse(readFileSync(join(dir, '2026-11-20.jsonl'), 'utf8'));
    expect(typeof line.args).toBe('string');
    expect(line.args.length).toBeLessThan(2100);
  });

  it('deletes days older than keepdays, and nothing else', async () => {
    const log = createMcpLog({ dir, keepdays: 90 }, { now: () => T });
    await log.record({ tool: 'x' });
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    writeFileSync(join(dir, `${day(T - 91 * DAY)}.jsonl`), '{}\n');
    writeFileSync(join(dir, `${day(T - 89 * DAY)}.jsonl`), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    expect(await log.prune()).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${day(T - 89 * DAY)}.jsonl`, '2026-11-20.jsonl', 'notes.txt']);
  });

  it('enabled: false records nothing', async () => {
    const log = createMcpLog({ dir, enabled: false });
    await log.record({ tool: 'x' });
    expect(() => readdirSync(dir)).toThrow();
  });

  it('a failure to write is reported, never thrown', async () => {
    writeFileSync(join(dir, '..', 'blocker'), 'x');
    const log = createMcpLog({ dir: join(dir, '..', 'blocker', 'mcp') });
    await expect(log.record({ tool: 'x' })).resolves.toBeUndefined();
  });
});
