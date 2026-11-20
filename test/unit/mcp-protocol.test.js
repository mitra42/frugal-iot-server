/**
 * lib/mcp-protocol.js - the MCP this server speaks, in place of the SDK: stateless Streamable HTTP,
 * JSON answers, tools only.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { handleMcpPost, checkSchema, PROTOCOL_VERSIONS } from '../../lib/mcp-protocol.js';

const server = { name: 'test', version: '1.2.3', instructions: 'How to use it' };
const calls = [];
const tools = [{
  name: 'echo', description: 'Says it back', annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { word: { type: 'string' }, n: { type: 'number' } }, required: ['word'] },
  call: async (args) => { calls.push(args); return { content: [{ type: 'text', text: args.word }] }; },
}];
const app = express();
app.use(express.json());
app.post('/mcp', (req, res) => handleMcpPost(req, res, server, tools));
const post = (body, headers = {}) => request(app).post('/mcp').set(headers).send(body);
const rpc = (method, params, id = 1) => post({ jsonrpc: '2.0', id, method, params });

describe('lifecycle', () => {
  it('initialize agrees the version asked for when it knows it, and offers its newest otherwise', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
    expect(r.body).toEqual({ jsonrpc: '2.0', id: 1, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'test', version: '1.2.3' }, instructions: 'How to use it' } });
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });
  it('a notification or a reply gets 202 and no body', async () => {
    const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
    expect((await post({ jsonrpc: '2.0', id: 9, result: {} })).status).toBe(202);
  });
  it('ping', async () => {
    expect((await rpc('ping')).body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
  it('a version header it does not speak is refused', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' });
    expect(r.status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2025-06-18' })).status).toBe(200);
  });
  it('anything else is method not found, and a non-JSON-RPC message is an invalid request', async () => {
    expect((await rpc('resources/list')).body.error.code).toBe(-32601);
    expect((await post({ id: 1, method: 'ping' })).body.error.code).toBe(-32600);
  });
  it('a batch gets an array of replies, leaving out the notifications', async () => {
    const r = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    expect(r.body.map((x) => x.id)).toEqual([1, 2]);
  });
});

describe('tools', () => {
  it('tools/list gives name, description, schema and annotations - not the implementation', async () => {
    const [t] = (await rpc('tools/list')).body.result.tools;
    expect(Object.keys(t).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name']);
  });
  it('tools/call passes only the arguments the schema names', async () => {
    calls.length = 0;
    const r = await rpc('tools/call', { name: 'echo', arguments: { word: 'hi', stray: 'x' } });
    expect(r.body.result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(calls).toEqual([{ word: 'hi' }]);
  });
  it('a wrong argument or an unknown tool is a tool error Claude can read, and the tool is not run', async () => {
    calls.length = 0;
    const bad = await rpc('tools/call', { name: 'echo', arguments: { word: 5 } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/word must be a string/);
    const missing = await rpc('tools/call', { name: 'echo', arguments: {} });
    expect(missing.body.result.content[0].text).toMatch(/word is required/);
    const unknown = await rpc('tools/call', { name: 'nope' });
    expect(unknown.body.result.content[0].text).toMatch(/No tool called nope - the tools are echo/);
    expect(calls).toEqual([]);
  });
});

describe('checkSchema', () => {
  const s = { type: 'object', properties: { list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, x: { type: 'number' } } };
  it('arrays: type, length and items', () => {
    expect(checkSchema(s, { list: ['a'] })).toBeUndefined();
    expect(checkSchema(s, { list: [] })).toMatch(/at least 1/);
    expect(checkSchema(s, { list: ['a', 'b', 'c'] })).toMatch(/at most 2/);
    expect(checkSchema(s, { list: ['a', 3] })).toMatch(/list\[1\] must be a string/);
    expect(checkSchema(s, { list: 'a' })).toMatch(/must be an array/);
  });
  it('numbers must be finite numbers, and the whole must be an object', () => {
    expect(checkSchema(s, { x: '3' })).toMatch(/must be a number/);
    expect(checkSchema(s, [])).toMatch(/must be an object/);
  });
});
