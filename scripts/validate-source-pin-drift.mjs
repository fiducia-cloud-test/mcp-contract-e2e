import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_REPOSITORY = 'fiducia-cloud/fiducia-mcp-server.rs';
const EXPECTED_BRANCH = 'main';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SECRET_PATTERN = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} contains missing or unknown fields`);
}

export function validateSourcePinDocuments({ readme, sourcePins, testPlan, remoteHead }) {
  assert.equal(testPlan.schemaVersion, 1, 'test-plan schemaVersion must be 1');
  assert.equal(testPlan.sourceOrganization, 'fiducia-cloud', 'test-plan source organization drifted');
  assert.equal(testPlan.testOrganization, 'fiducia-cloud-test', 'test-plan test organization drifted');
  assert.equal(testPlan.repository, 'mcp-contract-e2e', 'test-plan repository drifted');
  assert.equal(testPlan.profile, 'mcp-contract', 'test-plan profile drifted');
  assert(Array.isArray(testPlan.sources), 'test-plan sources must be an array');
  assert.equal(testPlan.sources.length, 1, 'test-plan must contain exactly one MCP source');

  const sourceKeys = Object.keys(sourcePins.sources ?? {});
  assert.deepEqual(sourceKeys, [EXPECTED_REPOSITORY], 'source-pins must contain exactly the reviewed MCP source');

  const sourcePin = sourcePins.sources[EXPECTED_REPOSITORY];
  exactKeys(sourcePin, ['branch', 'sha', 'exists'], 'source-pins entry');
  assert.equal(sourcePin.branch, EXPECTED_BRANCH, 'source-pins branch drifted');
  assert.equal(sourcePin.exists, true, 'source-pins source must remain marked as existing');
  assert(SHA_PATTERN.test(sourcePin.sha), 'source-pins SHA must be 40 lowercase hex characters');

  const planSource = testPlan.sources[0];
  exactKeys(planSource, ['fullName', 'exists', 'branch', 'sha', 'visibility'], 'test-plan source');
  assert.equal(planSource.fullName, EXPECTED_REPOSITORY, 'test-plan source repository drifted');
  assert.equal(planSource.exists, true, 'test-plan source must remain marked as existing');
  assert.equal(planSource.branch, EXPECTED_BRANCH, 'test-plan source branch drifted');
  assert.equal(planSource.visibility, 'public', 'test-plan source visibility drifted');
  assert(SHA_PATTERN.test(planSource.sha), 'test-plan source SHA must be 40 lowercase hex characters');

  const readmePattern = new RegExp(
    `\\|\\s*\\\`${escapeRegex(EXPECTED_REPOSITORY)}\\\`\\s*\\|\\s*\\\`([0-9a-f]{40})\\\`\\s*\\|\\s*\\\`${EXPECTED_BRANCH}\\\`\\s*\\|`,
  );
  const readmeMatch = readme.match(readmePattern);
  assert(readmeMatch, 'README immutable-source row is missing or malformed');
  const readmeSha = readmeMatch[1];

  assert.equal(sourcePin.sha, planSource.sha, 'source-pins and test-plan SHAs disagree');
  assert.equal(sourcePin.sha, readmeSha, 'README and machine-readable source SHAs disagree');
  assert(SHA_PATTERN.test(remoteHead ?? ''), 'remote main SHA must be 40 lowercase hex characters');
  assert.equal(sourcePin.sha, remoteHead, 'MCP source main moved; refresh and review all immutable pin documents');

  const serialized = JSON.stringify({ sourcePins, testPlan });
  assert(!SECRET_PATTERN.test(serialized), 'source-pin documents contain a credential-shaped value');

  return {
    schemaVersion: 1,
    sourceRepository: EXPECTED_REPOSITORY,
    sourceBranch: EXPECTED_BRANCH,
    sourceSha: sourcePin.sha,
    readmeSha,
    sourcePinsSha: sourcePin.sha,
    testPlanSha: planSource.sha,
    documentsDigest: crypto
      .createHash('sha256')
      .update(readme)
      .update('\0')
      .update(JSON.stringify(sourcePins))
      .update('\0')
      .update(JSON.stringify(testPlan))
      .digest('hex'),
  };
}

async function main() {
  const rootDirectory = path.resolve(process.argv[2] ?? '.');
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');
  const sourcePins = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'source-pins.json'), 'utf8'));
  const testPlan = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'test-plan.json'), 'utf8'));
  const evidence = validateSourcePinDocuments({
    readme,
    sourcePins,
    testPlan,
    remoteHead: process.env.MCP_REMOTE_SHA,
  });

  const evidencePath = process.env.SOURCE_PIN_EVIDENCE ?? 'test-results/source-pin-drift-evidence.json';
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Fiducia MCP source-pin conformance\n\n- Source: \`${evidence.sourceRepository}@${evidence.sourceSha}\`\n- README, source-pins, and test-plan: consistent\n- Documents digest: \`${evidence.documentsDigest}\`\n`,
    );
  }

  console.log(JSON.stringify(evidence));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
