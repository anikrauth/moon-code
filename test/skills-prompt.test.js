const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

const SKILLS_TEXT = 'ACTIVE SKILLS — follow these working practices:\n\nTest-Driven:\nAlways write the failing test first.';

function run(server, skillsText) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      async () => true, undefined, undefined, skillsText);
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
