/**
 * /mcp (lib/mcp.js, issue #44): the MCP protocol end to end through the SDK, and what each tool
 * answers. A real LoggerClient around a stand-in logger, and readings in a temporary data directory.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMcpRouter, timeBeyond, localIso } from '../../lib/mcp.js';
import { createLoggerClient } from '../../lib/logger-client.js';

const DAY = Date.parse('2026-09-24T00:00:00Z');
const H = 3600000;

describe('/mcp', () => {
  let app, dir, user;
  const put = (topic, rows) => {
    const d = join(dir, ...topic.split('/'));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '2026-09-24.csv'), rows.map(([t, v]) => `${t},"${v}"`).join('\n') + '\n');
  };
  const rpc = (method, params, id = 1) => request(app).post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id, method, params });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    expect(r.status).toBe(200);
    const result = r.body.result;
    return { isError: !!result.isError, body: JSON.parse(result.content[0].text) };
  };
  const may = (org, project, ...caps) => caps.map((capability) => ({ capability, org, project }));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    // a: 20 for an hour, 35 for two hours, back to 20. b: always 30. c is in another project.
    put('dev/lotus/a/sht/temperature', [[DAY, 20], [DAY + H, 35], [DAY + 2 * H, 36], [DAY + 3 * H, 20]]);
    put('dev/lotus/a/sht/humidity', [[DAY, 60], [DAY + H, 70]]);
    put('dev/lotus/b/sht/temperature', [[DAY, 30], [DAY + H, 30]]);
    put('dev/magi/c/sht/temperature', [[DAY, 40]]);
    const mqttLogger = {
      flush: (cb) => cb(),
      reportNodes: () => ({ dev: { lotus: { a: { lastseen: new Date(DAY + 3 * H).toISOString(), 'frugal_iot/name': 'Alpha' } } } }),
      getNodeState: (org, project, node) => (node === 'a'
        ? { 'sht/temperature': { value: 20, max: 30, min: 10 }, 'sht/humidity': { value: 70 } }
        : {}),
      clients: {
        dev: {
          schemaModule: (module) => (module === 'sht'
            ? { name: 'SHT30', fields: [{ field: 'temperature', name: 'Temperature', units: 'Cel', type: 'float', rw: 'r', min: 0, max: 50 },
              { field: 'humidity', name: 'Humidity', units: '%RH', type: 'float', rw: 'r' }] }
            : { name: module, fields: [] }),
        },
      },
    };
    app = express();
    app.use((req, res, next) => { req.isAuthenticated = () => !!user; req.user = user; next(); });
    app.use(express.json());
    app.use('/mcp', createMcpRouter({
      db: null, dataDir: dir, loggerClient: createLoggerClient(mqttLogger),
      organizations: () => ({ dev: { name: 'Development' } }),
    }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    user = { id: 2, permissions: [...may('dev', 'lotus', 'MCP', 'READ'), ...may('dev', 'magi', 'READ')] };
  });

  describe('the protocol', () => {
    it('initializes, with instructions explaining the data', async () => {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(r.status).toBe(200);
      expect(r.body.result.serverInfo.name).toBe('frugal-iot');
      expect(r.body.result.instructions).toMatch(/organization \/ project \/ node \/ module \/ field/);
    });
    it('lists the read-only tools', async () => {
      const r = await rpc('tools/list', {});
      const tools = r.body.result.tools;
      expect(tools.map((t) => t.name).sort()).toEqual(['describe_node', 'get_series', 'graph_link', 'list_scope', 'summarize_field']);
      expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    });
    it('POST only', async () => {
      expect((await request(app).get('/mcp')).status).toBe(405);
    });
    it('needs a login or a token', async () => {
      user = null;
      expect((await rpc('tools/list', {})).status).toBe(401);
    });
    it('refuses a login with MCP nowhere, even one that may READ', async () => {
      user = { id: 3, permissions: may('dev', undefined, 'READ') };
      expect((await rpc('tools/list', {})).status).toBe(403);
    });
  });

  describe('list_scope', () => {
    it('only the projects with MCP and READ, with nodes live or on disk', async () => {
      const { body } = await call('list_scope', {});
      expect(body.organizations).toHaveLength(1);
      expect(body.organizations[0].name).toBe('Development');
      expect(body.organizations[0].projects.map((p) => p.project)).toEqual(['dev/lotus']);
      const nodes = body.organizations[0].projects[0].nodes;
      expect(nodes.map((n) => n.node)).toEqual(['dev/lotus/a', 'dev/lotus/b']);
      expect(nodes[0]).toMatchObject({ name: 'Alpha', has_recorded_data: true });
    });
  });

  describe('describe_node', () => {
    it('fields with units, current value, configured thresholds and recorded days', async () => {
      const { body } = await call('describe_node', { node: 'dev/lotus/a' });
      expect(body.name).toBe('Alpha');
      expect(body.modules.sht.name).toBe('SHT30');
      expect(body.modules.sht.fields.temperature).toEqual({
        name: 'Temperature', units: 'Cel', type: 'float', current: 20,
        configured: { min: 10, max: 30 }, gauge_range: { min: 0, max: 50 },
        recorded: { first_day: '2026-09-24', last_day: '2026-09-24', days: 1 },
      });
    });
    it('a project without MCP is refused', async () => {
      const r = await call('describe_node', { node: 'dev/magi/c' });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('not_allowed');
    });
  });

  describe('get_series', () => {
    it('buckets, as rows under columns, in local time', async () => {
      const { body } = await call('get_series', {
        devices: ['dev/lotus/a/sht/temperature'], from: String(DAY), to: String(DAY + 4 * H - 1), bucket: '2h', agg: 'mean,count', tz: 'Asia/Kolkata',
      });
      expect(body.tz).toBe('Asia/Kolkata');
      expect(body.series).toHaveLength(1);
      expect(body.series[0]).toMatchObject({ device: 'dev/lotus/a', field: 'sht/temperature', units: 'Cel', columns: ['time', 'mean', 'count'] });
      // Two-hour buckets start on even local hours: 05:30 local is 00:00 UTC, in the 04:00 bucket
      expect(body.series[0].rows[0]).toEqual(['2026-09-24T04:00:00+05:30', 20, 1]);
    });
    it('a project reached by "+" without MCP is left out', async () => {
      const { body } = await call('get_series', { devices: ['dev/+/+/sht/temperature'], from: String(DAY) });
      expect(body.series.map((s) => s.device)).toEqual(['dev/lotus/a', 'dev/lotus/b']);
    });
    it('too much is an error saying what to change', async () => {
      const r = await call('get_series', { devices: ['dev/lotus/a'], from: String(DAY - 365 * 24 * H), bucket: '1m' });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe('too_much_data');
      expect(r.body.message).toMatch(/larger bucket/);
    });
  });

  describe('summarize_field', () => {
    it('stats per node, and time above the configured max', async () => {
      const { body } = await call('summarize_field', { devices: ['dev/lotus/+/sht/temperature'], from: String(DAY), to: String(DAY + 4 * H) });
      const [a, b] = body.fields;
      expect(a).toMatchObject({ device: 'dev/lotus/a', readings: 4, mean: 27.75, max: { value: 36 }, configured: { min: 10, max: 30 } });
      expect(a.above).toMatchObject({ threshold: 30, from: 'configured max', readings: 2, hours: 2 });
      expect(a.above.longest).toMatchObject({ hours: 2, start: '2026-09-24T01:00:00Z', end: '2026-09-24T03:00:00Z' });
      expect(b.above).toBeUndefined(); // b has no configured max
    });
    it('a threshold can be given instead', async () => {
      const { body } = await call('summarize_field', { devices: ['dev/lotus/b/sht/temperature'], from: String(DAY), to: String(DAY + 2 * H), above: 25 });
      expect(body.fields[0].above).toMatchObject({ threshold: 25, from: 'asked', readings: 2, hours: 2 });
    });
  });

  describe('graph_link', () => {
    it('a link to the graph page on this server, carrying the selection', async () => {
      const { body } = await call('graph_link', {
        devices: ['dev/lotus/+/sht/temperature'], from: '2026-09-24T00:00:00+05:30', bucket: '1h', tz: 'Asia/Kolkata', title: 'Heat',
      });
      const url = new URL(body.url);
      expect(url.pathname).toBe('/dashboard/graph.html');
      expect(url.searchParams.getAll('device')).toEqual(['dev/lotus/+/sht/temperature']);
      expect(url.searchParams.get('from')).toBe('2026-09-24T00:00:00+05:30');
      expect(url.searchParams.get('bucket')).toBe('1h');
      expect(url.searchParams.get('tz')).toBe('Asia/Kolkata');
      expect(url.searchParams.get('title')).toBe('Heat');
    });
    it('the link uses the server\'s public address, not the address the request arrived at', async () => {
      const behindProxy = express();
      behindProxy.use((req, res, next) => { req.isAuthenticated = () => true; req.user = user; next(); });
      behindProxy.use(express.json());
      behindProxy.use('/mcp', createMcpRouter({
        db: null, dataDir: dir, organizations: () => ({ dev: {} }), publicBase: () => 'https://farm.example.org',
        loggerClient: createLoggerClient({ flush: (cb) => cb(), reportNodes: () => ({}), getNodeState: () => ({}), clients: {} }),
      }));
      const r = await request(behindProxy).post('/mcp').set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'graph_link', arguments: { devices: ['dev/lotus/a'], from: String(DAY) } } });
      expect(JSON.parse(r.body.result.content[0].text).url).toMatch(/^https:\/\/farm\.example\.org\/dashboard\/graph\.html\?/);
    });
    it('refuses a project without MCP, and a selection with nothing recorded', async () => {
      expect((await call('graph_link', { devices: ['dev/magi/c'], from: String(DAY) })).body.error).toBe('not_allowed');
      expect((await call('graph_link', { devices: ['dev/lotus/+/sht/pressure'], from: String(DAY) })).body.error).toBe('device_not_found');
    });
    it('refuses a bucket that is not one', async () => {
      const r = await call('graph_link', { devices: ['dev/lotus/a'], from: String(DAY), bucket: 'lots' });
      expect(r.body.error).toBe('invalid_request');
    });
  });
});

describe('/mcp call log', () => {
  // An app of its own, with a log that keeps what it is given
  let app, dir;
  const logged = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-log-'));
    mkdirSync(join(dir, 'dev/lotus/a/sht/temperature'), { recursive: true });
    writeFileSync(join(dir, 'dev/lotus/a/sht/temperature/2026-09-24.csv'), `${DAY},"20"\n${DAY + H},"21"\n`);
    const user = { id: 2, username: 'tester', permissions: [{ capability: 'MCP', org: 'dev' }, { capability: 'READ', org: 'dev' }] };
    app = express();
    app.use((req, res, next) => { req.isAuthenticated = () => true; req.user = user; next(); });
    app.use(express.json());
    app.use('/mcp', createMcpRouter({
      db: null, dataDir: dir, organizations: () => ({ dev: {} }),
      loggerClient: createLoggerClient({ flush: (cb) => cb(), reportNodes: () => ({}), getNodeState: () => ({}), clients: {} }),
      log: { record: async (entry) => { logged.push(entry); } },
    }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const call = (name, args) => request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('records who, what, how long, and what it read and returned', async () => {
    logged.length = 0;
    await call('get_series', { devices: ['dev/lotus/a/sht/temperature'], from: String(DAY), bucket: '1h' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      user: 2, username: 'tester', via: 'session', tool: 'get_series', ok: true,
      args: { devices: ['dev/lotus/a/sht/temperature'], bucket: '1h' },
      read: { topics: 1, files: 1, readings: 2 }, returned: 8,
    });
    expect(typeof logged[0].ms).toBe('number');
  });
  it('records a refusal with its reason - the line that says what to improve', async () => {
    logged.length = 0;
    await call('get_series', { devices: ['dev/lotus/a'], from: String(DAY - 365 * 24 * H), bucket: '1m' });
    expect(logged[0]).toMatchObject({ tool: 'get_series', ok: false, error: 'too_much_data' });
    expect(logged[0].message).toMatch(/larger bucket/);
  });
  it('tools/list is not a call, so is not recorded', async () => {
    logged.length = 0;
    await request(app).post('/mcp').set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(logged).toHaveLength(0);
  });
});

describe('timeBeyond', () => {
  const iso = (t) => localIso(t, 'UTC');
  it('a reading holds until the next, but not across a long silence', () => {
    const rows = [{ t: 0, v: 5 }, { t: 10 * H, v: 5 }, { t: 10.5 * H, v: 1 }];
    const r = timeBeyond(rows, (v) => v > 3, 11 * H, iso);
    expect(r.readings).toBe(2);
    expect(r.hours).toBe(1.5); // one hour at most for the first, half an hour for the second
    expect(r.longest.hours).toBe(1); // the silence broke the run
  });
});
