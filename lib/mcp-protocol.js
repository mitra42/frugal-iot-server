/**
 * The part of MCP this server speaks: Streamable HTTP, stateless, answers as plain JSON, tools only.
 * In place of @modelcontextprotocol/sdk, which brought hono, jose, ajv, zod and more onto every Pi for
 * the few messages below (issue #44).
 *
 * Spec: https://modelcontextprotocol.io/specification - transports (Streamable HTTP), lifecycle
 * (initialize), utilities (ping), server/tools. Everything else a client might send is "method not
 * found", which is what a server without those capabilities is meant to say.
 *
 *   initialize                 protocol version agreed, capabilities, server info and instructions
 *   ping                       {}
 *   tools/list                 every tool, with its JSON Schema
 *   tools/call                 arguments checked against that schema, then the tool
 *   notifications/*, replies   accepted, nothing sent back (202)
 *
 * Stateless: no session id is issued, there is no stream to GET and nothing to DELETE, so a request
 * stands alone and initialize need not come first - each POST is answered from what it carries.
 */

// Newest first: the first is offered to a client asking for one this server does not know
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/*
 * The subset of JSON Schema the tools use - object, string, number, integer, boolean, and array with
 * items, minItems and maxItems - checked here because Claude reads these schemas and an argument
 * that does not fit is better refused with a reason than passed to a tool. Returns a message, or
 * undefined when value fits. Properties the schema does not name are ignored, as before.
 */
export function checkSchema(schema, value, path = 'arguments') {
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    for (const k of schema.required || []) if (value[k] === undefined) return `${path}.${k} is required`;
    for (const [k, s] of Object.entries(schema.properties || {})) {
      if (value[k] === undefined) continue;
      const err = checkSchema(s, value[k], `${path}.${k}`);
      if (err) return err;
    }
    return undefined;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} may have at most ${schema.maxItems}`;
    for (let i = 0; i < value.length; i++) {
      const err = schema.items && checkSchema(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return undefined;
  }
  if (t === 'string') return typeof value === 'string' ? undefined : `${path} must be a string`;
  if (t === 'number') return (typeof value === 'number' && Number.isFinite(value)) ? undefined : `${path} must be a number`;
  if (t === 'integer') return Number.isInteger(value) ? undefined : `${path} must be an integer`;
  if (t === 'boolean') return typeof value === 'boolean' ? undefined : `${path} must be true or false`;
  return undefined;
}

// Only what the schema names goes to a tool, so a stray argument cannot reach it unchecked
function known(schema, args) {
  return Object.fromEntries(Object.keys(schema.properties || {}).filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
}

const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

/*
 * An Express handler for POST. server: { name, version, instructions }. tools: [{ name, description,
 * inputSchema, annotations, call(args) }], where call returns a tools/call result ({ content, isError? })
 * and never throws for anything a caller did. Built per request, so each tool can close over who is
 * asking.
 */
export async function handleMcpPost(req, res, server, tools) {
  // A version header is sent on every request after initialize; one we do not speak is refused, as
  // the transport spec says, rather than answered in a version the client does not expect
  const asked = req.get('MCP-Protocol-Version');
  if (asked && !PROTOCOL_VERSIONS.includes(asked)) {
    return res.status(400).json(rpcError(null, INVALID_REQUEST,
      `Unsupported protocol version ${asked} - this server speaks ${PROTOCOL_VERSIONS.join(', ')}`));
  }
  const body = req.body;
  if (body === undefined || body === null || typeof body !== 'object' || (Array.isArray(body) && !body.length)) {
    return res.status(400).json(rpcError(null, PARSE_ERROR, 'Expected a JSON-RPC message, sent as application/json'));
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  // A batch (an array) was allowed by 2025-03-26 and dropped by 2025-06-18; cheap to keep answering
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const m of messages) {
    const reply = await answer(m, server, tools, byName);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return res.status(202).end(); // only notifications or replies: nothing to say
  res.json(Array.isArray(body) ? replies : replies[0]);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// The reply to one message, or undefined for one that wants none
async function answer(m, server, tools, byName) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcError(m && m.id !== undefined ? m.id : null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 message');
  if (typeof m.method !== 'string') return undefined; // a reply to something we asked - we never ask
  if (m.id === undefined || m.id === null) return undefined; // a notification, e.g. notifications/initialized
  const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
  const params = m.params || {};
  try {
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          // listChanged false: the tools are fixed, and a stateless server has no stream to announce on
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: server.name, version: server.version },
          instructions: server.instructions,
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
      case 'tools/call': {
        const tool = byName.get(params.name);
        // As tool results rather than protocol errors, so Claude sees the reason and can correct itself
        if (!tool) return ok(toolError(`No tool called ${params.name} - the tools are ${tools.map((t) => t.name).join(', ')}`));
        const args = params.arguments === undefined ? {} : params.arguments;
        const wrong = checkSchema(tool.inputSchema, args);
        if (wrong) return ok(toolError(`Invalid arguments for ${tool.name}: ${wrong}`));
        return ok(await tool.call(known(tool.inputSchema, args)));
      }
      default:
        return rpcError(m.id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  } catch (err) {
    console.error('MCP', m.method, 'failed:', err);
    return rpcError(m.id, INTERNAL_ERROR, 'Internal error');
  }
}
