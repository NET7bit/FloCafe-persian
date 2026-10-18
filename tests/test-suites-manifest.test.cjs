'use strict';

// Regression tests for the canonical suite manifest (scripts/ci/test-suites.json).
// Guards against accidental omission, duplication or order drift of suites, and
// pins `npm test` to the orchestrator (scripts/run-test-suite.cjs) so an
// oversized `&&` chain cannot silently come back.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSuiteManifest, TEST_EXCLUSIONS } = require('../scripts/ci/validate-test-script-coverage.cjs');
const { loadManifest, buildCommand } = require('../scripts/run-test-suite.cjs');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const suiteManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/test-suites.json'), 'utf8'));

// 1. The official `npm test` must go through the orchestrator so the chain is
//    never rebuilt as one giant shell command.
assert.equal(
  pkg.scripts.test,
  'node scripts/run-test-suite.cjs',
  'npm test must delegate to scripts/run-test-suite.cjs',
);

// 2. The validator and the orchestrator must agree on the same manifest file.
assert.deepEqual(
  loadSuiteManifest(),
  loadManifest(),
  'coverage validator and orchestrator must read the same canonical suite manifest',
);

// 3. No duplicates, no missing scripts, nothing excluded listed, order stable.
assert.equal(suiteManifest.length, loadManifest().length, 'suite count must match the orchestrator manifest');
assert.equal(new Set(suiteManifest).size, suiteManifest.length, 'suite manifest must not contain duplicates');

for (const suite of suiteManifest) {
  assert.ok(pkg.scripts[suite], `manifest suite ${suite} must exist in package.json scripts`);
  assert.ok(!TEST_EXCLUSIONS[suite], `excluded e2e/alias suite ${suite} must not be in the default manifest`);
}

// 4. Every default-runnable test script must be in the manifest or covered by
//    the validator's reachability walk; the validator exits nonzero otherwise.
{
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/ci/validate-test-script-coverage.cjs'),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `coverage validator failed: ${result.stdout} ${result.stderr}`);
}

// 5. Order snapshot: the manifest is the canonical order; spot-check anchors so
//    accidental reordering or omission of leading/trailing suites is caught.
assert.equal(suiteManifest[0], 'test:smoke', 'suite manifest must start with test:smoke');
assert.equal(suiteManifest[suiteManifest.length - 1], 'test:accounting-ui', 'suite manifest must end with test:accounting-ui');

// 6. The orchestrator wraps each suite identically to the historical wrapper,
//    preserving the exit-77-to-success mapping.
assert.deepEqual(buildCommand('test:smoke'), ['tests/run-test.sh', 'npm', 'run', 'test:smoke']);

console.log('Suite manifest integrity verified.');