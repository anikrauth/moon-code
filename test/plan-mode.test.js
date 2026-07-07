// test/plan-mode.test.js
// Feature 15 Task 3: plan mode is a toggleable, read-only-ish mode enforced
// at the TOOL layer (makeTools), not by prompt text. Mode rides the existing
// usageHint meta bag the same way promptVariant does — no new positional
// handlePrompt params (see handlePrompt's 10th arg in agentLoop.ts).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

const PLAN_MODE_ERROR = 'Error: plan mode active — file mutations are disabled outside .moon/plans/. Write your plan there, or ask the user to approve execution.';

function mkWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-plan-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

// Drives a single tool call through handlePrompt and returns the tool_result
// event for that tool (same pattern as test/containment.test.js).
async function runTool(t, workspace, call, { permission, mode } = {}) {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk(call.name, call.args), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', workspace, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); },
      permission ?? (async () => true),
      undefined, undefined, undefined, mode ? { mode } : undefined);
  });
  return { events, result: events.find((e) => e.type === 'tool_result' && e.name === call.name)?.result };
}

test('plan mode: write_file to workspace root is blocked with the exact error, file not created', async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws,
    { name: 'write_file', args: { filePath: 'notes.txt', content: 'hello' } },
    { mode: 'plan' });
  assert.strictEqual(result, PLAN_MODE_ERROR);
  assert.ok(!fs.existsSync(path.join(ws, 'notes.txt')));
});

test('plan mode: write_file under .moon/plans/ succeeds', async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws,
    { name: 'write_file', args: { filePath: '.moon/plans/foo.md', content: '# Plan' } },
    { mode: 'plan' });
  assert.strictEqual(result, 'Successfully wrote to .moon/plans/foo.md');
  assert.strictEqual(fs.readFileSync(path.join(ws, '.moon/plans/foo.md'), 'utf8'), '# Plan');
});

test('plan mode: edit_file outside plans dir is blocked', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'existing.txt'), 'original content');
  const { result } = await runTool(t, ws,
    { name: 'edit_file', args: { filePath: 'existing.txt', oldString: 'original', newString: 'hacked' } },
    { mode: 'plan' });
  assert.strictEqual(result, PLAN_MODE_ERROR);
  assert.strictEqual(fs.readFileSync(path.join(ws, 'existing.txt'), 'utf8'), 'original content');
});

test('plan mode: path traversal out of .moon/plans/ is blocked, nothing written', async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws,
    { name: 'write_file', args: { filePath: '.moon/plans/../../evil.md', content: 'x' } },
    { mode: 'plan' });
  // Either the plan-mode message or the workspace-escape message is
  // acceptable here (path.resolve collapses '.moon/plans/../../evil.md' to
  // a path outside the workspace root entirely) — the requirement is that
  // it's blocked and nothing lands on disk.
  assert.match(result, /^Error: /);
  assert.ok(!fs.existsSync(path.join(path.dirname(ws), 'evil.md')));
  assert.ok(!fs.existsSync(path.join(ws, 'evil.md')));
});

test('plan mode: run_command still forces a fresh permission prompt even when the tool was already always-allowed', async (t) => {
  // This drives the forcePrompt contract at the toolRouter <-> permission
  // callback seam directly (see task-3 brief note on test 5): a headless
  // node:test run has no real registerAgentIpc/ipcMain/renderer round trip
  // to exercise, so this fake mimics registerAgentIpc's actual cache logic
  // (see src/main/app/ipc/registerAgentIpc.ts's requestPermission) closely
  // enough to prove the contract: forcePrompt must bypass the "already
  // always-allowed" cache lookup. To make the bypass observable rather than
  // just "asked again with the same answer", this fake DENIES whenever
  // forcePrompt is set — so the only way run_command succeeds is if plan
  // mode's forcePrompt did NOT fire, and the only way it's denied is if it
  // did.
  const ws = mkWorkspace(t);
  const sessionAllowedTools = new Set(['run_command']); // pre-seeded, as if a prior execute-mode turn chose "always allow"
  const calls = [];
  const permission = (name, args, agentId, options) => {
    calls.push({ name, options });
    const forcePrompt = !!options?.forcePrompt;
    if (forcePrompt) return Promise.resolve(false); // simulates: user is asked fresh and this fake says no
    if (sessionAllowedTools.has(name)) return Promise.resolve(true); // cache hit, no fresh ask
    return Promise.resolve(true);
  };

  const planRun = await runTool(t, ws,
    { name: 'run_command', args: { command: 'echo hi' } },
    { permission, mode: 'plan' });
  assert.strictEqual(planRun.result, 'User denied permission for this action.');
  assert.ok(calls.some((c) => c.name === 'run_command' && c.options?.forcePrompt === true),
    'plan mode must call requestPermission with forcePrompt: true for run_command');

  calls.length = 0;
  const executeRun = await runTool(t, ws,
    { name: 'run_command', args: { command: 'echo hi' } },
    { permission }); // mode omitted -> execute
  assert.match(executeRun.result, /Command executed successfully|hi/);
  assert.ok(calls.some((c) => c.name === 'run_command' && !c.options?.forcePrompt),
    'execute mode must not force a prompt — the always-allow cache should short-circuit');
});

test('plan mode inheritance: a subagent spawned in plan mode is also gated (write_file outside plans dir blocked)', async (t) => {
  const ws = mkWorkspace(t);
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some((t) => t.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some((m) => m.role === 'tool');
    if (isMain && !hasToolMsg) return [toolCallChunk('spawn_agent', { task: 'write a file for me' }), chunk({}, 'tool_calls')];
    if (isMain) return textChunks('done');
    // subagent turn: try to write outside the plans dir, then report back.
    if (!hasToolMsg) return [toolCallChunk('write_file', { filePath: 'sneaky.txt', content: 'evil' }), chunk({}, 'tool_calls')];
    return textChunks('sub findings');
  });
  t.after(() => server.close());

  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', ws, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); },
      async () => true,
      undefined, undefined, undefined, { mode: 'plan' });
  });

  const subWrite = events.find((e) => e.type === 'tool_result' && e.name === 'write_file');
  assert.ok(subWrite, 'subagent write_file tool_result should be present');
  assert.strictEqual(subWrite.result, PLAN_MODE_ERROR);
  assert.strictEqual(subWrite.agent, 'sub-1');
  assert.ok(!fs.existsSync(path.join(ws, 'sneaky.txt')));
});

test('execute mode (default, mode omitted): none of the plan-mode gating applies', async (t) => {
  const ws = mkWorkspace(t);
  const { result: writeResult } = await runTool(t, ws,
    { name: 'write_file', args: { filePath: 'notes.txt', content: 'hello' } });
  assert.strictEqual(writeResult, 'Successfully wrote to notes.txt');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), 'hello');

  fs.writeFileSync(path.join(ws, 'existing.txt'), 'original content');
  const { result: editResult } = await runTool(t, ws,
    { name: 'edit_file', args: { filePath: 'existing.txt', oldString: 'original content', newString: 'edited content' } });
  assert.strictEqual(editResult, 'Successfully edited existing.txt');
  assert.strictEqual(fs.readFileSync(path.join(ws, 'existing.txt'), 'utf8'), 'edited content');
});

test('explicit mode: "execute" behaves identically to mode omitted', async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws,
    { name: 'write_file', args: { filePath: 'notes.txt', content: 'hello' } },
    { mode: 'execute' });
  assert.strictEqual(result, 'Successfully wrote to notes.txt');
});
