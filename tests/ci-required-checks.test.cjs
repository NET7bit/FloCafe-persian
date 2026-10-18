'use strict';

// Regression tests for the CI required-checks gate. If a job that can fail for
// a PR is ever dropped from `required-checks-gate.needs`, its red status would
// no longer block the gate — a silent pass. This test pins the gate to cover
// every job defined in .github/workflows/ci.yml except the gate itself, so a
// removal or addition fails here until both files are updated together.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml');

const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
assert.ok(workflow && workflow.jobs, 'ci.yml must define jobs');

const jobNames = Object.keys(workflow.jobs);
const gate = workflow.jobs['required-checks-gate'];
assert.ok(gate, 'ci.yml must define required-checks-gate');
assert.ok(Array.isArray(gate.needs) && gate.needs.length > 0, 'required-checks-gate must list needs');

// The gate must depend on every other job in the workflow.
const expected = jobNames.filter((name) => name !== 'required-checks-gate').sort();
assert.deepEqual(
  [...gate.needs].sort(),
  expected,
  'required-checks-gate must need every workflow job (a dropped job lets its failure hide)',
);

// The gate script must inspect each required job's result, not just declare the
// dependency. Skipped is tolerated only because path filters legitimately skip
// jobs; `changes` must always succeed because its outputs drive those skips.
const run = String(gate.steps.map((s) => s.run).join('\n'));
assert.ok(run.includes('needs.changes.result'), 'gate must verify the changes job result');
for (const job of gate.needs) {
  if (job === 'changes') continue;
  assert.ok(
    run.includes(`needs.${job}.result`),
    `gate must verify the result of required job ${job}`,
  );
}
assert.ok(
  run.includes('"skipped"'),
  'gate must document/tolerate path-filtered skips instead of treating them as failures',
);

console.log(`CI required-checks gate covers ${gate.needs.length}/${jobNames.length} jobs.`);
