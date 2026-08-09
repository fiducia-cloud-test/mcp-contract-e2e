#!/usr/bin/env node
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'happy';
const token = process.env.MCP_ACCESS_TOKEN ?? '';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let first = true;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

process.stderr.write('fake MCP diagnostics on stderr\n');
if (mode === 'leak-secret') process.stderr.write(`credential=${token}\n`);

for await (const line of input) {
  if (mode === 'hang') continue;
  if (mode === 'bad-stdout' && first) {
    first = false;
    process.stdout.write('not-json\n');
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
  } else if (request.method === 'notifications/initialized') {
    // Notification: deliberately no response.
  } else if (request.method === 'tools/list') {
    const tools = [
      {
        name: 'platform_status',
        description: 'Read-only fake status',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ];
    if (mode !== 'missing-tool') {
      tools.push({
        name: 'safety_contract',
        description: 'Describe immutable safety boundaries',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      });
    }
    send({ jsonrpc: '2.0', id: request.id, result: { tools } });
  } else if (request.method === 'tools/call' && request.params?.name === 'safety_contract') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ mutations_enabled: false }) }],
        isError: false,
      },
    });
  } else {
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'method not found' },
    });
  }
}
