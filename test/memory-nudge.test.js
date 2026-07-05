const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

const NUDGE_MARK = 'Automatic end-of-turn memory check';

function setupWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moon-nudge-ws-'));
}

function run(server, ws, history) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('go', ws, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, history,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      async () => true);
  });
}

const doneOf = (events) => events.find((e) => e.type === 'done');
const isNudge = (m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.includes(NUDGE_MARK);

// Fake server: first call issues the given tool calls, then finishes with text.
function toolThenDone(...calls) {
  let issued = 0;
  return (body) => {
    const toolResults = body.messages.filter((m) => m.role === 'tool').length;
    if (issued < calls.length && toolResults === issued) {
      const c = calls[issued];
      issued += 1;
      return [toolCallChunk(c.name, c.args, `call_${issued}`), chunk({}, 'tool_calls')];
    }
    return textChunks('done');
  };
}

test('file edit without write_memory appends the nudge to done.history', async (t) => {
  const ws = setupWs();
  const server = await startServer(toolThenDone({ name: 'write_file', args: { filePath: 'a.txt', content: 'hello' } }));
  t.after(() => server.close());
  const events = await run(server, ws);
  const history = doneOf(events).history;
  const last = history[history.length - 1];
  assert.ok(isNudge(last), 'nudge is the final history message');
  assert.match(last.content, /<system-reminder>/);
  assert.match(last.content, /write_memory/);
});

test('file edit plus write_memory in the same turn produces no nudge', async (t) => {
  const ws = setupWs();
  const server = await startServer(toolThenDone(
    { name: 'write_file', args: { filePath: 'a.txt', content: 'hello' } },
    { name: 'write_memory', args: { name: 'test-pref', description: 'd', body: 'b' } },
  ));
  t.after(() => server.close());
  const events = await run(server, ws);
  assert.ok(!doneOf(events).history.some(isNudge));
});

test('text-only turn produces no nudge', async (t) => {
  const ws = setupWs();
  const server = await startServer(() => textChunks('just chatting'));
  t.after(() => server.close());
  const events = await run(server, ws);
  assert.ok(!doneOf(events).history.some(isNudge));
});

test('a prior nudge is delivered to the model once, then consumed from history', async (t) => {
  const ws = setupWs();
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  const nudgeMsg = { role: 'user', content: `<system-reminder>${NUDGE_MARK}: ...</system-reminder>` };
  const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'sure' }, nudgeMsg];
  const events = await run(server, ws, history);
  // Delivered: the model request contains the nudge.
  assert.ok(server.requests[0].messages.some((m) => typeof m.content === 'string' && m.content.includes(NUDGE_MARK)));
  // Consumed: the outgoing history no longer carries it (text-only turn, no new nudge).
  assert.ok(!doneOf(events).history.some(isNudge));
});
