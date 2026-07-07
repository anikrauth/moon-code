// Grader for multiedit-rename-api: passes iff the old name is gone
// everywhere, the new name shows up enough times to prove it was actually
// propagated (not just renamed at the definition site), and the CLI still
// behaves identically (a require/run smoke-check, not just static grep).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OLD_NAME = 'computeTotal';
const NEW_NAME = 'calculateOrderTotal';
const MIN_NEW_OCCURRENCES = 4; // 1 definition + 3 call/import sites across math.js/invoice.js/report.js/cli.js

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

function countOccurrences(text, name) {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  return (text.match(re) || []).length;
}

async function grade(ctx) {
  const files = listJsFiles(ctx.workspace);
  let oldCount = 0;
  let newCount = 0;
  const filesWithOld = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ctx.workspace, f), 'utf-8');
    const oldHere = countOccurrences(src, OLD_NAME);
    if (oldHere > 0) filesWithOld.push(f);
    oldCount += oldHere;
    newCount += countOccurrences(src, NEW_NAME);
  }

  if (oldCount > 0) {
    return { pass: false, notes: `old name '${OLD_NAME}' still appears ${oldCount} time(s), in: ${filesWithOld.join(', ')}` };
  }
  if (newCount < MIN_NEW_OCCURRENCES) {
    return { pass: false, notes: `new name '${NEW_NAME}' only appears ${newCount} time(s), expected at least ${MIN_NEW_OCCURRENCES} (definition + call sites)` };
  }

  const cliPath = path.join(ctx.workspace, 'cli.js');
  if (!fs.existsSync(cliPath)) {
    return { pass: false, notes: 'cli.js no longer exists in workspace' };
  }
  const res = spawnSync(process.execPath, [cliPath, '2', '3', '5'], { encoding: 'utf-8', timeout: 15000 });
  if (res.status !== 0) {
    return { pass: false, notes: `cli.js exited ${res.status} after rename: ${res.stderr || res.stdout}` };
  }
  const stdout = res.stdout || '';
  const hasThreeTotals = (stdout.match(/10/g) || []).length >= 3;
  if (!hasThreeTotals) {
    return { pass: false, notes: `cli.js behavior changed after rename — expected three totals of 10, got:\n${stdout}` };
  }

  return { pass: true, notes: `'${OLD_NAME}' fully renamed to '${NEW_NAME}' (${newCount} occurrences); cli.js behavior unchanged` };
}

module.exports = { grade };
