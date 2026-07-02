# Workspace Path Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `read_file`, `write_file`, `edit_file`, `list_dir` refuse paths resolving outside the workspace, before any permission prompt.

**Architecture:** One helper + four guards in `src/main/agent.ts`; one new test file on the existing fake-SSE harness.

**Tech Stack:** node:test; `npm test` = `tsc -p tsconfig.main.json && node --test test/*.test.js`; currently 28 tests.

## Global Constraints

- Error string exact: `Error: path escapes the workspace: <the tool's path argument>`.
- `write_file`/`edit_file`: guard runs BEFORE `requestPermission` — a rejected path never raises a permission dialog.
- Helper accepts `abs === root` (so `list_dir('.')` works) and any `abs` starting with `root + path.sep`.
- Single-artifact pattern: error string emitted in `tool_result` AND returned to the model.
- `// @ts-nocheck` kept; no other tool behavior changes.

---

### Task 1: containment helper + guards + tests (TDD)

**Files:**
- Modify: `src/main/agent.ts`
- Create: `test/containment.test.js`

**Interfaces:**
- Produces: module-level `resolveInWorkspace(workspace, relPath) -> string | null`.

- [ ] **Step 1: Write failing tests**

```js
// test/containment.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

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
  assert.strictEqual(ok, 'a.txt');
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
```

- [ ] **Step 2: Run to verify failure** — `npm test`: escape tests FAIL (secrets read, files written outside, permission asked).

- [ ] **Step 3: Implement**

Module-level helper in `src/main/agent.ts` (near `truncateOutput`):

```ts
function resolveInWorkspace(workspace, relPath) {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
}
```

In each of the four tools, replace `const absPath = path.join(workspace, <arg>);` with the guard. `read_file` (top of try) and `list_dir` (top of try):

```ts
const absPath = resolveInWorkspace(workspace, filePath); // dirPath for list_dir
if (!absPath) {
    const errMsg = `Error: path escapes the workspace: ${filePath}`; // dirPath for list_dir
    emit({ type: 'tool_result', name: 'read_file', result: errMsg }); // list_dir for list_dir
    return errMsg;
}
```

`write_file` and `edit_file`: the guard goes immediately after the `tool_call` emit and BEFORE `if (!await requestPermission(...))`; the old `const absPath = path.join(...)` inside the try is deleted (the guarded `absPath` from above is used).

- [ ] **Step 4: Run to verify pass** — `npm test`: 34/34 (28 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts test/containment.test.js
git commit -m "feat: contain file tools to the workspace root"
```
