// test/cancel.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

// Server that sends one delta then stalls forever (never closes the stream).
function startStallingServer() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => raw += d);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`);
      // intentionally never ends
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function run(server, { onEvent, signal } = {}) {
  const events = [];
  const done = new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); onEvent?.(e); if (e.type === 'done') resolve(); },
      async () => true, signal);
  });
  return { events, done };
}

test('aborting mid-stream cancels the turn', { timeout: 5000 }, async (t) => {
  const server = await startStallingServer();
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const ac = new AbortController();
  const { events, done } = run(server, {
    signal: ac.signal,
    onEvent: (e) => { if (e.type === 'message') ac.abort(); },
  });
  await done;
  assert.ok(events.some((e) => e.type === 'error' && /Cancel/.test(e.content)));
});

test('abort kills a running command', { timeout: 8000 }, async (t) => {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('run_command', { command: 'sleep 5' }), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const ac = new AbortController();
  const started = Date.now();
  const { events, done } = run(server, {
    signal: ac.signal,
    onEvent: (e) => { if (e.type === 'tool_call') setTimeout(() => ac.abort(), 200); },
  });
  await done;
  assert.ok(Date.now() - started < 4000, 'turn ended well before sleep 5 finished');
  assert.ok(events.some((e) => e.type === 'error' && /Cancel/.test(e.content)));
});

test('abort during compaction cancels promptly', { timeout: 5000 }, async (t) => {
  const http = require('http');
  // summarize (no tools) stalls forever; main call (tools) never reached
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => raw += d);
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
      if (!body.tools) return; // stall the summarize call, never respond
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const ac = new AbortController();
  const huge = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(30000) }));
  const events = [];
  const started = Date.now();
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock' }, huge,
      (e) => { events.push(e); if (e.type === 'status' && e.content) setTimeout(() => ac.abort(), 100); if (e.type === 'done') resolve(); },
      async () => true, ac.signal);
  });
  assert.ok(Date.now() - started < 3000, 'cancel resolved without waiting out the summarize call');
  assert.ok(events.some((e) => e.type === 'error' && /Cancel/.test(e.content)));
});

test('step limit stops an infinite tool loop at MAX_STEPS', { timeout: 60000 }, async (t) => {
  let n = 0;
  const server = await startServer(() =>
    [toolCallChunk('run_command', { command: 'true' }, `call_${++n}`), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const { events, done } = run(server, {});
  await done;
  assert.ok(server.requests.length >= 40, `expected ~50 steps, got ${server.requests.length} (limit still 10?)`);
  assert.ok(server.requests.length <= 51, `runaway: ${server.requests.length} requests`);
  assert.ok(events.some((e) => e.type === 'done'));
});
