// Grader for bugfix-off-by-one: passes iff `node --test` exits 0 in the
// attempt's workspace (the fixed sum.js makes sum.test.js pass).
const { spawnSync } = require('node:child_process');

// Strip NODE_TEST_CONTEXT so this spawnSync isn't silently skipped when
// grade.js itself runs from a process already under `node --test` (e.g.
// this project's own self-test suite) — Node's test runner treats a nested
// `node --test` child as a recursive invocation and skips it, exiting 0
// with zero tests run, which would otherwise masquerade as a false pass.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function grade(ctx) {
  const res = spawnSync(process.execPath, ['--test', 'sum.test.js'], {
    cwd: ctx.workspace,
    encoding: 'utf-8',
    timeout: 30000,
    env: childEnv(),
  });
  const pass = res.status === 0;
  const notes = pass
    ? 'node --test exited 0'
    : `node --test exited ${res.status}\n${(res.stdout || '') + (res.stderr || '')}`.slice(0, 2000);
  return { pass, notes };
}

module.exports = { grade };
