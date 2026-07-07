// Grader for refactor-extract-module: passes iff
//   1. `node --test index.test.js` still exits 0 in the workspace (behavior
//      preserved), AND
//   2. A new module file (anything other than index.js/index.test.js) now
//      defines slugify and/or truncate, AND
//   3. index.js itself no longer defines them inline and instead requires
//      the new file.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  const res = spawnSync(process.execPath, ['--test', 'index.test.js'], {
    cwd: ctx.workspace,
    encoding: 'utf-8',
    timeout: 30000,
  });
  if (res.status !== 0) {
    return {
      pass: false,
      notes: `node --test index.test.js exited ${res.status} — behavior not preserved\n${(res.stdout || '') + (res.stderr || '')}`.slice(0, 2000),
    };
  }

  const indexPath = path.join(ctx.workspace, 'index.js');
  if (!fs.existsSync(indexPath)) {
    return { pass: false, notes: 'index.js no longer exists in workspace' };
  }
  const indexSrc = fs.readFileSync(indexPath, 'utf-8');

  const stillInlineDefined = /function\s+slugify\s*\(/.test(indexSrc) || /function\s+truncate\s*\(/.test(indexSrc);
  if (stillInlineDefined) {
    return { pass: false, notes: 'slugify/truncate are still defined inline in index.js — nothing was extracted' };
  }

  const otherFiles = listJsFiles(ctx.workspace).filter((f) => f !== 'index.js' && f !== 'index.test.js');
  const newModuleFile = otherFiles.find((f) => {
    const src = fs.readFileSync(path.join(ctx.workspace, f), 'utf-8');
    return /function\s+slugify\s*\(/.test(src) || /function\s+truncate\s*\(/.test(src);
  });
  if (!newModuleFile) {
    return { pass: false, notes: `no new module file defines slugify/truncate (found js files: ${otherFiles.join(', ') || 'none'})` };
  }

  const importsFromNewModule = new RegExp(`require\\(['"]\\./?${path.basename(newModuleFile, '.js')}(\\.js)?['"]\\)`).test(indexSrc);
  if (!importsFromNewModule) {
    return { pass: false, notes: `index.js does not appear to require the new module file (${newModuleFile})` };
  }

  return { pass: true, notes: `helpers extracted into ${newModuleFile} and imported from index.js; index.test.js still passes` };
}

module.exports = { grade };
