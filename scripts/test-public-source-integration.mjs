import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseJsonStrict } from './strict-json.mjs';
import { validateExactPublicSourceWorkflow } from './validate-public-source-integration.mjs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/exact-public-source-certification.yml', import.meta.url),
  'utf8',
);
const genericWorkflow = fs.readFileSync(
  new URL('../.github/workflows/integration.yml', import.meta.url),
  'utf8',
);
const sourcePins = parseJsonStrict(
  fs.readFileSync(new URL('../source-pins.json', import.meta.url), 'utf8'),
  'test source-pins.json',
);
const testPlan = parseJsonStrict(
  fs.readFileSync(new URL('../test-plan.json', import.meta.url), 'utf8'),
  'test test-plan.json',
);

function clone(value) {
  return structuredClone(value);
}

function validate(overrides = {}) {
  return validateExactPublicSourceWorkflow({
    workflow,
    genericWorkflow,
    sourcePins,
    testPlan,
    ...overrides,
  });
}

test('accepts the product-owned exact source workflow and non-certifying generic lane', () => {
  const evidence = validate();
  assert.equal(evidence.sourceSha, '1b3ba4e9ffdda9e7913407834280ebcbf045048d');
  assert.equal(evidence.dependencySha, '5cd1a537f7ab98808ece4cdd09723be0bf49ce8b');
  assert.equal(evidence.genericCertificationAllowed, false);
  assert.equal(evidence.exactCertificationRequiresExecutableSuccess, true);
});

test('rejects an unreviewed source revision', () => {
  const mutated = workflow.replace(
    /1b3ba4e9ffdda9e7913407834280ebcbf045048d/g,
    '0000000000000000000000000000000000000000',
  );
  assert.throws(() => validate({ workflow: mutated }), /source SHA drifted/);
});

test('rejects an unreviewed client dependency revision', () => {
  const mutated = workflow.replace(
    /5cd1a537f7ab98808ece4cdd09723be0bf49ce8b/g,
    '0000000000000000000000000000000000000000',
  );
  assert.throws(() => validate({ workflow: mutated }), /dependency SHA drifted/);
});

test('rejects token or secret dependencies in the public workflow', () => {
  const withToken = workflow.replace(
    '          persist-credentials: false\n          show-progress: false',
    '          token: ${{ github.token }}\n          persist-credentials: false\n          show-progress: false',
  );
  assert.throws(() => validate({ workflow: withToken }), /must not request a checkout token/);

  const withSecret = workflow.replace(
    'permissions:\n  contents: read',
    'permissions:\n  contents: read\nenv:\n  API_VALUE: ${{ secrets.UNREVIEWED }}',
  );
  assert.throws(() => validate({ workflow: withSecret }), /must not depend on repository secrets/);
});

test('rejects missing executable Rust checks', () => {
  for (const command of [
    'cargo clippy --locked --all-targets -- -D warnings',
    'cargo build --release --locked',
    'cargo test --locked --all-targets',
    'cargo doc --locked --no-deps',
  ]) {
    const mutated = workflow.replace(command, 'echo omitted');
    assert.throws(() => validate({ workflow: mutated }), new RegExp(command.split(' ')[1]));
  }
});

test('rejects false certification in the generic generated lane', () => {
  const mutated = genericWorkflow
    .replace("const sourceAccessPassed = result === 'success';", "const certified = result === 'success';")
    .replace('sourceAccessPassed,\n            certified: false,', 'certified,');
  assert.throws(
    () => validate({ genericWorkflow: mutated }),
    /source access separately|must never certify product source|false certification logic/,
  );
});

test('rejects source-pin and test-plan drift', () => {
  const pinDrift = clone(sourcePins);
  pinDrift.sources['fiducia-cloud/fiducia-mcp-server.rs'].sha = '0000000000000000000000000000000000000000';
  assert.throws(() => validate({ sourcePins: pinDrift }), /source pin SHA drifted/);

  const planDrift = clone(testPlan);
  planDrift.requiredChecks = planDrift.requiredChecks.filter(
    (check) => check !== 'exact-public-source-integration',
  );
  assert.throws(() => validate({ testPlan: planDrift }), /exact integration check is missing/);
});

test('strict JSON parsing rejects ambiguous generated policy', () => {
  assert.throws(
    () => parseJsonStrict('{"security":{"exact":true,"exact":false}}', 'duplicate policy'),
    /duplicate object key/,
  );
  assert.throws(
    () => parseJsonStrict('{"sha":"a","\\u0073ha":"b"}', 'escaped duplicate'),
    /duplicate object key/,
  );
});
