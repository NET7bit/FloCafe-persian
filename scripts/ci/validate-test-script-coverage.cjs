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

  const reachable = new Set(['pretest', 'test', ...manifest]);
  const pending = [...reachable];

  while (pending.length > 0) {
    const scriptName = pending.shift();
    const command = scripts[scriptName] || '';
    for (const dependency of extractExecutedTestScripts(command)) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }

  const testScripts = Object.keys(scripts).filter((name) => name.startsWith('test:'));
  const missing = testScripts.filter((name) => !reachable.has(name) && !TEST_EXCLUSIONS[name]);
  const stale = Object.keys(TEST_EXCLUSIONS).filter((name) => !scripts[name] || reachable.has(name));
  const invalidReasons = Object.entries(TEST_EXCLUSIONS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 12)
    .map(([name]) => name);

  if (missing.length || stale.length || invalidReasons.length || manifestInvalid.length) {
    if (missing.length) console.error(`Uncovered test scripts: ${missing.join(', ')}`);
    if (stale.length) console.error(`Stale test exclusions: ${stale.join(', ')}`);
    if (invalidReasons.length) console.error(`Test exclusions without a useful reason: ${invalidReasons.join(', ')}`);
    if (manifestInvalid.length) console.error(`Suite manifest references missing or excluded scripts: ${manifestInvalid.join(', ')}`);
    process.exit(1);
  }

  console.log(`Test script coverage OK: ${reachable.size - 2} reachable (${manifest.length} in the suite manifest), ${Object.keys(TEST_EXCLUSIONS).length} explicitly excluded.`);
}

if (require.main === module) main();

module.exports = { extractExecutedTestScripts, TEST_EXCLUSIONS, loadSuiteManifest };
