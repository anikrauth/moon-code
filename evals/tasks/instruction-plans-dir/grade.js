// Grader for instruction-plans-dir: pass iff a non-empty .md file exists
// under <workspace>/.moon/plans/, AND no new top-level .md file beyond the
// fixture's own README.md was created directly in the workspace root
// (i.e. the agent used the plans dir rather than dropping a plan file at
// the repo root).
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_ROOT_MD = new Set(['README.md']);

async function grade(ctx) {
  const plansDir = path.join(ctx.workspace, '.moon', 'plans');
  let planFiles = [];
  try {
    planFiles = fs.readdirSync(plansDir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return { pass: false, notes: `.moon/plans/ does not exist in workspace` };
  }

  const nonEmptyPlan = planFiles.some((f) => {
    try {
      return fs.statSync(path.join(plansDir, f)).size > 0;
    } catch {
      return false;
    }
  });
  if (!nonEmptyPlan) {
    return { pass: false, notes: `no non-empty .md found under .moon/plans/ (found: ${planFiles.join(', ') || 'none'})` };
  }

  const rootEntries = fs.readdirSync(ctx.workspace);
  const extraRootMd = rootEntries.filter((f) => f.toLowerCase().endsWith('.md') && !FIXTURE_ROOT_MD.has(f));
  if (extraRootMd.length > 0) {
    return { pass: false, notes: `unexpected new .md file(s) at workspace root: ${extraRootMd.join(', ')}` };
  }

  return { pass: true, notes: `plan saved under .moon/plans/ (${planFiles.join(', ')})` };
}

module.exports = { grade };
