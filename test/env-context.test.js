// buildEnvContext (Feature 15 Task 2): best-effort environment block for the
// v2 prompt variant. Git lines appear only when the workspace is a repo; the
// function must never throw.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildEnvContext } = require('../dist/main/features/agent/envContext.js');

function tmpDir(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `moon-envctx-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
}

test('git repo: block carries branch, dirty state, and recent commits', async (t) => {
  const dir = tmpDir(t, 'repo');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  commitAll(dir, 'first commit subject');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  commitAll(dir, 'second commit subject');

  const block = await buildEnvContext({ workspace: dir, model: 'mock-model' });
  assert.ok(block.startsWith('ENVIRONMENT:'));
  assert.ok(block.includes(`- Workspace: ${dir}`));
  assert.ok(block.includes(`- Platform: ${process.platform} ${os.release()}`));
  assert.match(block, /- Date: \d{4}-\d{2}-\d{2}/);
  assert.ok(block.includes('- Model: mock-model'));
  assert.ok(block.includes('- Git branch: main (clean)'));
  assert.ok(block.includes('- Recent commits:'));
  assert.ok(block.includes('first commit subject'));
  assert.ok(block.includes('second commit subject'));
});

test('git repo with uncommitted changes reports the dirty file count', async (t) => {
  const dir = tmpDir(t, 'dirty');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  commitAll(dir, 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');

  const block = await buildEnvContext({ workspace: dir, model: 'mock-model' });
  assert.ok(block.includes('- Git branch: main (2 modified/untracked files)'));
});

test('non-repo dir: platform/date/model lines present, no git lines', async (t) => {
  const dir = tmpDir(t, 'norepo');
  const block = await buildEnvContext({ workspace: dir, model: 'mock-model' });
  assert.ok(block.startsWith('ENVIRONMENT:'));
  assert.ok(block.includes(`- Platform: ${process.platform} ${os.release()}`));
  assert.match(block, /- Date: \d{4}-\d{2}-\d{2}/);
  assert.ok(block.includes('- Model: mock-model'));
  assert.ok(!block.includes('Git branch'));
  assert.ok(!block.includes('Recent commits'));
});

test('never throws: nonexistent workspace still resolves with the base lines', async () => {
  const block = await buildEnvContext({ workspace: '/nonexistent/path/for/envctx', model: 'mock-model' });
  assert.ok(block.startsWith('ENVIRONMENT:'));
  assert.ok(block.includes('- Model: mock-model'));
  assert.ok(!block.includes('Git branch'));
});
