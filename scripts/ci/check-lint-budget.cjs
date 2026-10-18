#!/usr/bin/env node
// Fails CI if ESLint warning counts exceed the recorded budget in lint-budget.json.
// Per docs' stabilization plan Phase 4: no cleanup campaign — the budget only
// ratchets down manually as warnings are fixed incidentally while touching a file.
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const BUDGET_PATH = path.join(__dirname, 'lint-budget.json');
const BASELINE_PATH = path.join(__dirname, 'lint-warning-baseline.json');
const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));

// Ratchet anchor: ceilings in lint-budget.json may never sit above the
// recorded baseline in lint-warning-baseline.json. Raising the ceiling above
// the valid baseline (or re-recording the baseline) is a reviewed, explicit
// act — never a side effect of greenifying CI. A missing baseline file is a
// hard error, so the anchor cannot be quietly deleted.
let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
} catch (err) {
  console.error(`Cannot read lint warning baseline ${BASELINE_PATH}: ${err.message}`);
  process.exit(1);
}
if (!baseline || typeof baseline !== 'object' || !baseline.counts) {
  console.error(`Lint warning baseline ${BASELINE_PATH} is malformed (missing counts).`);
  process.exit(1);
}

function countWarnings(cwd, args) {
  let stdout;
  try {
    stdout = execFileSync('npx', ['eslint', ...args, '--format', 'json'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      // `npx` is a .cmd shim on Windows and cannot be spawned directly.
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // eslint exits non-zero when it reports any error/warning; stdout still has the JSON report.
    stdout = err.stdout;
    if (!stdout) throw err;
  }
  const results = JSON.parse(stdout);
  return results.reduce((sum, file) => sum + file.warningCount, 0);
}

const backendCount = countWarnings(ROOT, ['main/', 'shared/']);
const frontendCount = countWarnings(path.join(ROOT, 'frontend'), ['.']);

let failed = false;
for (const [name, count] of [['backend', backendCount], ['frontend', frontendCount]]) {
  const limit = budget[name];
  const baselineCount = baseline.counts[name];
  if (typeof limit !== 'number' || typeof baselineCount !== 'number') {
    console.error(`Lint warning budget/baseline missing a numeric value for ${name}.`);
    failed = true;
    continue;
  }
  if (limit > baselineCount) {
    console.error(`Lint warning ceiling for ${name} (${limit}) exceeds the recorded baseline (${baselineCount}); ratchet violated.`);
    failed = true;
  }
  if (count > limit) {
    console.error(`Lint warning budget exceeded for ${name}: ${count} warnings (budget: ${limit}).`);
    failed = true;
  } else {
    console.log(`Lint warning budget OK for ${name}: ${count} warnings (budget: ${limit}, baseline: ${baselineCount}).`);
  }
}

if (failed) {
  console.error('\nLower this by fixing warnings, not by raising the budget, unless the increase is a deliberate, reviewed tradeoff.');
  process.exit(1);
}
