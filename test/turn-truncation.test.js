// test/turn-truncation.test.js
// Bug #11: a turn cut off by the output-token cap or the step cap used to end
// silently (a normal `done` event, no explanation) — from the user's side
// that looks identical to the agent dying mid-task. handlePrompt now emits a
// `message` event noting why the turn stopped before `done` fires.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, chunk, toolCallChunk, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

async function runTurn(server) {
  const events = [];
  // Tmp workspace: the step-cap test spams set_progress, which now mirrors
  // goal/steps into <workspace>/.moon/state.json — keep that out of the repo.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-trunc-ws-'));
  await new Promise((resolve) => {
    handlePrompt('go', ws, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true);
  });
  return events;
}

test('finish_reason "length" emits an output-limit note before done', async (t) => {
  const server = await startServer(() => [chunk({ content: 'partial output' }, 'length')]);
  t.after(() => server.close());

  const events = await runTurn(server);
  const notes = events.filter((e) => e.type === 'message').map((e) => e.content).join('');
  assert.match(notes, /reached the output limit for this turn/);
});

test('normal stop finish emits no truncation note', async (t) => {
  const server = await startServer(() => textChunks('all done'));
  t.after(() => server.close());

  const events = await runTurn(server);
  const notes = events.filter((e) => e.type === 'message').map((e) => e.content).join('');
  assert.doesNotMatch(notes, /reached the (output|step) limit/);
});

test('hitting the step cap while the model still wants to call tools emits a step-limit note', async (t) => {
  // Every request gets another tool call, forcing the loop to run until
  // stopWhen's step cap (50) cuts it off — the SDK never lets a 51st request
  // go out, so the last seen finishReason stays 'tool_calls', not 'stop'.
  const server = await startServer(() =>
    [toolCallChunk('set_progress', { goal: 'g', steps: [{ text: 's', status: 'active' }] }), chunk({}, 'tool_calls')]);
  t.after(() => server.close());

  const events = await runTurn(server);
  const notes = events.filter((e) => e.type === 'message').map((e) => e.content).join('');
  assert.match(notes, /reached the step limit for this turn/);
});
