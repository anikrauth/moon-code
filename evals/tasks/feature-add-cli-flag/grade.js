// Grader for feature-add-cli-flag: runs the CLI with --json and some
// numbers, expects valid JSON on stdout with count/total keys.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function grade(ctx) {
  const cliPath = path.join(ctx.workspace, 'cli.js');
  const res = spawnSync(process.execPath, [cliPath, '--json', '2', '3', '5'], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  if (res.status !== 0) {
    return { pass: false, notes: `cli exited ${res.status}: ${res.stderr || res.stdout}` };
  }
  let parsed;
  try {
    parsed = JSON.parse((res.stdout || '').trim());
  } catch (e) {
    return { pass: false, notes: `stdout was not JSON: ${e.message}\nstdout: ${res.stdout}` };
  }
  const pass = parsed && typeof parsed === 'object'
    && Number(parsed.count) === 3
    && Number(parsed.total) === 10;
  const notes = pass ? 'JSON output has expected count/total' : `unexpected JSON: ${JSON.stringify(parsed)}`;
  return { pass, notes };
}

module.exports = { grade };
