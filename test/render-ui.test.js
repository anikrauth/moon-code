const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');
const { parseRenderUiSpec } = require('../dist/shared/lib/renderUiSpec.js');

const VALID_JSONL = [
  '{"op":"add","path":"/root","value":"main"}',
  '{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{},"children":["t"]}}',
  '{"op":"add","path":"/elements/t","value":{"type":"Table","props":{"headers":["Name","Size"],"rows":[["a.ts","1 KB"]]},"children":[]}}',
].join('\n');

function runTurn(server, prompt = 'hello') {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt(prompt, process.cwd(),
      { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      async () => true);
  });
}

test('parseRenderUiSpec accepts a valid table spec', () => {
  const parsed = parseRenderUiSpec(VALID_JSONL);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.spec.root, 'main');
  assert.strictEqual(parsed.spec.elements.t.type, 'Table');
});

test('parseRenderUiSpec rejects unknown component types', () => {
  const bad = [
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/elements/main","value":{"type":"Chart","props":{},"children":[]}}',
  ].join('\n');
  const parsed = parseRenderUiSpec(bad);
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.error.length > 0);
});

test('parseRenderUiSpec rejects empty and garbage input', () => {
  assert.strictEqual(parseRenderUiSpec('').ok, false);
  assert.strictEqual(parseRenderUiSpec('not json at all').ok, false);
  assert.strictEqual(parseRenderUiSpec('{"op":"add"').ok, false);
});

test('render_ui tool call renders widget and emits events', async (t) => {
  const server = await startServer((body) =>
    body.messages.some(m => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('render_ui', { spec: VALID_JSONL }), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const events = await runTurn(server);
  const call = events.find(e => e.type === 'tool_call' && e.name === 'render_ui');
  assert.ok(call, 'tool_call event emitted');
  assert.ok(JSON.parse(call.arguments).spec.includes('"/root"'));
  const result = events.find(e => e.type === 'tool_result' && e.name === 'render_ui');
  assert.match(result.result, /^Widget rendered/);
});

test('invalid spec returns retryable error; retry succeeds', async (t) => {
  let calls = 0;
  const server = await startServer((body) => {
    const toolMsgs = body.messages.filter(m => m.role === 'tool');
    if (toolMsgs.length === 0) { calls++; return [toolCallChunk('render_ui', { spec: 'garbage' }), chunk({}, 'tool_calls')]; }
    if (toolMsgs.length === 1) { calls++; return [toolCallChunk('render_ui', { spec: VALID_JSONL }, 'call_2'), chunk({}, 'tool_calls')]; }
    return textChunks('done');
  });
  t.after(() => server.close());
  const events = await runTurn(server);
  const results = events.filter(e => e.type === 'tool_result' && e.name === 'render_ui');
  assert.strictEqual(results.length, 2);
  assert.match(results[0].result, /^Error: invalid UI spec/);
  assert.match(results[1].result, /^Widget rendered/);
  assert.strictEqual(calls, 2);
});

test('system prompt: markdown default, no forced SpecStream; subagents lack render_ui', async (t) => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some(tl => tl.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some(m => m.role === 'tool');
    if (isMain && !hasToolMsg) return [toolCallChunk('spawn_agent', { task: 'x' }), chunk({}, 'tool_calls')];
    if (isMain) return textChunks('done');
    return textChunks('sub findings');
  });
  t.after(() => server.close());
  await runTurn(server);

  const mainReq = server.requests.find(b => (b.tools ?? []).some(tl => tl.function.name === 'spawn_agent'));
  const sys = mainReq.messages.find(m => m.role === 'system').content;
  assert.ok(!sys.includes('must be valid UI spec JSONL'), 'forced SpecStream instruction removed');
  assert.match(sys, /GitHub-flavored Markdown/);
  assert.match(sys, /render_ui/);
  assert.ok(mainReq.tools.some(tl => tl.function.name === 'render_ui'), 'main agent has render_ui');

  const subReq = server.requests.find(b => (b.tools ?? []).length > 0 && !b.tools.some(tl => tl.function.name === 'spawn_agent'));
  assert.ok(subReq, 'subagent request captured');
  assert.ok(!subReq.tools.some(tl => tl.function.name === 'render_ui'), 'subagent lacks render_ui');
});
