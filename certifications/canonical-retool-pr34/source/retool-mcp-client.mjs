#!/usr/bin/env node

const endpoint = process.env.RETOOL_MCP_URL || "https://alexmills.retool.com/mcp";
const token = process.env.RETOOL_MCP_TOKEN;

if (!token) {
  console.error("RETOOL_MCP_TOKEN is required. Keep it out of Git and shell history.");
  process.exit(2);
}

let sessionId = null;
let requestId = 1;

function headers() {
  const value = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) value["Mcp-Session-Id"] = sessionId;
  return value;
}

function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore keepalives/non-JSON events.
    }
  }
  return messages;
}

async function post(body, { notification = false } = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  const receivedSession = response.headers.get("mcp-session-id");
  if (receivedSession) sessionId = receivedSession;

  if (!response.ok) {
    const bodyText = await response.text();
    const safeBody = bodyText.replaceAll(token, "<redacted>");
    throw new Error(`Retool MCP HTTP ${response.status}: ${safeBody.slice(0, 1000)}`);
  }

  if (notification || response.status === 202 || response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text) return null;

  if (contentType.includes("text/event-stream")) {
    const messages = parseSse(text);
    const reply = messages.find((message) => message?.id === body.id) ?? messages.at(-1);
    if (!reply) throw new Error("Retool MCP returned an SSE response without a JSON-RPC message");
    return reply;
  }

  return JSON.parse(text);
}

async function rpc(method, params = {}) {
  const id = requestId++;
  const reply = await post({ jsonrpc: "2.0", id, method, params });
  if (reply?.error) {
    throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  }
  return reply?.result;
}

async function initialize() {
  const result = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "canonical-retool-mcp-client",
      version: "1.0.0",
    },
  });

  await post(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    { notification: true },
  );

  return result;
}

async function listTools() {
  const result = await rpc("tools/list", {});
  return result?.tools ?? [];
}

async function callTool(name, args) {
  const result = await rpc("tools/call", {
    name,
    arguments: args,
  });
  if (result?.isError) {
    throw new Error(`${name}: ${JSON.stringify(result.content ?? result)}`);
  }
  return result;
}

function relevantTools(tools) {
  const wanted = /(react_app|prepared_import|publish|thread|app_files|sync_react|approval|get_app)/i;
  return tools.filter((tool) => wanted.test(tool.name));
}

function usage() {
  console.error(`Usage:
  node tools/retool-mcp-client.mjs tools
  node tools/retool-mcp-client.mjs relevant-tools
  node tools/retool-mcp-client.mjs call <tool-name> '<json-arguments>'

Environment:
  RETOOL_MCP_TOKEN   Bearer/OAuth token used only at runtime; never printed
  RETOOL_MCP_URL     Optional; defaults to ${endpoint}

Examples:
  node tools/retool-mcp-client.mjs relevant-tools
  node tools/retool-mcp-client.mjs call retool_get_app '{"appId":"1cd19646-b3d9-11f1-91c2-077431b23c20"}'
`);
}

async function main() {
  const command = process.argv[2];
  if (!command) {
    usage();
    process.exit(2);
  }

  const initialized = await initialize();
  if (!initialized?.protocolVersion) {
    throw new Error("Retool MCP initialize succeeded without a protocolVersion");
  }

  if (command === "tools" || command === "relevant-tools") {
    const tools = await listTools();
    const selected = command === "relevant-tools" ? relevantTools(tools) : tools;
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  if (command === "call") {
    const name = process.argv[3];
    if (!name) {
      usage();
      process.exit(2);
    }
    const raw = process.argv[4] || "{}";
    const args = JSON.parse(raw);
    const result = await callTool(name, args);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  usage();
  process.exit(2);
}

main().catch((error) => {
  const message = String(error?.stack || error).replaceAll(token, "<redacted>");
  console.error(message);
  process.exit(1);
});
