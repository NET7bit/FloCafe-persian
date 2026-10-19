'use strict';

// Regression tests for the ESLint warning ratchet. The approved Phase A
// contract (owner decision 2026-10-14, option R1):
//   1. A warning count above the recorded baseline must fail CI.
//   2. Reductions are always allowed, and the ceiling may be lowered.
//   3. Raising the ceiling above the recorded baseline must fail, so greenifying
//      CI cannot silently weaken the control.
// Enforcement chain:
//   - live check:  scripts/ci/check-lint-budget.cjs (counts > ceiling -> fail;
//                  ceiling > baseline -> fail), run by linux-baseline in CI.
//   - this test:   pins the approved numbers so any ceiling/baseline edit is a
//                  deliberate, review-visible change.
//   - baseline:    scripts/ci/lint-warning-baseline.json records the measured
//                  counts, date and counting method.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RATCHET = { backend: 1026, frontend: 5 };

const budget = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'lint-budget.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'lint-warning-baseline.json'), 'utf8'));

// 1. The active ceiling is exactly the approved baseline: an increase over the
//    baseline fails here (and in check-lint-budget.cjs); a decrease would also
//    fail here until the ratchet constant is deliberately re-approved.
assert.deepEqual(budget, RATCHET, 'lint-budget.json ceilings must equal the approved ratchet baseline');

// 2. The recorded baseline matches the approved numbers and documents itself.
assert.deepEqual(baseline.counts, RATCHET, 'lint-warning-baseline.json counts must match the approved ratchet baseline');
assert.ok(typeof baseline.recorded_at === 'string' && baseline.recorded_at.length >= 10, 'baseline must record its measurement date');
assert.ok(typeof baseline.method === 'string' && baseline.method.length >= 20, 'baseline must document the counting method');

console.log(`Lint warning ratchet pinned: backend ${RATCHET.backend}, frontend ${RATCHET.frontend} (baseline ${baseline.recorded_at}).`);
