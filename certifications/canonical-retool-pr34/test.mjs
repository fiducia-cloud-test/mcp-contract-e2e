import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = new URL("./", import.meta.url);
const client = new URL("./source/retool-mcp-client.mjs", here);
const bridge = new URL("./source/retool-mcp-bridge.mjs", here);
const manifest = JSON.parse(await readFile(new URL("./source.json", here), "utf8"));

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(script), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function unusedPort() {
  const probe = http.createServer();
  const url = await listen(probe);
  const port = Number(new URL(url).port);
  await close(probe);
  return port;
}

function jsonReply(res, value, status = 200, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(value));
}

function makeMcpServer({ requests, failInitializeWithToken = null } = {}) {
  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests?.push({ headers: req.headers, body });

    if (body?.method === "initialize") {
      if (failInitializeWithToken) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`upstream diagnostic ${failInitializeWithToken}`);
        return;
      }
      jsonReply(
        res,
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-retool", version: "1" } } },
        200,
        { "mcp-session-id": "session-123" },
      );
      return;
    }

    if (body?.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    if (body?.method === "tools/list") {
      const reply = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "retool_get_app", description: "read app", inputSchema: { type: "object" } },
            { name: "retool_start_prepared_import", description: "write app", inputSchema: { type: "object" } },
            { name: "unrelated_tool", description: "noise", inputSchema: { type: "object" } },
          ],
        },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }

    if (body?.method === "tools/call") {
      jsonReply(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: `called:${body.params?.name}` }] },
      });
      return;
    }

    jsonReply(res, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "method not found" } }, 404);
  });
}

test("snapshots are byte-identical to canonical-retool PR #34", async () => {
  assert.equal(manifest.source_repo, "canonical-cloud/canonical-retool");
  assert.equal(manifest.source_pr, 34);
  assert.equal(manifest.source_head, "bf33341197795658be2b76eaa4ec44143fb98a71");

  const local = {
    "docs/retool-mcp-client.md": new URL("./source/retool-mcp-client.md", here),
    "tools/retool-mcp-bridge.mjs": bridge,
    "tools/retool-mcp-client.mjs": client,
  };
  for (const [sourcePath, expectedSha] of Object.entries(manifest.files)) {
    const bytes = await readFile(local[sourcePath]);
    assert.equal(gitBlobSha(bytes), expectedSha, `${sourcePath} must match the pinned Git blob`);
  }
});

test("MCP client preserves bearer auth/session state and parses SSE tool discovery", async (t) => {
  const requests = [];
  const server = makeMcpServer({ requests });
  const endpoint = await listen(server);
  t.after(() => close(server));
  const token = "certification-secret";

  const result = await runNode(client, ["relevant-tools"], {
    RETOOL_MCP_URL: endpoint,
    RETOOL_MCP_TOKEN: token,
  });
  assert.equal(result.code, 0, result.stderr);
  const tools = JSON.parse(result.stdout);
  assert.deepEqual(tools.map((tool) => tool.name), ["retool_get_app", "retool_start_prepared_import"]);
  assert.ok(requests.length >= 3);
  assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0].headers["mcp-session-id"], undefined);
  assert.equal(requests[1].headers["mcp-session-id"], "session-123");
  assert.equal(requests[2].headers["mcp-session-id"], "session-123");
});

test("MCP client redacts bearer tokens from upstream errors", async (t) => {
  const token = "must-never-leak-123";
  const server = makeMcpServer({ failInitializeWithToken: token });
  const endpoint = await listen(server);
  t.after(() => close(server));

  const result = await runNode(client, ["tools"], {
    RETOOL_MCP_URL: endpoint,
    RETOOL_MCP_TOKEN: token,
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.includes(token), false, result.stderr);
  assert.match(result.stderr, /<redacted>/);
});

test("local bridge exposes only its read-only allowlist", async (t) => {
  const requests = [];
  const mcp = makeMcpServer({ requests });
  const endpoint = await listen(mcp);
  t.after(() => close(mcp));

  const bridgePort = await unusedPort();
  const nonce = "cert-nonce";
  const child = spawn(process.execPath, [fileURLToPath(bridge)], {
    env: {
      ...process.env,
      RETOOL_MCP_URL: endpoint,
      RETOOL_MCP_TOKEN: "bridge-secret",
      RETOOL_BRIDGE_HOST: "127.0.0.1",
      RETOOL_BRIDGE_PORT: String(bridgePort),
      RETOOL_BRIDGE_NONCE: nonce,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });

  let startup = "";
  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        startup += chunk;
        if (startup.includes("Retool MCP bridge listening")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`bridge exited early with ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("bridge startup timeout")), 5000)),
  ]);

  const base = `http://127.0.0.1:${bridgePort}/s/${nonce}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    mode: "read-only",
    endpoint_host: new URL(endpoint).host,
    session_established: false,
  });

  const beforeMutation = requests.length;
  const mutation = await fetch(`${base}/call?name=retool_start_prepared_import&args=%7B%7D`);
  assert.equal(mutation.status, 500);
  const mutationBody = await mutation.json();
  assert.match(mutationBody.error, /not exposed by the read-only bridge/);
  assert.equal(requests.length, beforeMutation, "blocked mutation must never reach MCP");

  const read = await fetch(`${base}/call?name=retool_get_app&args=${encodeURIComponent('{"appId":"demo"}')}`);
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.equal(readBody.tool, "retool_get_app");
  assert.match(JSON.stringify(readBody.result), /called:retool_get_app/);
  assert.ok(requests.some((request) => request.body?.method === "tools/call" && request.body?.params?.name === "retool_get_app"));

  child.kill("SIGTERM");
  await once(child, "exit");
});
