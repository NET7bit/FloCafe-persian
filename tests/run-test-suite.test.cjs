'use strict';

// Regression tests for scripts/run-test-suite.cjs. These exercise the pure
// orchestration logic with an injected runner; they never launch real suites
// or touch the application database.

const assert = require('node:assert/strict');
const { buildCommand, runChain } = require('../scripts/run-test-suite.cjs');

// Fail-fast: a failing suite stops the chain; a later suite is never run.
{
  const launched = [];
  const failed = runChain(['test:a', 'test:b', 'test:c'], (suite) => {
    launched.push(suite);
    return suite === 'test:b' ? { status: 7 } : { status: 0 };
  });
  assert.deepEqual(launched, ['test:a', 'test:b'], 'chain must stop on first failure');
  assert.deepEqual(failed, { suite: 'test:b', status: 7 }, 'first failing suite and its exit code must be reported');
}

// Full pass returns null and runs every suite exactly once in order.
{
  const launched = [];
  const failed = runChain(['test:a', 'test:b'], (suite) => {
    launched.push(suite);
    return { status: 0 };
  });
  assert.equal(failed, null, 'all-pass chain returns null');
  assert.deepEqual(launched, ['test:a', 'test:b'], 'every suite runs exactly once, in order');
}

// Exit code 0 on one suite does not stop the chain.
{
  const launched = [];
  runChain(['test:a', 'test:b'], (suite) => {
    launched.push(suite);
    return { status: 0 };
  });
  assert.equal(launched.length, 2);
}

// buildCommand preserves the wrapper and produces argument arrays (no shell
// string to mangle), so tokens with spaces stay intact.
{
  assert.deepEqual(
    buildCommand('test:smoke'),
    ['tests/run-test.sh', 'npm', 'run', 'test:smoke'],
    'each suite wraps through tests/run-test.sh with npm run target as separate argv'
  );
}

// A runner signalling spawn failure (error) is treated as a hard failure.
{
  const failed = runChain(['test:a'], () => ({ error: new Error('boom'), status: null }));
  assert.equal(failed.status, null, 'spawn errors must be surfaced so the chain stops');
}

console.log('run-test-suite orchestrator verified.');
