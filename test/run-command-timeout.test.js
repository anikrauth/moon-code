// run_command timeoutSeconds (Feature 15 Task 2): the schema exposes an
// optional timeout override, hitting it returns a distinct retryable message,
// and the default path is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

function mkWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Drives one turn: first model step issues `call`, second returns text.
// Returns { result, firstRequest } so schema assertions can share a run.
async function runTool(t, workspace, call) {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk(call.name, call.args), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', workspace, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true);
  });
  return {
    result: events.find((e) => e.type === 'tool_result' && e.name === call.name).result,
    firstRequest: server.requests[0],
  };
}

test('schema exposes timeoutSeconds with 1-600 bounds', async (t) => {
  const ws = mkWorkspace(t);
  const { firstRequest } = await runTool(t, ws, { name: 'run_command', args: { command: 'echo hi' } });
  const def = firstRequest.tools.find((x) => x.function.name === 'run_command');
  const prop = def.function.parameters.properties.timeoutSeconds;
  assert.ok(prop, 'timeoutSeconds present in the run_command schema');
  const schemaText = JSON.stringify(prop);
  assert.ok(schemaText.includes('600'), 'schema carries the 600s upper bound');
  assert.ok(def.function.description.includes('timeoutSeconds'), 'description mentions timeoutSeconds');
});

test('command exceeding timeoutSeconds returns the distinct timeout message', { timeout: 20000 }, async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws, { name: 'run_command', args: { command: 'sleep 5', timeoutSeconds: 1 } });
  assert.strictEqual(result, 'Error: command timed out after 1s. If it legitimately needs longer, retry with a larger timeoutSeconds (max 600).');
});

test('command finishing within a custom timeout succeeds', { timeout: 20000 }, async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws, { name: 'run_command', args: { command: 'echo fast', timeoutSeconds: 30 } });
  assert.strictEqual(result, 'fast\n');
});

test('default path (no timeoutSeconds) still works', async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws, { name: 'run_command', args: { command: 'echo hello' } });
  assert.strictEqual(result, 'hello\n');
});

test('non-timeout failures keep the ordinary error shape', async (t) => {
  const ws = mkWorkspace(t);
  const { result } = await runTool(t, ws, { name: 'run_command', args: { command: 'exit 3', timeoutSeconds: 10 } });
  assert.match(result, /^Error: /);
  assert.ok(!result.includes('timed out'), 'a plain failure must not be reported as a timeout');
});
