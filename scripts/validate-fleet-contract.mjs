#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const path = new URL('../fleet/fleet-contract.json', import.meta.url);
const document = JSON.parse(await readFile(path, 'utf8'));
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATES = new Set(['merged', 'open-ready', 'open-draft']);
const REQUIRED_CHECKS = new Set([
  'initialize',
  'tools-list',
  'schema',
  'stdio-exit',
  'secret-redaction',
]);

function fail(message) {
  throw new Error(`invalid fleet contract: ${message}`);
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function string(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value;
}
function scanKeys(value, pathParts = []) {
  if (Array.isArray(value)) return value.forEach((item, index) => scanKeys(item, [...pathParts, String(index)]));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:token|secret|password|passwd|credential|privateKey|accessKey|apiKey)$/i.test(key)) {
      fail(`credential-shaped key is forbidden at ${[...pathParts, key].join('.')}`);
    }
    scanKeys(item, [...pathParts, key]);
  }
}

object(document, 'root');
if (document.schemaVersion !== 1) fail('schemaVersion must equal 1');
if (document.expectedServerCount !== 10) fail('expectedServerCount must equal 10');
if (!Array.isArray(document.servers) || document.servers.length !== document.expectedServerCount) {
  fail('servers must contain exactly expectedServerCount entries');
}
string(document.testRepository, 'testRepository');
if (document.testRepository !== 'fiducia-cloud-test/mcp-contract-e2e') {
  fail('testRepository must remain the dedicated *-test harness');
}

const repositories = new Set();
for (const [index, raw] of document.servers.entries()) {
  const server = object(raw, `servers[${index}]`);
  const repository = string(server.repository, `servers[${index}].repository`);
  if (!REPOSITORY.test(repository)) fail(`${repository} is not owner/name`);
  if (repositories.has(repository)) fail(`duplicate repository ${repository}`);
  repositories.add(repository);
  if (!Number.isInteger(server.pullRequest) || server.pullRequest <= 0) fail(`${repository} pullRequest must be positive`);
  if (!SHA.test(string(server.headSha, `${repository}.headSha`))) fail(`${repository} headSha must be 40 lowercase hex`);
  if (!STATES.has(server.state)) fail(`${repository} has unsupported state ${server.state}`);
  if (server.state === 'merged') {
    if (!SHA.test(string(server.mergeSha, `${repository}.mergeSha`))) fail(`${repository} merged evidence requires mergeSha`);
  } else if (server.mergeSha !== undefined) {
    fail(`${repository} non-merged evidence must not claim mergeSha`);
  }
  if (!Array.isArray(server.requiredChecks)) fail(`${repository} requiredChecks must be an array`);
  const checks = new Set(server.requiredChecks);
  for (const required of REQUIRED_CHECKS) {
    if (!checks.has(required)) fail(`${repository} is missing required check ${required}`);
  }
  if (server.safetyProfile === 'physical-control') {
    if (server.mutationDefault !== 'disabled') fail(`${repository} physical mutations must default disabled`);
    if (!checks.has('target-bound-confirmation')) fail(`${repository} must test target-bound confirmation`);
    if (!checks.has('exact-origin-policy')) fail(`${repository} must test exact origin policy`);
  }
}

for (const requiredPhysical of [
  'drone-mngr/drone-mngr-mcp-server.rs',
  'drone-mngr/laser-ptr-ctrl-mcp-server.rs',
]) {
  if (!repositories.has(requiredPhysical)) fail(`physical-control fleet member missing: ${requiredPhysical}`);
}
scanKeys(document);
console.log(`fleet contract valid: ${document.servers.length} servers, ${repositories.size} unique repositories`);
