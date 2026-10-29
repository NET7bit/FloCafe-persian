#!/usr/bin/env node
// Tests-project TypeScript gate: fails when `tests/tsconfig.json` reports more
// errors than the recorded per-file baseline in tests-typecheck-baseline.json.
//
// Why a baseline instead of a green gate: the tests project treats every
// CommonJS test file as a global script, so top-level declarations collide
// across files (TS2451/TS2393/TS6200), and it compiles production files with
// different lib/paths/strictness settings than the backend and frontend
// projects. Making it green needs a repo-wide test rewrite, so this gate
// ratchets instead: pre-existing errors are accepted, new ones fail, and fixing
// errors is always free (only `current - baseline > 0` per file counts).
//
// Module mode (added by the D.10-H.11O diagnosis). runTypeScript passes
// `--moduleDetection force` to tsc below. Two claims above are superseded by
// measurement and must be read with this paragraph in mind:
//   * "Making it green needs a repo-wide test rewrite" — not needed for the
//     type-check layer; this one flag does it: 2217 -> 377 errors and 1398 -> 0
//     collision diagnostics (TS6200/TS2451/TS2393), with no new errors anywhere.
//   * "fixing errors is always free" — NOT true for a local fix. Adding `export {}`
//     to a single anchor file un-masks its peers' collisions: the totals went to
//     2619 errors with 514 new ones across 100 files, because TS6200 aggregates one
//     line per conflicting peer and was hiding the per-identifier TS2451s.
// The flag is passed HERE on purpose and is deliberately NOT written into
// tests/tsconfig.json: that file is also handed to ts-node (`-P tests/tsconfig.json`)
// by tests/run-electron-node-test.cjs and the per-suite npm scripts, so a tsconfig
// change could alter the emit of ~145 import/export-free scripts, whereas this flag
// cannot reach ts-node at all.
//
// Baseline ownership: scripts/ci/tests-typecheck-baseline.json, owned by this
// gate. Format: sorted per-file error counts plus project/compiler/total
// metadata; no timestamps or environment-specific values. Update policy: run
// `npm run typecheck:tests:update` only when the change to the error set is
// intentional and reviewed; never raise it to hide errors from an unrelated
// change.
//
// Usage:
//   node scripts/ci/check-tests-typecheck.cjs [--project tests/tsconfig.json]
//                                             [--baseline <path>] [--update]
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROJECT = 'tests/tsconfig.json';
const DEFAULT_BASELINE = path.join(__dirname, 'tests-typecheck-baseline.json');
const SOURCE_ROOTS = ['tests', 'main', 'shared', 'frontend'];
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

