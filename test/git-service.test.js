const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createGitService } = require('../dist/main/features/git/gitService.js');

const git = createGitService();

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `moon-git-${tag}-`));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
}

test('not-a-repo directory reports isRepo false', async () => {
  const dir = tmpDir('norepo');
  const snap = await git.snapshot(dir);
  assert.strictEqual(snap.gitAvailable, true);
  assert.strictEqual(snap.isRepo, false);
});

test('git binary missing reports gitAvailable false', async () => {
  const fakeGit = createGitService({
    execFileImpl: (_cmd, _args, _opts, cb) => {
      const err = new Error('spawn git ENOENT');
      err.code = 'ENOENT';
      cb(err, '', '');
    },
  });
  const snap = await fakeGit.snapshot('/whatever');
  assert.deepStrictEqual(snap, { gitAvailable: false });
});

test('empty repo (no commits) surfaces untracked files with line counts', async () => {
  const dir = tmpDir('empty');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  const snap = await git.snapshot(dir);
  assert.strictEqual(snap.isRepo, true);
  const f = snap.files.find((x) => x.path === 'a.txt');
  assert.ok(f, 'a.txt should be listed');
  assert.strictEqual(f.status, 'untracked');
  assert.strictEqual(f.adds, 3);
  assert.strictEqual(f.dels, 0);
});

test('modified tracked file yields numstat adds/dels', async () => {
  const dir = tmpDir('mod');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n');
  commitAll(dir, 'init');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nB\nc\nd\n');
  const snap = await git.snapshot(dir);
  const f = snap.files.find((x) => x.path === 'f.txt');
  assert.strictEqual(f.status, 'modified');
  assert.strictEqual(f.adds, 2);
  assert.strictEqual(f.dels, 1);
  assert.strictEqual(snap.totals.adds, 2);
  assert.strictEqual(snap.totals.dels, 1);
  assert.strictEqual(snap.totals.fileCount, 1);
});

test('branch and branches reflect current checkout', async () => {
  const dir = tmpDir('branch');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  commitAll(dir, 'init');
  execFileSync('git', ['branch', 'feature'], { cwd: dir });
  const snap = await git.snapshot(dir);
  assert.ok(snap.branches.includes('feature'));
  assert.ok(['main', 'master'].includes(snap.branch));
});

test('binary file numstat marks binary with zero counts', async () => {
  const dir = tmpDir('bin');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 3]));
  commitAll(dir, 'init');
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6]));
  const snap = await git.snapshot(dir);
  const f = snap.files.find((x) => x.path === 'b.bin');
  assert.strictEqual(f.binary, true);
  assert.strictEqual(f.adds, 0);
  assert.strictEqual(f.dels, 0);
});

test('checkout switches branch', async () => {
  const dir = tmpDir('checkout');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  commitAll(dir, 'init');
  execFileSync('git', ['branch', 'dev'], { cwd: dir });
  const res = await git.checkout(dir, 'dev');
  assert.strictEqual(res.ok, true);
  const snap = await git.snapshot(dir);
  assert.strictEqual(snap.branch, 'dev');
});

test('checkout rejects invalid branch name', async () => {
  const dir = tmpDir('badbranch');
  initRepo(dir);
  const res = await git.checkout(dir, '--evil');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Invalid/);
});

test('checkout of missing branch surfaces error', async () => {
  const dir = tmpDir('nobranch');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  commitAll(dir, 'init');
  const res = await git.checkout(dir, 'does-not-exist');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error && res.error.length > 0);
});

test('commit stages all and returns short hash; then tree is clean', async () => {
  const dir = tmpDir('commit');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const res = await git.commit(dir, 'first commit');
  assert.strictEqual(res.ok, true);
  assert.match(res.hash, /^[0-9a-f]{7,}$/);
  const snap = await git.snapshot(dir);
  assert.strictEqual(snap.files.length, 0);
  assert.strictEqual(snap.totals.fileCount, 0);
});

test('commit with empty message is rejected', async () => {
  const dir = tmpDir('emptymsg');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  const res = await git.commit(dir, '   ');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /message/i);
});

test('changesSummary on clean repo reports no changes', async () => {
  const dir = tmpDir('cs-clean');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  commitAll(dir, 'init');
  const res = await git.changesSummary(dir);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /No changes/);
});

test('changesSummary includes diff hunks for modified tracked files', async () => {
  const dir = tmpDir('cs-mod');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'alpha\nbeta\n');
  commitAll(dir, 'init');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'alpha\ngamma\n');
  const res = await git.changesSummary(dir);
  assert.strictEqual(res.ok, true);
  assert.match(res.summary, /Diff of tracked changes:/);
  assert.match(res.summary, /\+gamma/);
  assert.match(res.summary, /-beta/);
});

test('changesSummary lists untracked files with contents', async () => {
  const dir = tmpDir('cs-untracked');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  commitAll(dir, 'init');
  fs.writeFileSync(path.join(dir, 'new.js'), 'console.log("brand new file");\n');
  const res = await git.changesSummary(dir);
  assert.strictEqual(res.ok, true);
  assert.match(res.summary, /Untracked \(new\) files:/);
  assert.match(res.summary, /- new\.js \(1 lines\)/);
  assert.match(res.summary, /brand new file/);
});

test('changesSummary works in a fresh repo with no commits', async () => {
  const dir = tmpDir('cs-fresh');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'first.txt'), 'hello\n');
  const res = await git.changesSummary(dir);
  assert.strictEqual(res.ok, true);
  assert.doesNotMatch(res.summary, /Diff of tracked changes:/);
  assert.match(res.summary, /- first\.txt \(1 lines\)/);
});

test('changesSummary truncates huge diffs to the budget', async () => {
  const hugeDiff = 'diff --git a/x b/x\n' + '+x\n'.repeat(20000); // > 24K chars
  const fakeGit = createGitService({
    execFileImpl: (_cmd, args, _opts, cb) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return cb(null, ' M x\n', '');
      if (key.startsWith('rev-parse --verify')) return cb(null, 'abc123\n', '');
      if (key === 'diff HEAD') return cb(null, hugeDiff, '');
      cb(null, '', '');
    },
  });
  const res = await fakeGit.changesSummary('/whatever');
  assert.strictEqual(res.ok, true);
  assert.match(res.summary, /\[diff truncated\]$/);
  assert.ok(res.summary.length < 25000, `summary too long: ${res.summary.length}`);
});

test('recentCommits returns newest-first oneline entries capped at n', async () => {
  const dir = tmpDir('log');
  initRepo(dir);
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(dir, 'f.txt'), `v${i}\n`);
    commitAll(dir, `commit ${i}`);
  }
  const all = await git.recentCommits(dir, 5);
  assert.strictEqual(all.length, 3);
  assert.match(all[0], /commit 3$/);
  assert.match(all[2], /commit 1$/);
  const capped = await git.recentCommits(dir, 2);
  assert.strictEqual(capped.length, 2);
  assert.match(capped[0], /commit 3$/);
});

test('recentCommits returns [] for non-repo dirs and repos with no commits', async () => {
  const noRepo = tmpDir('log-norepo');
  assert.deepStrictEqual(await git.recentCommits(noRepo, 5), []);
  const empty = tmpDir('log-empty');
  initRepo(empty);
  assert.deepStrictEqual(await git.recentCommits(empty, 5), []);
});
