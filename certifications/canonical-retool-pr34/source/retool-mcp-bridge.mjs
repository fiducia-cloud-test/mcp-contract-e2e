#!/usr/bin/env node

import http from "node:http";
import { randomBytes } from "node:crypto";

const endpoint = process.env.RETOOL_MCP_URL || "https://alexmills.retool.com/mcp";
const token = process.env.RETOOL_MCP_TOKEN;
const host = process.env.RETOOL_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.RETOOL_BRIDGE_PORT || 8787);
const nonce = process.env.RETOOL_BRIDGE_NONCE || randomBytes(18).toString("base64url");

if (!token) {
  console.error("RETOOL_MCP_TOKEN is required. Keep it out of Git and shell history.");
  process.exit(2);
}

let sessionId = null;
let requestId = 1;
let initialized = false;
let cachedTools = null;

const READ_ONLY_TOOLS = new Set([
  "retool_get_app",
  "retool_list_apps",
  "retool_list_react_app_threads",
  "retool_read_react_app_thread_stream",
  "retool_list_react_app_files",
  "retool_read_react_app_files",
  "retool_list_react_app_publish_approvals",
]);

function mcpHeaders() {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return headers;
}

function parseSse(text) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Ignore keepalives/non-JSON events.
    }
  }
  return out;
}

async function postMcp(body, { notification = false } = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify(body),
  });

  const receivedSession = response.headers.get("mcp-session-id");
  if (receivedSession) sessionId = receivedSession;

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Retool MCP HTTP ${response.status}: ${text.replaceAll(token, "<redacted>").slice(0, 1500)}`);
  }

  if (notification || response.status === 202 || response.status === 204 || !text) return null;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const messages = parseSse(text);
    const reply = messages.find((message) => message?.id === body.id) ?? messages.at(-1);
    if (!reply) throw new Error("Retool MCP returned SSE without a JSON-RPC message");
    return reply;
  }

  return JSON.parse(text);
}

async function rpc(method, params = {}) {
  const id = requestId++;
  const reply = await postMcp({ jsonrpc: "2.0", id, method, params });
  if (reply?.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply?.result;
}

async function ensureInitialized() {
  if (initialized) return;
  const result = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "canonical-retool-local-bridge", version: "1.0.0" },
  });
  if (!result?.protocolVersion) throw new Error("Retool MCP initialize returned no protocolVersion");
  await postMcp(
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { notification: true },
  );
  initialized = true;
}

async function listTools() {
  await ensureInitialized();
  if (!cachedTools) {
    const result = await rpc("tools/list", {});
    cachedTools = result?.tools ?? [];
  }
  return cachedTools;
}

async function callReadTool(name, args) {
  if (!READ_ONLY_TOOLS.has(name)) {
    throw new Error(`Tool is not exposed by the read-only bridge: ${name}`);
  }
  const tools = await listTools();
  if (!tools.some((tool) => tool.name === name)) {
    throw new Error(`Retool MCP did not advertise tool: ${name}`);
  }
  return rpc("tools/call", { name, arguments: args });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function safeError(error) {
  return String(error?.stack || error).replaceAll(token, "<redacted>");
}

function verifyPath(url) {
  const prefix = `/s/${nonce}`;
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!verifyPath(url)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const prefix = `/s/${nonce}`;
    const path = url.pathname.slice(prefix.length) || "/";

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, {
        ok: true,
        mode: "read-only",
        endpoint_host: new URL(endpoint).host,
        session_established: Boolean(sessionId),
      });
      return;
    }

    if (req.method === "GET" && path === "/tools") {
      const tools = await listTools();
      sendJson(res, 200, {
        protocol: "mcp",
        session_established: Boolean(sessionId),
        tools: tools
          .filter((tool) => READ_ONLY_TOOLS.has(tool.name))
          .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
      return;
    }

    if (req.method === "GET" && path === "/call") {
      const name = url.searchParams.get("name");
      const rawArgs = url.searchParams.get("args") || "{}";
      if (!name) {
        sendJson(res, 400, { error: "missing_tool_name" });
        return;
      }
      let args;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        sendJson(res, 400, { error: "invalid_args_json" });
        return;
      }
      const result = await callReadTool(name, args);
      sendJson(res, 200, { tool: name, result });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: safeError(error) });
  }
});

server.listen(port, host, () => {
  const base = `http://${host}:${port}/s/${nonce}`;
  console.log(`Retool MCP bridge listening on ${base}`);
  console.log(`Health: ${base}/health`);
  console.log(`Tools:  ${base}/tools`);
  console.log("Mode: read-only; no Retool mutation tools are exposed.");
});