function parseArgs(argv) {
  const options = { project: DEFAULT_PROJECT, baseline: DEFAULT_BASELINE, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update') options.update = true;
    else if (arg === '--project') options.project = argv[++i];
    else if (arg === '--baseline') options.baseline = path.resolve(argv[++i]);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

// Keys stay stable across checkouts, symlinked scratch trees, and platforms:
// keep everything from the first `tests|main|shared|frontend` segment onwards.
function normalizeFile(file) {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  let best = null;
  for (const root of SOURCE_ROOTS) {
    for (const needle of [`/${root}/`, `${root}/`]) {
      const index = normalized.indexOf(needle);
      if (index === -1) continue;
      const candidate = normalized.slice(needle.startsWith('/') ? index + 1 : index);
      if (best === null || candidate.length > best.length) best = candidate;
    }
  }
  return best ?? normalized;
}

function runTypeScript(projectPath) {
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscBin)) {
    console.error(`TypeScript is not installed at ${path.relative(ROOT, tscBin)}; run npm ci first.`);
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [tscBin, '-p', projectPath, '--noEmit', '--pretty', 'false', '--moduleDetection', 'force'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 },
  );
  if (result.error) {
    console.error(`Failed to run TypeScript: ${result.error.message}`);
    process.exit(1);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function collectErrors(output) {
  const files = new Map();
  let total = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    total += 1;
    const key = normalizeFile(match[1]);
    files.set(key, (files.get(key) || 0) + 1);
  }
  return { total, files };
}

function compilerVersion() {
  try {
    return require(path.join(ROOT, 'node_modules', 'typescript', 'package.json')).version;
  } catch {
    return 'unknown';
  }
}

function sortedCounts(files) {
  return Object.fromEntries([...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function writeBaseline(baselinePath, project, files, total) {
  const payload = {
    project,
    typescript: compilerVersion(),
    total,
    files: sortedCounts(files),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function loadBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    console.error(`Missing baseline ${path.relative(ROOT, baselinePath)}; create it with --update.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  return { files: new Map(Object.entries(payload.files || {})), total: payload.total, typescript: payload.typescript };
}

const options = parseArgs(process.argv.slice(2));
const projectPath = path.resolve(ROOT, options.project);
if (!fs.existsSync(projectPath)) {
  console.error(`Missing project ${path.relative(ROOT, projectPath)}.`);
  process.exit(1);
}

const output = runTypeScript(projectPath);
const current = collectErrors(output);

// A non-zero TypeScript exit without parsable diagnostics means the project
// itself failed (bad config, missing file): report it instead of passing.
if (current.total === 0) {
  const tail = output.trim().split(/\r?\n/).slice(-5).join('\n');
  const tailText = tail ? `\n${tail}` : '';
  if (!/error TS/.test(output)) {
    console.log(`Tests TypeScript gate: no errors reported by ${options.project}.`);
    if (options.update) writeBaseline(options.baseline, options.project, current.files, 0);
    process.exit(0);
  }
  console.error(`Could not parse TypeScript diagnostics for ${options.project}:${tailText}`);
  process.exit(1);
}

if (options.update) {
  writeBaseline(options.baseline, options.project, current.files, current.total);
  console.log(
    `Tests TypeScript baseline updated: ${current.total} errors across ${current.files.size} files ` +
      `(${path.relative(ROOT, options.baseline)}).`,
  );
  process.exit(0);
}

const baseline = loadBaseline(options.baseline);
if (baseline.typescript && baseline.typescript !== compilerVersion()) {
  console.warn(
    `Note: baseline was recorded with TypeScript ${baseline.typescript}, current compiler is ${compilerVersion()}.`,
  );
}

const newByFile = [];
let newTotal = 0;
let resolvedTotal = 0;
for (const [file, count] of current.files) {
  const base = baseline.files.get(file) || 0;
  if (count > base) {
    newByFile.push({ file, added: count - base, baseline: base, current: count });
    newTotal += count - base;
  }
}
for (const [file, count] of baseline.files) {
  const now = current.files.get(file) || 0;
  if (now < count) resolvedTotal += count - now;
}

console.log(`Tests TypeScript gate (${options.project})`);
console.log(`  baseline: ${baseline.total} errors across ${baseline.files.size} files`);
console.log(`  current:  ${current.total} errors across ${current.files.size} files`);
console.log(`  new: ${newTotal} (${newByFile.length} files), resolved: ${resolvedTotal}`);

if (newTotal === 0) {
  console.log('Tests TypeScript gate PASS — no new errors.');
  process.exit(0);
}

newByFile.sort((a, b) => b.added - a.added);
console.error('\nNew TypeScript errors in the tests project:');
for (const entry of newByFile.slice(0, 20)) {
  console.error(`  +${entry.added}  ${entry.file} (baseline ${entry.baseline}, now ${entry.current})`);
}
if (newByFile.length > 20) console.error(`  ...and ${newByFile.length - 20} more files`);
console.error(
  '\nFix the new errors. Only re-record the baseline with `npm run typecheck:tests:update` when the\n' +
    'change to the error set is itself the reviewed intent of the commit.',
);
process.exit(1);
