const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');
const { resolveInWorkspace, isUnderPlansDir } = require('../dist/main/features/agent/toolRouter.js');

// Workspace nested inside a parent dir so '../' escapes into controlled territory.
function mkNestedWorkspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-contain-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const ws = path.join(parent, 'workspace');
  fs.mkdirSync(ws);
  return { parent, ws };
}

async function runTool(t, workspace, call, permission) {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk(call.name, call.args), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', workspace, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, permission ?? (async () => true));
  });
  return events.find((e) => e.type === 'tool_result' && e.name === call.name).result;
}

test('read_file rejects ../ escape', async (t) => {
  const { parent, ws } = mkNestedWorkspace(t);
  fs.writeFileSync(path.join(parent, 'secret.txt'), 'SECRET');
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: '../secret.txt' } });
  assert.strictEqual(result, 'Error: path escapes the workspace: ../secret.txt');
  assert.ok(!result.includes('SECRET'));
});

test('read_file rejects absolute path', async (t) => {
  const { ws } = mkNestedWorkspace(t);
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: '/etc/hosts' } });
  assert.strictEqual(result, 'Error: path escapes the workspace: /etc/hosts');
});

test('write_file escape: rejected, nothing written, NO permission asked', async (t) => {
  const { parent, ws } = mkNestedWorkspace(t);
  const permCalls = [];
  const result = await runTool(t, ws,
    { name: 'write_file', args: { filePath: '../evil.txt', content: 'x' } },
    async (name, args, agentId) => { permCalls.push(name); return true; });
  assert.strictEqual(result, 'Error: path escapes the workspace: ../evil.txt');
  assert.ok(!fs.existsSync(path.join(parent, 'evil.txt')));
  assert.deepStrictEqual(permCalls, []);
});

test('edit_file escape: rejected, outside file untouched, NO permission asked', async (t) => {
  const { parent, ws } = mkNestedWorkspace(t);
  fs.writeFileSync(path.join(parent, 'target.txt'), 'original');
  const permCalls = [];
  const result = await runTool(t, ws,
    { name: 'edit_file', args: { filePath: '../target.txt', oldString: 'original', newString: 'hacked' } },
    async (name) => { permCalls.push(name); return true; });
  assert.strictEqual(result, 'Error: path escapes the workspace: ../target.txt');
  assert.strictEqual(fs.readFileSync(path.join(parent, 'target.txt'), 'utf8'), 'original');
  assert.deepStrictEqual(permCalls, []);
});

test('list_dir rejects .. but accepts .', async (t) => {
  const { ws } = mkNestedWorkspace(t);
  fs.writeFileSync(path.join(ws, 'a.txt'), '');
  const rejected = await runTool(t, ws, { name: 'list_dir', args: { dirPath: '..' } });
  assert.strictEqual(rejected, 'Error: path escapes the workspace: ..');
  const ok = await runTool(t, ws, { name: 'list_dir', args: { dirPath: '.' } });
  // Filter the .moon/.gitignore bootstrap that ensureScratchDir() creates each turn.
  const entries = ok.split('\n').filter((e) => e !== '.moon' && e !== '.gitignore');
  assert.deepStrictEqual(entries, ['a.txt']);
});

test('legit inner paths still work', async (t) => {
  const { ws } = mkNestedWorkspace(t);
  fs.writeFileSync(path.join(ws, 'inside.txt'), 'inner');
  const written = await runTool(t, ws, { name: 'write_file', args: { filePath: 'nested/dir/file.txt', content: 'ok' } });
  assert.strictEqual(written, 'Successfully wrote to nested/dir/file.txt');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'nested/dir/file.txt'), 'utf8'), 'ok');
  const read = await runTool(t, ws, { name: 'read_file', args: { filePath: 'nested/../inside.txt' } });
  assert.strictEqual(read, 'inner');
});

// --- Security review regression tests (Feature 15 Task 3 plan-mode review) ---
// PoC A and PoC B below drive resolveInWorkspace/isUnderPlansDir directly
// (the shared primitives), independent of plan mode's tool-layer wiring —
// see test/plan-mode.test.js for the end-to-end write_file-is-blocked
// versions of the same PoCs.

test('PoC A: .moon/plans as a symlink to another in-workspace dir does not fool isUnderPlansDir', async (t) => {
  const { ws } = mkNestedWorkspace(t);
  fs.mkdirSync(path.join(ws, 'src'));
  fs.mkdirSync(path.join(ws, '.moon'));
  // A repo can ship this as a tracked mode-120000 symlink: .moon/plans -> src.
  fs.symlinkSync(path.join(ws, 'src'), path.join(ws, '.moon', 'plans'), 'dir');

  const absPath = resolveInWorkspace(ws, '.moon/plans/x.md');
  // resolveInWorkspace only guards the *workspace* boundary — src is still
  // inside the workspace, so this legitimately resolves.
  assert.ok(absPath, 'resolveInWorkspace should resolve a path under the workspace');
  // isUnderPlansDir must NOT be fooled into treating this as "under plans":
  // the real target is <ws>/src, not <ws>/.moon/plans.
  assert.strictEqual(isUnderPlansDir(ws, absPath), false);
});

test('PoC B: dangling symlink under .moon/plans is rejected by both resolveInWorkspace and isUnderPlansDir, nothing created outside the workspace', async (t) => {
  const { ws } = mkNestedWorkspace(t);
  fs.mkdirSync(path.join(ws, '.moon', 'plans'), { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-poc-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outsideTarget = path.join(outsideDir, 'evil.md'); // does not exist yet, but its parent does
  fs.symlinkSync(outsideTarget, path.join(ws, '.moon', 'plans', 'sneaky.md'));

  assert.strictEqual(resolveInWorkspace(ws, '.moon/plans/sneaky.md'), null,
    'a dangling symlink must not be treated as a plain not-yet-existing path');
  assert.strictEqual(isUnderPlansDir(ws, path.join(ws, '.moon', 'plans', 'sneaky.md')), false);
  assert.ok(!fs.existsSync(outsideTarget), 'nothing should have been created at the symlink target');
});
