#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_PATH = path.join(__dirname, 'test-suites.json');

const TEST_EXCLUSIONS = {
  'test:e2e:server': 'Long-running server process used by the dedicated Playwright jobs.',
  'test:e2e:browser': 'Runs in the dedicated browser Playwright CI job.',
  'test:e2e:electron': 'Runs in the dedicated native Electron Playwright CI job.',
  'test:e2e': 'Alias for the dedicated browser Playwright job.',
  'test:upgrade-regression': 'Alias of test:upgrade-path, which is in the default suite.',
  'test:currency-split': 'Subset alias already executed by test:currency in the default suite.',
};

/**
 * Suite files that the default run does not execute, keyed by file.
 *
 * Script-level reachability is not enough on its own: a `tests/*.test.ts` file
 * can exist while no reachable command ever names it, and the run stays green.
 * Every entry here must still exist on disk and must genuinely be unreachable;
 * the validator fails on a stale or self-contradicting entry.
 */
const TEST_FILE_EXCLUSIONS = {
  'tests/db-audit.test.ts': 'Run on demand by `npm run audit:db`; it inspects a live database, so it is not part of the default suite.',
};

/** Runner executables whose command line can name a suite file. */
const TEST_RUNNERS = new Set(['node', 'ts-node', 'tsx', 'npx', 'electron', 'cross-env', 'jest', 'vitest', 'mocha']);

/** Suite files live flat under `tests/`; anything else is a helper, not a suite. */
const TEST_FILE_PATTERN = /^tests\/[^/\s]+\.test\.(?:ts|cjs|js|mjs)$/;

