#!/usr/bin/env node
/*
 * CI test sharding for the FloCafe "Core test suite" (`npm test`).
 *
 * The canonical, ordered suite list lives in scripts/ci/test-suites.json — the
 * same manifest that scripts/run-test-suite.cjs (the `npm test` orchestrator)
 * consumes. Reading that single source here means shard coverage cannot drift
 * from the manifest and the orchestrator, and an orchestrator rewrite cannot
 * silently empty the shards.
 *
 * Usage:
 *   SHARD_TOTAL=2 SHARD_INDEX=0 node scripts/ci/run-test-shard.cjs
 *   FLO_TEST_SHARD_DRY_RUN=1 SHARD_TOTAL=2 SHARD_INDEX=0 node scripts/ci/run-test-shard.cjs
 *     (prints this shard's suite list without executing anything)
 *
 * Shards are assigned round-robin by manifest position. The `pretest` hook is
 * intentionally NOT run here; CI runs it as its own step before the shards,
 * mirroring `npm test`'s pretest.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { loadManifest } = require('../run-test-suite.cjs');

function parseIntEnv(name, value, fallback, min) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    console.error(`Invalid ${name}=${value}: expected an integer >= ${min}.`);
    process.exit(2);
  }
  return n;
}

const total = parseIntEnv('SHARD_TOTAL', process.env.SHARD_TOTAL, 2, 1);
const index = parseIntEnv('SHARD_INDEX', process.env.SHARD_INDEX, 0, 0);
if (index >= total) {
  console.error(`Invalid SHARD_INDEX=${index}: must be < SHARD_TOTAL=${total}.`);
  process.exit(2);
}

const DRY_RUN = process.env.FLO_TEST_SHARD_DRY_RUN === '1';

/**
 * Loads the canonical suite manifest through the same strict validator the
 * `npm test` orchestrator uses (JSON array of unique, existing `test:*`
 * scripts). Any structural problem exits 2 with an explicit message instead of
 * silently sharding an empty or partial suite list.
 */
function loadSuites() {
  let suites;
  try {
    suites = loadManifest();
  } catch (err) {
    console.error(`Cannot load the canonical suite manifest: ${err.message}`);
    process.exit(2);
  }
  if (suites.length === 0) {
    console.error('Test suite manifest is empty; refusing to shard zero suites.');
    process.exit(2);
  }
  return suites;
}

const suites = loadSuites();

const mine = suites.filter((_, i) => i % total === index);
console.log(
  `[test-shard] shard ${index}/${total}: ${mine.length}/${suites.length} suites (manifest: scripts/ci/test-suites.json).`,
);

if (DRY_RUN) {
  console.log(`[test-shard] dry run; shard ${index} suites:`);
  for (const suite of mine) console.log(`  ${suite}`);
  process.exit(0);
}

let failed = false;
for (const suite of mine) {
  console.log(`\n=== [shard ${index}] ${suite} ===`);
  const result = spawnSync('bash', ['tests/run-test.sh', 'npm', 'run', suite], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`[shard ${index}] FAILED: ${suite}`);
    failed = true;
    break;
  }
}

process.exit(failed ? 1 : 0);
