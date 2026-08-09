#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const OBSOLETE_PROTOCOL = '2024-11-05';
const DEFAULT_PROTOCOL = '2025-11-25';
const MAX_CAPTURE_BYTES = 1024 * 1024;

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

function boundedAppend(current, chunk, label) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new ContractError(`${label} exceeded ${MAX_CAPTURE_BYTES} bytes`);
  }
  return next;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ContractError(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeRequiredTools(value) {
  const tools = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  const unique = [...new Set(tools)];
  for (const tool of unique) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) {
      throw new ContractError(`invalid required tool name: ${JSON.stringify(tool)}`);
    }
  }
  return unique;
}

function collectSecretSentinels(childEnv, explicit = []) {
  const values = [...explicit];
  for (const [key, value] of Object.entries(childEnv ?? {})) {
    if (/(?:token|secret|password|passwd|credential|private[_-]?key|api[_-]?key)/i.test(key)) {
      if (typeof value === 'string' && value.length >= 4) values.push(value);
    }
  }
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length >= 4))];
}

function assertNoSecretLeak(text, sentinels, label) {
  for (const sentinel of sentinels) {
    if (text.includes(sentinel)) {
      throw new ContractError(`secret sentinel appeared in ${label}`);
    }
  }
}

function writeFrame(child, frame) {
  if (!child.stdin || child.stdin.destroyed) {
    throw new ContractError('server stdin closed before contract completed');
  }
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

export async function runContract(options) {
  const command = String(options.command ?? '').trim();
  if (!command) throw new ContractError('command is required');

  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const requiredTools = normalizeRequiredTools(options.requiredTools);
  const callTool = options.callTool ? String(options.callTool) : null;
  const protocolVersion = String(options.protocolVersion ?? DEFAULT_PROTOCOL);
  const timeoutMs = Number(options.timeoutMs ?? 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new ContractError('timeoutMs must be an integer from 100 to 120000');
  }
  if (!protocolVersion || protocolVersion === OBSOLETE_PROTOCOL) {
    throw new ContractError('protocolVersion must be current and non-empty');
  }

  const childEnv = { ...(options.childEnv ?? {}) };
  const secretSentinels = collectSecretSentinels(childEnv, options.secretSentinels ?? []);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...childEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  let stdoutCapture = '';
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    try {
      stderr = boundedAppend(stderr, chunk, 'stderr');
    } catch (error) {
      spawnError = error;
      child.kill('SIGKILL');
    }
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  async function readFrame(expectedId, label) {
    const next = await withTimeout(iterator.next(), timeoutMs, label);
    if (next.done) {
      throw new ContractError(`${label} ended before a response frame`);
    }
    const line = next.value;
    stdoutCapture = boundedAppend(stdoutCapture, `${line}\n`, 'stdout');
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new ContractError(`${label} emitted non-JSON stdout`);
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      throw new ContractError(`${label} response must be a JSON object`);
    }
    if (frame.jsonrpc !== '2.0') {
      throw new ContractError(`${label} response must use jsonrpc 2.0`);
    }
    if (frame.id !== expectedId) {
      throw new ContractError(`${label} response id drifted: ${JSON.stringify(frame.id)}`);
    }
    if (frame.error) {
      throw new ContractError(`${label} returned MCP error: ${String(frame.error.message ?? 'unknown')}`);
    }
    return frame;
  }

  try {
    writeFrame(child, {
      jsonrpc: '2.0',
      id: 'contract-initialize',
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'fiducia-test-mcp-contract', version: '1.0.0' },
      },
    });
    const initialized = await readFrame('contract-initialize', 'initialize');
    const negotiated = initialized.result?.protocolVersion;
    if (typeof negotiated !== 'string' || negotiated.length === 0 || negotiated === OBSOLETE_PROTOCOL) {
      throw new ContractError(`server negotiated an invalid protocol: ${JSON.stringify(negotiated)}`);
    }

    writeFrame(child, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    writeFrame(child, {
      jsonrpc: '2.0',
      id: 'contract-tools',
      method: 'tools/list',
      params: {},
    });
    const toolsFrame = await readFrame('contract-tools', 'tools/list');
    const tools = toolsFrame.result?.tools;
    if (!Array.isArray(tools)) throw new ContractError('tools/list result.tools must be an array');

    const names = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        throw new ContractError('every tool descriptor must be an object');
      }
      if (typeof tool.name !== 'string' || !tool.name) {
        throw new ContractError('every tool descriptor must have a non-empty name');
      }
      if (names.has(tool.name)) throw new ContractError(`duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
        throw new ContractError(`tool ${tool.name} is missing an object inputSchema`);
      }
    }

    const missing = requiredTools.filter((tool) => !names.has(tool));
    if (missing.length > 0) {
      throw new ContractError(`required tools missing: ${missing.join(', ')}`);
    }

    if (callTool) {
      if (!names.has(callTool)) throw new ContractError(`callTool is not advertised: ${callTool}`);
      writeFrame(child, {
        jsonrpc: '2.0',
        id: 'contract-call',
        method: 'tools/call',
        params: { name: callTool, arguments: {} },
      });
      const call = await readFrame('contract-call', `tools/call ${callTool}`);
      if (call.result?.isError === true) {
        throw new ContractError(`tools/call ${callTool} returned isError=true`);
      }
      if (!Array.isArray(call.result?.content) || call.result.content.length === 0) {
        throw new ContractError(`tools/call ${callTool} returned no content`);
      }
    }

    child.stdin.end();
    const exit = await withTimeout(exitPromise, timeoutMs, 'stdio shutdown');
    if (spawnError) throw new ContractError(`server process failed: ${spawnError.message}`);
    if (exit.code !== 0) {
      throw new ContractError(`server exited unsuccessfully: code=${exit.code} signal=${exit.signal}`);
    }
    assertNoSecretLeak(stdoutCapture, secretSentinels, 'MCP stdout');
    assertNoSecretLeak(stderr, secretSentinels, 'server stderr');

    return {
      protocolVersion: negotiated,
      tools: [...names].sort(),
      calledTool: callTool,
      exitCode: exit.code,
      stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    };
  } catch (error) {
    if (!child.killed) child.kill('SIGKILL');
    child.stdin?.destroy();
    lines.close();
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 250))]);
    assertNoSecretLeak(stdoutCapture, secretSentinels, 'MCP stdout');
    assertNoSecretLeak(stderr, secretSentinels, 'server stderr');
    if (error instanceof ContractError) throw error;
    throw new ContractError(error instanceof Error ? error.message : String(error));
  } finally {
    lines.close();
  }
}

function parseCli(argv) {
  const options = { args: [], requiredTools: [], childEnv: {}, secretSentinels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new ContractError(`${flag} requires a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--command': options.command = value(); break;
      case '--arg': options.args.push(value()); break;
      case '--cwd': options.cwd = value(); break;
      case '--required-tools': options.requiredTools = value(); break;
      case '--call-tool': options.callTool = value(); break;
      case '--protocol-version': options.protocolVersion = value(); break;
      case '--timeout-ms': options.timeoutMs = Number(value()); break;
      case '--child-env-json': {
        const parsed = JSON.parse(value());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ContractError('--child-env-json must be a JSON object');
        }
        options.childEnv = Object.fromEntries(
          Object.entries(parsed).map(([key, item]) => [key, String(item)]),
        );
        break;
      }
      case '--secret-sentinel': options.secretSentinels.push(value()); break;
      default: throw new ContractError(`unknown argument: ${flag}`);
    }
  }
  return options;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = await runContract(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`mcp wire contract failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