// Splits on top-level `&&`, `||`, and `;`, leaving text inside '...' or "..."
// quotes untouched so a quoted operator can't fake a command boundary.
function splitTopLevelCommands(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function extractExecutedTestScripts(command) {
  const commandStartPattern = /^(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test(?::[\w:-]+)?)(?:\s|$)/;
  return splitTopLevelCommands(command)
    .map((segment) => segment.trim().match(commandStartPattern))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * Replaces quoted regions with spaces.
 *
 * A suite path that only appears inside `echo "tests/x.test.ts"` is printed, not
 * executed, so it must not count as coverage.
 */
function stripQuotedRegions(command) {
  return command.replace(/"[^"]*"|'[^']*'/g, ' ');
}

/** Drops a `bash tests/run-test.sh` wrapper and returns the wrapped command's tokens. */
function unwrapRunnerTokens(tokens) {
  if (tokens[0] === 'bash' && tokens[1] === 'tests/run-test.sh') return tokens.slice(2);
  if (tokens[0] === 'tests/run-test.sh') return tokens.slice(1);
  return tokens;
}

/**
 * Suite files a single script command actually executes.
 *
 * Only segments that start with a test runner count, so a bare path or a printed
 * path invokes nothing. A file named twice is reported once, in first-seen order.
 */
function extractReferencedTestFiles(command) {
  const files = new Set();
  for (const segment of splitTopLevelCommands(command)) {
    const tokens = unwrapRunnerTokens(stripQuotedRegions(segment).trim().split(/\s+/).filter(Boolean));
    if (tokens.length === 0 || !TEST_RUNNERS.has(tokens[0])) continue;
    for (const token of tokens) {
      const candidate = token.replace(/^[("']+|[)"',]+$/g, '');
      if (TEST_FILE_PATTERN.test(candidate)) files.add(candidate);
    }
  }
  return [...files];
}

/**
 * Scripts the default run reaches: the seed names plus anything they call with
 * `npm run test:*`, transitively. Non-test scripts such as `lint` stop the walk.
 *
 * `test` delegates to the suite orchestrator, whose effective command is the
 * manifest rather than a literal `npm run test:*` chain, so the manifest entries
 * are seeds whenever that delegation is present.
 */
function collectReachableScripts(scripts, seedNames = ['pretest', 'test']) {
  const seed = new Set(seedNames);
  if (/\bscripts\/run-test-suite\.cjs\b/.test(scripts.test || '')) {
    for (const name of loadSuiteManifest()) seed.add(name);
  }
  const reachable = new Set(seed);
  const pending = [...reachable];
  while (pending.length > 0) {
    const scriptName = pending.shift();
    for (const dependency of extractExecutedTestScripts(scripts[scriptName] || '')) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return reachable;
}

/** Every suite file on disk, as repo-relative POSIX paths. */
function listTestFiles() {
  const testsDir = path.join(__dirname, '..', '..', 'tests');
  return fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.(?:ts|cjs|js|mjs)$/.test(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

// Root `npm test` now delegates to the orchestrator, so the canonical suite
// inventory (scripts/ci/test-suites.json) replaces direct parsing of the test
// command. Seed reachability from the manifest plus pretest, then follow any
// `npm run test:*` calls nested inside individual suite commands.
function loadSuiteManifest() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Test manifest ${MANIFEST_PATH} must be an array of script names.`);
  }
  const seen = new Set();
  for (const name of raw) {
    if (typeof name !== 'string' || !name.startsWith('test:')) {
      throw new Error(`Test manifest contains a non test:* entry: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new Error(`Test manifest lists ${name} more than once.`);
    }
    seen.add(name);
  }
  return raw;
}

function main() {
  const packagePath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts || {};

  let manifest = [];
  try {
    manifest = loadSuiteManifest();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // The manifest is authoritative, so every entry must point at a real script
  // and must not carry a dedicated execution slot in the default run.
  const manifestInvalid = manifest.filter(
    (name) => !scripts[name] || TEST_EXCLUSIONS[name],
  );

  const reachable = collectReachableScripts(scripts);

  const testScripts = Object.keys(scripts).filter((name) => name.startsWith('test:'));
  const missing = testScripts.filter((name) => !reachable.has(name) && !TEST_EXCLUSIONS[name]);
  const stale = Object.keys(TEST_EXCLUSIONS).filter((name) => !scripts[name] || reachable.has(name));
  const invalidReasons = Object.entries(TEST_EXCLUSIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 12)
    .map(([name]) => name);

  // File-level coverage: script reachability says nothing about whether the
  // suites those scripts name actually cover every file on disk.
  const referencedFiles = new Set();
  for (const name of reachable) {
    for (const file of extractReferencedTestFiles(scripts[name] || '')) referencedFiles.add(file);
  }
  const testFiles = listTestFiles();
  const uncoveredFiles = testFiles.filter((file) => !referencedFiles.has(file) && !TEST_FILE_EXCLUSIONS[file]);
  const staleFileExclusions = Object.keys(TEST_FILE_EXCLUSIONS).filter(
    (file) => !testFiles.includes(file) || referencedFiles.has(file),
  );
  const invalidFileReasons = Object.entries(TEST_FILE_EXCLUSIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 12)
    .map(([file]) => file);

  if (
    missing.length
    || stale.length
    || invalidReasons.length
    || manifestInvalid.length
    || uncoveredFiles.length
    || staleFileExclusions.length
    || invalidFileReasons.length
  ) {
    if (missing.length) console.error(`Uncovered test scripts: ${missing.join(', ')}`);
    if (stale.length) console.error(`Stale test exclusions: ${stale.join(', ')}`);
    if (invalidReasons.length) console.error(`Test exclusions without a useful reason: ${invalidReasons.join(', ')}`);
    if (manifestInvalid.length) console.error(`Suite manifest references missing or excluded scripts: ${manifestInvalid.join(', ')}`);
    if (uncoveredFiles.length) console.error(`Suite files no reachable command executes: ${uncoveredFiles.join(', ')}`);
    if (staleFileExclusions.length) console.error(`Stale suite-file exclusions: ${staleFileExclusions.join(', ')}`);
    if (invalidFileReasons.length) console.error(`Suite-file exclusions without a useful reason: ${invalidFileReasons.join(', ')}`);
    process.exit(1);
  }

  console.log(
    `Test script coverage OK: ${reachable.size - 2} reachable (${manifest.length} in the suite manifest), `
      + `${Object.keys(TEST_EXCLUSIONS).length} explicitly excluded, `
      + `${testFiles.length - Object.keys(TEST_FILE_EXCLUSIONS).length}/${testFiles.length} suite files executed.`,
  );
}

if (require.main === module) main();

module.exports = {
  extractExecutedTestScripts,
  extractReferencedTestFiles,
  collectReachableScripts,
  listTestFiles,
  TEST_EXCLUSIONS,
  TEST_FILE_EXCLUSIONS,
  loadSuiteManifest,
};
