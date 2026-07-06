// Grader for bugfix-off-by-one: passes iff `node --test` exits 0 in the
// attempt's workspace (the fixed sum.js makes sum.test.js pass).
const { spawnSync } = require('node:child_process');

async function grade(ctx) {
  const res = spawnSync(process.execPath, ['--test', 'sum.test.js'], {
    cwd: ctx.workspace,
    encoding: 'utf-8',
    timeout: 30000,
  });
  const pass = res.status === 0;
  const notes = pass
    ? 'node --test exited 0'
    : `node --test exited ${res.status}\n${(res.stdout || '') + (res.stderr || '')}`.slice(0, 2000);
  return { pass, notes };
}

module.exports = { grade };
