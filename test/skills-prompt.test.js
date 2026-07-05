const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/features/agent/index.js');

const SKILLS_TEXT = 'ACTIVE SKILLS — follow these working practices:\n\nTest-Driven:\nAlways write the failing test first.';

function run(server, skillsText, skillsCatalog) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      async () => true, undefined, undefined, skillsText, undefined, skillsCatalog);
  });
}

test('skillsText lands in the main system prompt; absent when empty', async (t) => {
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  await run(server, SKILLS_TEXT);
  const sys1 = server.requests[0].messages.find((m) => m.role === 'system').content;
  assert.ok(sys1.includes('ACTIVE SKILLS'));
  assert.ok(sys1.includes('Always write the failing test first.'));
  await run(server, '');
  const sys2 = server.requests[1].messages.find((m) => m.role === 'system').content;
  assert.ok(!sys2.includes('ACTIVE SKILLS'));
});

test('BUG-FIX TRIGGER appears only when structured-investigation is in the catalog', async (t) => {
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  await run(server, 'AVAILABLE SKILLS:\n- structured-investigation: bug-fix methodology');
  const sys1 = server.requests[0].messages.find((m) => m.role === 'system').content;
  assert.ok(sys1.includes('BUG-FIX TRIGGER'));
  assert.ok(sys1.includes('`structured-investigation`'));
  await run(server, SKILLS_TEXT);
  const sys2 = server.requests[1].messages.find((m) => m.role === 'system').content;
  assert.ok(!sys2.includes('BUG-FIX TRIGGER'), 'no trigger when skill not installed');
  await run(server, '');
  const sys3 = server.requests[2].messages.find((m) => m.role === 'system').content;
  assert.ok(!sys3.includes('BUG-FIX TRIGGER'), 'no trigger when skillsText empty');
});

test('subagent system prompt also carries skillsText', { timeout: 15000 }, async (t) => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some((x) => x.function.name === 'spawn_agent');
    const hasTool = body.messages.some((m) => m.role === 'tool');
    if (isMain && !hasTool) return [toolCallChunk('spawn_agent', { task: 'sub task' }), chunk({}, 'tool_calls')];
    if (isMain) return textChunks('done');
    return textChunks('sub findings');
  });
  t.after(() => server.close());
  await run(server, SKILLS_TEXT);
  const subReq = server.requests.find((b) => !(b.tools ?? []).some((x) => x.function.name === 'spawn_agent'));
  assert.ok(subReq, 'subagent request captured');
  const subSys = subReq.messages.find((m) => m.role === 'system').content;
  assert.ok(subSys.includes('ACTIVE SKILLS'));
});

test('model can invoke the skill tool to load full instructions (Claude-Code-style progressive disclosure)', async (t) => {
  const catalog = [{ id: 'code-review', description: 'Rigorous review discipline', content: 'Full SKILL.md body: review every diff line by line.' }];
  const server = await startServer((body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) return [toolCallChunk('skill', { skill_id: 'code-review' }), chunk({}, 'tool_calls')];
    return textChunks('done');
  });
  t.after(() => server.close());

  // Registering the skill tool requires a non-empty catalog, and the model
  // must be told it exists (via skillsText) to know to call it.
  const events = await run(server, 'AVAILABLE SKILLS — call the `skill` tool...', catalog);

  const firstReq = server.requests[0];
  const skillToolDef = firstReq.tools.find((t) => t.function.name === 'skill');
  assert.ok(skillToolDef, 'skill tool exposed to the model');

  const secondReq = server.requests[1];
  const toolResultMsg = secondReq.messages.find((m) => m.role === 'tool');
  assert.ok(toolResultMsg, 'tool result round-tripped back to the model');
  assert.strictEqual(toolResultMsg.content, catalog[0].content);

  const toolCallEvent = events.find((e) => e.type === 'tool_call' && e.name === 'skill');
  const toolResultEvent = events.find((e) => e.type === 'tool_result' && e.name === 'skill');
  assert.ok(toolCallEvent, 'tool_call event emitted for skill invocation');
  assert.deepStrictEqual(JSON.parse(toolCallEvent.arguments), { skill_id: 'code-review' });
  assert.strictEqual(toolResultEvent.result, catalog[0].content);
});

test('skill tool is not registered when the catalog is empty', async (t) => {
  const server = await startServer(() => textChunks('ok'));
  t.after(() => server.close());
  await run(server, '', []);
  const req = server.requests[0];
  assert.ok(!req.tools.some((t) => t.function.name === 'skill'), 'no skill tool when catalog empty');
});

test('unknown skill_id returns a helpful error instead of crashing the turn', async (t) => {
  const catalog = [{ id: 'code-review', description: 'd', content: 'c' }];
  const server = await startServer((body) => {
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) return [toolCallChunk('skill', { skill_id: 'nonexistent' }), chunk({}, 'tool_calls')];
    return textChunks('done');
  });
  t.after(() => server.close());
  const events = await run(server, 'AVAILABLE SKILLS', catalog);
  const toolResultEvent = events.find((e) => e.type === 'tool_result' && e.name === 'skill');
  assert.match(toolResultEvent.result, /no skill named "nonexistent"/);
  assert.match(toolResultEvent.result, /code-review/);
});
