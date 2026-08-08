import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ContractError, runContract } from './mcp-wire-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fake = resolve(here, '../fixtures/fake-mcp-server.mjs');
const token = 'sentinel.test.token';

function options(mode = 'happy') {
  return {
    command: process.execPath,
    args: [fake],
    requiredTools: ['platform_status', 'safety_contract'],
    callTool: 'safety_contract',
    timeoutMs: 2_000,
    childEnv: { FAKE_MODE: mode, MCP_ACCESS_TOKEN: token },
  };
}

test('happy path negotiates current protocol, validates schemas, calls a tool, and shuts down', async () => {
  const result = await runContract(options());
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.tools, ['platform_status', 'safety_contract']);
  assert.equal(result.calledTool, 'safety_contract');
  assert.equal(result.exitCode, 0);
});

test('missing required tools fail closed', async () => {
  await assert.rejects(runContract(options('missing-tool')), /required tools missing: safety_contract/);
});

test('non-JSON stdout fails before protocol desynchronization', async () => {
  await assert.rejects(runContract(options('bad-stdout')), /emitted non-JSON stdout/);
});

test('secret-bearing diagnostics fail even when protocol behavior is otherwise valid', async () => {
  await assert.rejects(runContract(options('leak-secret')), /secret sentinel appeared in server stderr/);
});

test('hung servers are killed at the bounded deadline', async () => {
  const hung = options('hang');
  hung.timeoutMs = 250;
  await assert.rejects(runContract(hung), (error) => {
    assert.ok(error instanceof ContractError);
    assert.match(error.message, /timed out/);
    return true;
  });
});
