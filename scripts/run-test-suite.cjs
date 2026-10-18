'use strict';

// Runs the ordered test-suite manifest as child processes instead of one giant
// shell chain. The previous `test` script joined ~200 `npm run test:*` calls
// with `&&`; on Windows npm launches that through `cmd.exe`, whose 8191-char
// command-line limit made `npm test` fail to start with "The command line is
// too long." Spawning one suite at a time keeps the effective command short.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'scripts', 'ci', 'test-suites.json');

// Resolve the same bash the repo's own tests/run-test.sh wrapper relies on.
function resolveBash() {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      'The test suite needs bash on PATH (tests/run-test.sh and the suites it wraps are shell scripts). ' +
        'Install Git for Windows or another bash and add it to PATH, then re-run npm test.'
    );
  }
}

function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Test manifest ${manifestPath} must be an array of script names.`);
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
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of raw) {
    if (!pkg.scripts || !pkg.scripts[name]) {
      throw new Error(`Test manifest lists ${name} but package.json has no such script.`);
    }
  }
  return raw;
}

// Build the exact argv the official chain used per suite, so the wrapper's
// exit-77-to-success mapping and per-suite shell execution are preserved.
function buildCommand(suite) {
  return ['tests/run-test.sh', 'npm', 'run', suite];
}

// rns the suites in order and returns the first failing suite, or null.
// `runner` is injectable for tests; production uses spawnSync(bash, argv).
function runChain(suites, runner) {
  for (const suite of suites) {
    const result = runner(suite);
    if (result && result.status !== 0) {
      return { suite, status: result.status };
    }
  }
  return null;
}

function main(argv) {
  const manifestPath = argv[0] ? path.resolve(ROOT, argv[0]) : DEFAULT_MANIFEST;
  let suites;
  try {
    suites = loadManifest(manifestPath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  resolveBash();

  const runner = (suite) => {
    console.log(`\n### ${suite}`);
    const result = spawnSync('bash', buildCommand(suite), {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(`Failed to launch ${suite}: ${result.error.message}`);
      return { status: 1 };
    }
    if (result.status === 0) {
      console.log(`### ${suite} PASS`);
    } else {
      console.error(`### ${suite} FAIL (exit ${result.status})`);
    }
    return { status: result.status };
  };

  const failed = runChain(suites, runner);
  if (failed) {
    console.error(`\nSuite chain stopped on ${failed.suite} (exit ${failed.status}).`);
    process.exit(failed.status || 1);
  }
  console.log(`\nAll ${suites.length} suites passed.`);
}

module.exports = { buildCommand, loadManifest, runChain };

if (require.main === module) main(process.argv.slice(2));
