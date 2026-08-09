import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateSourcePinDocuments } from './validate-source-pin-drift.mjs';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const sourcePins = JSON.parse(fs.readFileSync(new URL('../source-pins.json', import.meta.url), 'utf8'));
const testPlan = JSON.parse(fs.readFileSync(new URL('../test-plan.json', import.meta.url), 'utf8'));
const remoteHead = sourcePins.sources['fiducia-cloud/fiducia-mcp-server.rs'].sha;

function clone(value) {
  return structuredClone(value);
}

function validate(overrides = {}) {
  return validateSourcePinDocuments({
    readme,
    sourcePins,
    testPlan,
    remoteHead,
    ...overrides,
  });
}

test('accepts aligned README, source-pins, test-plan, and remote main', () => {
  const evidence = validate();
  assert.equal(evidence.sourceSha, remoteHead);
  assert.equal(evidence.readmeSha, evidence.sourcePinsSha);
  assert.equal(evidence.sourcePinsSha, evidence.testPlanSha);
});

test('rejects README pin drift', () => {
  const mutatedReadme = readme.replace(remoteHead, '0000000000000000000000000000000000000000');
  assert.throws(() => validate({ readme: mutatedReadme }), /README and machine-readable source SHAs disagree/);
});

test('rejects source-pins drift', () => {
  const mutated = clone(sourcePins);
  mutated.sources['fiducia-cloud/fiducia-mcp-server.rs'].sha = '0000000000000000000000000000000000000000';
  assert.throws(() => validate({ sourcePins: mutated }), /source-pins and test-plan SHAs disagree/);
});

test('rejects test-plan drift', () => {
  const mutated = clone(testPlan);
  mutated.sources[0].sha = '0000000000000000000000000000000000000000';
  assert.throws(() => validate({ testPlan: mutated }), /source-pins and test-plan SHAs disagree/);
});

test('rejects a moved remote main head', () => {
  assert.throws(
    () => validate({ remoteHead: '0000000000000000000000000000000000000000' }),
    /MCP source main moved/,
  );
});

test('rejects an additional source repository', () => {
  const mutated = clone(sourcePins);
  mutated.sources['attacker/alternate-mcp-server'] = {
    branch: 'main',
    sha: remoteHead,
    exists: true,
  };
  assert.throws(() => validate({ sourcePins: mutated }), /exactly the reviewed MCP source/);
});

test('rejects a non-main source branch', () => {
  const mutated = clone(sourcePins);
  mutated.sources['fiducia-cloud/fiducia-mcp-server.rs'].branch = 'dev';
  assert.throws(() => validate({ sourcePins: mutated }), /source-pins branch drifted/);
});

test('rejects credential-shaped values in generated documents', () => {
  const mutated = clone(testPlan);
  mutated.description = 'github_pat_not_a_real_but_still_forbidden_value';
  assert.throws(() => validate({ testPlan: mutated }), /credential-shaped value/);
});
