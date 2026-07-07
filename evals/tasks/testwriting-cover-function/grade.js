// Grader for testwriting-cover-function: passes iff
//   1. A new file (anything other than util.js) exists in the workspace
//      that requires util.js and actually calls clamp(...) (cheap regex
//      check — not just an import with no use), AND
//   2. Running `node --test <that file>` exits 0.
const fs = require('node:fs');
const path = require('node:path');
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

function listJsFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsFiles(full, base, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

async function grade(ctx) {
  const files = listJsFiles(ctx.workspace).filter((f) => f !== 'util.js');
  if (files.length === 0) {
    return { pass: false, notes: 'no new file was added to the workspace — util.js has no test file' };
  }

  const candidate = files.find((f) => {
    const src = fs.readFileSync(path.join(ctx.workspace, f), 'utf-8');
    const requiresUtil = /require\(['"]\.\/?util(\.js)?['"]\)/.test(src);
    const callsClamp = /\bclamp\s*\(/.test(src);
    return requiresUtil && callsClamp;
  });

  if (!candidate) {
    return { pass: false, notes: `no new file requires util.js and calls clamp(...) (checked: ${files.join(', ')})` };
  }

  const res = spawnSync(process.execPath, ['--test', candidate], {
    cwd: ctx.workspace,
    encoding: 'utf-8',
    timeout: 30000,
    env: childEnv(),
  });
  const pass = res.status === 0;
  const notes = pass
    ? `node --test ${candidate} exited 0`
    : `node --test ${candidate} exited ${res.status}\n${(res.stdout || '') + (res.stderr || '')}`.slice(0, 2000);
  return { pass, notes };
}

module.exports = { grade };
