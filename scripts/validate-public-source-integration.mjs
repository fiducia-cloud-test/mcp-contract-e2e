import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseJsonStrict } from './strict-json.mjs';

const SOURCE_REPOSITORY = 'fiducia-cloud/fiducia-mcp-server.rs';
const SOURCE_SHA = '1b3ba4e9ffdda9e7913407834280ebcbf045048d';
const DEPENDENCY_REPOSITORY = 'fiducia-cloud/fiducia-clients';
const DEPENDENCY_SHA = '5cd1a537f7ab98808ece4cdd09723be0bf49ce8b';
const WORKFLOW_PATH = '.github/workflows/exact-public-source-certification.yml';
const GENERIC_WORKFLOW_PATH = '.github/workflows/integration.yml';
const SECRET_LITERAL_PATTERN = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} contains missing or unknown fields`);
}

export function validateExactPublicSourceWorkflow({ workflow, genericWorkflow, sourcePins, testPlan }) {
  assert.equal(typeof workflow, 'string', 'exact source workflow must be text');
  assert.equal(typeof genericWorkflow, 'string', 'generic integration workflow must be text');

  assert(workflow.includes('name: exact public source certification'), 'exact workflow name drifted');
  assert(workflow.includes('permissions:\n  contents: read'), 'exact workflow must be read-only');
  assert(workflow.includes(`repository: ${SOURCE_REPOSITORY}`), 'exact workflow source repository drifted');
  assert(workflow.includes(`ref: ${SOURCE_SHA}`), 'exact workflow source SHA drifted');
  assert(workflow.includes(`repository: ${DEPENDENCY_REPOSITORY}`), 'exact workflow dependency repository drifted');
  assert(workflow.includes(`ref: ${DEPENDENCY_SHA}`), 'exact workflow dependency SHA drifted');
  assert(occurrences(workflow, 'persist-credentials: false') >= 3, 'every exact checkout must disable persisted credentials');
  assert(!workflow.includes('token:'), 'public exact workflow must not request a checkout token');
  assert(!workflow.includes('secrets.'), 'public exact workflow must not depend on repository secrets');
  assert(!workflow.includes('github.token'), 'public exact workflow must not use the repository token');
  assert(workflow.includes(`test "$(git -C fiducia-mcp-server.rs rev-parse HEAD)" = "${SOURCE_SHA}"`), 'source HEAD verification is missing');
  assert(workflow.includes(`test "$(git -C fiducia-clients rev-parse HEAD)" = "${DEPENDENCY_SHA}"`), 'dependency HEAD verification is missing');
  for (const command of [
    'cargo fmt --all -- --check',
    'cargo clippy --locked --all-targets -- -D warnings',
    'cargo build --release --locked',
    'cargo test --locked --all-targets',
    'cargo doc --locked --no-deps',
  ]) {
    assert(workflow.includes(command), `exact workflow is missing ${command}`);
  }
  assert(workflow.includes('certification-status:'), 'exact workflow certification status job is missing');
  assert(workflow.includes("const certified = result === 'success'"), 'exact workflow certification decision is missing');
  assert(workflow.includes("'exact-public-source-integration-passed'"), 'exact workflow success reason is missing');
  assert(workflow.includes('source-integration-status.json'), 'exact workflow status artifact is missing');

  assert(!genericWorkflow.includes('|| github.token'), 'generic workflow must not fall back to github.token');
  assert(genericWorkflow.includes('sourceAccessPassed'), 'generic workflow must report source access separately');
  assert(genericWorkflow.includes('certified: false'), 'generic workflow must never certify product source');
  assert(!genericWorkflow.includes("const certified = result === 'success'"), 'generic workflow contains false certification logic');

  const sourceNames = Object.keys(sourcePins.sources ?? {});
  assert.deepEqual(sourceNames, [SOURCE_REPOSITORY], 'source-pins must contain exactly the Fiducia MCP source');
  const sourcePin = sourcePins.sources[SOURCE_REPOSITORY];
  exactKeys(sourcePin, ['branch', 'sha', 'exists'], 'source-pins source');
  assert.equal(sourcePin.branch, 'main', 'source pin branch drifted');
  assert.equal(sourcePin.sha, SOURCE_SHA, 'source pin SHA drifted');
  assert.equal(sourcePin.exists, true, 'source pin must remain marked as existing');

  assert(Array.isArray(testPlan.sources) && testPlan.sources.length === 1, 'test plan must contain exactly one source');
  assert.equal(testPlan.sources[0].fullName, SOURCE_REPOSITORY, 'test plan source repository drifted');
  assert.equal(testPlan.sources[0].sha, SOURCE_SHA, 'test plan source SHA drifted');
  assert(testPlan.requiredChecks?.includes('exact-public-source-integration'), 'test plan exact integration check is missing');
  assert.equal(testPlan.security?.exactPublicSourceIntegration, true, 'test plan exact integration boundary is missing');
  assert.equal(testPlan.security?.productOverlayPreserved, true, 'test plan product-overlay boundary is missing');

  assert(!SECRET_LITERAL_PATTERN.test(`${workflow}\n${genericWorkflow}`), 'workflow contains a credential-shaped literal');

  return {
    schemaVersion: 2,
    sourceRepository: SOURCE_REPOSITORY,
    sourceSha: SOURCE_SHA,
    dependencyRepository: DEPENDENCY_REPOSITORY,
    dependencySha: DEPENDENCY_SHA,
    exactWorkflowPath: WORKFLOW_PATH,
    genericWorkflowPath: GENERIC_WORKFLOW_PATH,
    exactWorkflowSha256: crypto.createHash('sha256').update(workflow).digest('hex'),
    genericWorkflowSha256: crypto.createHash('sha256').update(genericWorkflow).digest('hex'),
    genericCertificationAllowed: false,
    exactCertificationRequiresExecutableSuccess: true,
  };
}

async function main() {
  const rootDirectory = path.resolve(process.argv[2] ?? '.');
  const workflow = fs.readFileSync(path.join(rootDirectory, WORKFLOW_PATH), 'utf8');
  const genericWorkflow = fs.readFileSync(path.join(rootDirectory, GENERIC_WORKFLOW_PATH), 'utf8');
  const sourcePins = parseJsonStrict(
    fs.readFileSync(path.join(rootDirectory, 'source-pins.json'), 'utf8'),
    'source-pins.json',
  );
  const testPlan = parseJsonStrict(
    fs.readFileSync(path.join(rootDirectory, 'test-plan.json'), 'utf8'),
    'test-plan.json',
  );
  const evidence = validateExactPublicSourceWorkflow({ workflow, genericWorkflow, sourcePins, testPlan });

  const evidencePath = process.env.PUBLIC_SOURCE_WORKFLOW_EVIDENCE ?? 'test-results/public-source-workflow-evidence.json';
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
