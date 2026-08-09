import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const readText = (relativePath) => fs.readFileSync(new URL(relativePath, root), 'utf8');
const readJson = (relativePath) => JSON.parse(readText(relativePath));
const provenance = readJson('shared-bootstrap-provenance.json');
const sourcePins = readJson('source-pins.json');
const plan = readJson('test-plan.json');
const errors = [];

const SHA40 = /^[0-9a-f]{40}$/;
const CREDENTIAL = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|cfat_[A-Za-z0-9_-]+|lin_api_[A-Za-z0-9_-]+)/;

function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return crypto
    .createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

if (provenance.schemaVersion !== 1) errors.push('provenance schemaVersion must be 1');
if (provenance.issue !== 'DEN-957') errors.push('provenance issue must be DEN-957');
if (!SHA40.test(provenance.source?.commitSha ?? '')) errors.push('source commit must be an immutable 40-character SHA');
if (!SHA40.test(provenance.sharedBootstrap?.revision ?? '')) errors.push('shared bootstrap revision must be an immutable 40-character SHA');
if (provenance.sharedBootstrap?.repository !== 'ORESoftware/mcp-rust-libs') errors.push('unexpected shared bootstrap repository');

const sourcePin = sourcePins.sources?.[provenance.source?.repository];
if (!sourcePin) {
  errors.push('source-pins.json is missing the production repository');
} else {
  if (sourcePin.sha !== provenance.source.commitSha) errors.push('source pin does not match provenance commit');
  if (sourcePin.branch !== provenance.source.branch) errors.push('source pin branch does not match provenance branch');
  if (sourcePin.exists !== true) errors.push('production source must be marked as existing');
}

const planSource = plan.sources?.find((source) => source.fullName === provenance.source?.repository);
if (!planSource) {
  errors.push('test-plan.json is missing the production repository');
} else if (planSource.sha !== provenance.source.commitSha) {
  errors.push('test plan source SHA does not match provenance commit');
}
for (const required of ['shared-bootstrap-revision', 'source-blob-provenance']) {
  if (!plan.requiredChecks?.includes(required)) errors.push(`test plan is missing required check: ${required}`);
}
if (plan.security?.pullRequestCredentials !== false) errors.push('pull-request credentials must remain disabled');
if (plan.security?.credentialFreeSnapshots !== true) errors.push('credential-free snapshots must be required');

const loaded = {};
for (const [sourcePath, metadata] of Object.entries(provenance.files ?? {})) {
  if (!SHA40.test(metadata.blobSha ?? '')) {
    errors.push(`invalid Git blob SHA for ${sourcePath}`);
    continue;
  }
  const fixture = metadata.fixture;
  if (
    typeof fixture !== 'string' ||
    !fixture.startsWith('fixtures/') ||
    path.posix.normalize(fixture) !== fixture ||
    fixture.includes('\\')
  ) {
    errors.push(`fixture path must stay canonically under fixtures/: ${sourcePath}`);
    continue;
  }
  const content = readText(fixture);
  loaded[sourcePath] = content;
  const actual = gitBlobSha(content);
  if (actual !== metadata.blobSha) errors.push(`fixture blob mismatch for ${sourcePath}: expected ${metadata.blobSha}, got ${actual}`);
  if (CREDENTIAL.test(content)) errors.push(`credential-shaped value found in ${fixture}`);
}

const revision = provenance.sharedBootstrap?.revision ?? '';
const manifest = loaded['Cargo.toml'] ?? '';
const telemetry = loaded['src/telemetry.rs'] ?? '';
const contract = loaded['tests/shared_bootstrap_contract.rs'] ?? '';

if (!manifest.includes('ore-mcp-bootstrap')) errors.push('manifest does not depend on ore-mcp-bootstrap');
if (!manifest.includes(`rev = "${revision}"`)) errors.push('manifest does not pin the expected shared bootstrap revision');
if (!telemetry.includes('ore_mcp_bootstrap::runtime::ServerIdentity::stdio')) errors.push('telemetry does not delegate static identity validation');
if (!telemetry.includes('ore_mcp_bootstrap::telemetry::resource_attribute_pairs')) errors.push('telemetry does not delegate resource-attribute policy');
if (!telemetry.includes('with_writer(std::io::stderr)')) errors.push('stdio MCP telemetry must write logs to stderr');
for (const forbidden of ['fn valid_attribute_key', 'fn sensitive_attribute_key']) {
  if (telemetry.includes(forbidden)) errors.push(`duplicated shared policy found: ${forbidden}`);
}
if (!contract.includes(revision)) errors.push('Rust contract test does not enforce the expected revision');
for (const token of [
  'ore_mcp_bootstrap::runtime::ServerIdentity::stdio',
  'ore_mcp_bootstrap::telemetry::resource_attribute_pairs',
]) {
  if (!contract.includes(token)) errors.push(`Rust contract test is missing assertion for ${token}`);
}

const serialized = JSON.stringify({ provenance, sourcePins, plan });
if (CREDENTIAL.test(serialized)) errors.push('credential-shaped value found in contract metadata');

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

console.log(`validated ${provenance.source.repository}@${provenance.source.commitSha}`);
console.log(`shared bootstrap: ${provenance.sharedBootstrap.repository}@${revision}`);
console.log(`verified ${Object.keys(loaded).length} credential-free source snapshots with Git blob provenance`);
