# Subagents + History Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Main agent can delegate tasks to parallel subagents via a `spawn_agent` tool, and long histories are LLM-summarized instead of silently sliced at 20 messages.

**Architecture:** Everything in-process in `src/main/agent.ts`: extract the streaming loop into a reusable `runAgentLoop`, build tools through a factory so subagents get the same tools minus `spawn_agent`, tag every renderer event with an `agent` id, and run one `generateText` summarize call when history crosses `MAX_HISTORY`. Renderer gains agent badges, a `status` line, and per-agent tool-result matching.

**Tech Stack:** Electron main process (CommonJS, `tsc -p tsconfig.main.json` → `dist/main`), AI SDK v7 (`streamText`, `generateText`, `tool` with `inputSchema`), React 19 renderer built by Vite, tests via Node's built-in `node:test` + a fake OpenAI-compatible SSE server (no new dependencies).

## Global Constraints

- AI SDK v7: tools use `inputSchema:` (NOT `parameters:` — it is silently ignored). Stream parts: `text-delta` carries `.text`; final messages via `await result.responseMessages`.
- All source files in this repo start with `// @ts-nocheck`; keep that convention in `agent.ts` / `App.tsx` edits.
- `MAX_HISTORY = 20`, keep-recent on compaction = 8 messages.
- Event shape over `agent:event` IPC: `{ type, agent, ... }`; `agent` is `'main'` or `'sub-N'`.
- Subagents must go through the same `requestPermission` gate; no recursion (`spawn_agent` absent from subagent toolset).
- Tests must not require network or a real API key: fake OpenAI server on `127.0.0.1`, port 0 (ephemeral).
- Compaction failure must never fail a turn: fall back to the old slice-at-20 behavior.

---

### Task 1: Test infrastructure — fake OpenAI server, `npm test`, smoke test

**Files:**
- Create: `test/helpers/fake-openai.js`
- Create: `test/streaming.test.js`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `startServer(route) -> Promise<http.Server & {requests: object[]}>` where `route(body) -> chunkObject[]`; `chunk(delta, finish?)`; `toolCallChunk(name, args, id?, index?)`; `textChunks(...texts)` (ends with `finish_reason: "stop"`); `baseUrlOf(server) -> string`. Later tasks' tests all consume these.

- [ ] **Step 1: Write the helper**

```js
// test/helpers/fake-openai.js
const http = require('http');

function chunk(delta, finish = null) {
  return { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }] };
}

function toolCallChunk(name, args, id = 'call_1', index = 0) {
  return chunk({ tool_calls: [{ index, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] });
}

function textChunks(...texts) {
  return [...texts.map(t => chunk({ content: t })), chunk({}, 'stop')];
}

// route(parsedRequestBody) -> array of chunk objects, or {status, body} for error responses
function startServer(route) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => {
      const body = JSON.parse(raw);
      server.requests.push(body);
      const out = route(body);
      if (out && !Array.isArray(out)) {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body ?? { error: { message: 'mock error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const p of out) res.write(`data: ${JSON.stringify(p)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.requests = [];
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const baseUrlOf = (server) => `http://127.0.0.1:${server.address().port}/v1`;

module.exports = { chunk, toolCallChunk, textChunks, startServer, baseUrlOf };
```

- [ ] **Step 2: Add scripts to `package.json`**

```json
"build:main": "tsc -p tsconfig.main.json",
"test": "npm run build:main && node --test test/*.test.js"
```

- [ ] **Step 3: Write the smoke test (locks current streaming behavior before refactor)**

```js
// test/streaming.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

function runTurn(server, { history, permission = async () => true, workspace = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('hello', workspace,
      { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, history,
      (e) => { events.push(e); if (e.type === 'done') resolve(events); },
      permission);
  });
}
module.exports = { runTurn };

test('streams text deltas as separate message events', async () => {
  const server = await startServer(() => textChunks('Hel', 'lo.'));
  const events = await runTurn(server);
  const deltas = events.filter(e => e.type === 'message').map(e => e.content);
  assert.deepStrictEqual(deltas, ['Hel', 'lo.']);
  assert.ok(events.find(e => e.type === 'done').history.length >= 2);
  server.close();
});
```

- [ ] **Step 4: Run — must pass against current code**

Run: `npm test`
Expected: `pass 1` (current `handlePrompt` signature already matches `runTurn`).

- [ ] **Step 5: Commit**

```bash
git add test/ package.json package-lock.json
git commit -m "test: fake OpenAI SSE harness and streaming smoke test"
```

---

### Task 2: Extract `runAgentLoop`, tag all events with `agent`, thread agent id into permissions

**Files:**
- Modify: `src/main/agent.ts` (restructure whole file)
- Modify: `src/main/main.ts` (permission_request event gains `agent`)
- Test: `test/streaming.test.js` (extend)

**Interfaces:**
- Produces: internal `runAgentLoop({ prompt, workspace, settings, history, onEvent, requestPermission, agentId, tools, systemPrompt, emitText }) -> Promise<{ text, responseMessages }>`; internal `makeTools({ workspace, onEvent, requestPermission, agentId, includeSpawn, settings, spawnState }) -> tools object` (spawn wired in Task 3; accept and ignore `includeSpawn`/`spawnState` for now); exported `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission)` unchanged signature, but `requestPermission` is now called as `(name, args, agentId)`.
- Consumes: Task 1 harness.

- [ ] **Step 1: Extend the smoke test — all events carry `agent: 'main'`; permission gets agent id**

```js
test('all events tagged agent main; permission receives agent id', async () => {
  const { toolCallChunk, chunk } = require('./helpers/fake-openai');
  const permArgs = [];
  const server = await startServer((body) =>
    body.messages.some(m => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('run_command', { command: 'echo hi' }), chunk({}, 'tool_calls')]);
  const events = await runTurn(server, { permission: async (name, args, agentId) => { permArgs.push([name, agentId]); return true; } });
  for (const e of events.filter(e => e.type !== 'done')) assert.strictEqual(e.agent, 'main');
  assert.deepStrictEqual(permArgs, [['run_command', 'main']]);
  server.close();
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test` → new test FAILS (`e.agent` undefined).

- [ ] **Step 3: Restructure `agent.ts`**

Keep imports, `dotenv`, `catalog`, `MAX_HISTORY`, `loadProjectMemory` as-is. Replace the body:

```ts
function makeTools({ workspace, onEvent, requestPermission, agentId, includeSpawn, settings, spawnState }) {
    const emit = (e) => onEvent({ agent: agentId, ...e });
    const denied = (name) => {
        const res = 'User denied permission for this action.';
        emit({ type: 'tool_result', name, result: res });
        return res;
    };
    const tools: any = {
        run_command: tool({
            description: 'Execute a bash command in the current workspace.',
            inputSchema: z.object({ command: z.string().describe('The command line string to execute.') }),
            execute: async ({ command }) => {
                emit({ type: 'tool_call', name: 'run_command', arguments: JSON.stringify({ command }) });
                if (!await requestPermission('run_command', { command }, agentId)) return denied('run_command');
                try {
                    const { stdout, stderr } = await execAsync(command, { cwd: workspace, timeout: 60000 });
                    const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
                    const finalOut = output.trim() ? output : 'Command executed successfully (no output).';
                    emit({ type: 'tool_result', name: 'run_command', result: finalOut });
                    return finalOut;
                } catch (e: any) {
                    emit({ type: 'tool_result', name: 'run_command', result: `Error: ${e.message}` });
                    return `Error: ${e.message}`;
                }
            }
        }),
        /* read_file, write_file, edit_file, list_dir: identical bodies to current
           file, with two mechanical changes each:
           - onEvent({...}) -> emit({...})
           - requestPermission(name, args) -> requestPermission(name, args, agentId)
           (read_file and list_dir have no permission call, unchanged otherwise) */
    };
    return tools;
}

async function runAgentLoop({ prompt, workspace, settings, history, onEvent, requestPermission, agentId, tools, systemPrompt, emitText }) {
    const customOpenAI = createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined });
    const userMsg = { role: 'user', content: prompt };
    const result = streamText({
        model: customOpenAI.chat(settings.model || 'gpt-4o'),
        system: systemPrompt,
        messages: [...(history ?? []), userMsg],
        tools,
        stopWhen: stepCountIs(10),
    });
    for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
            if (emitText) onEvent({ type: 'message', agent: agentId, content: part.text });
        } else if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
    }
    return { text: await result.text, responseMessages: await result.responseMessages };
}

export async function handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission) {
    try {
        const projectMemory = await loadProjectMemory(workspace);
        const systemPrompt = `You are Moon Agent, ... (identical template to current file, including projectMemory block and catalog.prompt call)`;
        const tools = makeTools({ workspace, onEvent, requestPermission, agentId: 'main', includeSpawn: true, settings, spawnState: { counter: 0, projectMemory } });
        const { responseMessages } = await runAgentLoop({
            prompt, workspace, settings, history, onEvent, requestPermission,
            agentId: 'main', tools, systemPrompt, emitText: true,
        });
        const userMsg = { role: 'user', content: prompt };
        let newHistory = [...(history ?? []), userMsg, ...responseMessages];
        if (newHistory.length > MAX_HISTORY) {
            let cutIndex = newHistory.length - MAX_HISTORY;
            while (cutIndex < newHistory.length && newHistory[cutIndex].role === 'tool') cutIndex++;
            newHistory = newHistory.slice(cutIndex);
        }
        onEvent({ type: 'done', history: newHistory });
    } catch (error: any) {
        onEvent({ type: 'error', agent: 'main', content: error.message });
        onEvent({ type: 'done' });
    }
}
```

(The post-turn slice stays for now; Task 4 replaces it with pre-turn compaction.)

- [ ] **Step 4: `main.ts` — include agent in permission_request**

`requestPermission` callback signature gains `agentId` and forwards it:

```ts
const requestPermission = (name: string, args: any, agentId: string): Promise<boolean> => {
  if (sessionAllowedTools.has(name)) return Promise.resolve(true);
  const id = `perm-${++permissionCounter}`;
  return new Promise((resolve) => {
    pendingPermissions.set(id, (allow, alwaysAllow) => {
      if (allow && alwaysAllow) sessionAllowedTools.add(name);
      resolve(allow);
    });
    event.reply('agent:event', { type: 'permission_request', id, name, arguments: args, agent: agentId });
  });
};
```

- [ ] **Step 5: Run** — `npm test` → both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts src/main/main.ts test/streaming.test.js
git commit -m "refactor: extract runAgentLoop, tag agent events, thread agent id to permissions"
```

---

### Task 3: `spawn_agent` tool — parallel, gated, no recursion, error-contained

**Files:**
- Modify: `src/main/agent.ts`
- Test: `test/subagents.test.js` (create)

**Interfaces:**
- Consumes: `makeTools` / `runAgentLoop` from Task 2 (`spawnState = { counter, projectMemory }` threaded through `makeTools`).
- Produces: `spawn_agent` tool visible only in the main agent's request `tools`; subagent events tagged `sub-1`, `sub-2`, …

- [ ] **Step 1: Write failing tests**

```js
// test/subagents.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

test('parallel subagents: gated, tagged, no recursion, results returned', { timeout: 10000 }, async () => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some(t => t.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some(m => m.role === 'tool');
    if (isMain && !hasToolMsg) return [
      toolCallChunk('spawn_agent', { task: 'task A' }, 'call_a', 0),
      toolCallChunk('spawn_agent', { task: 'task B' }, 'call_b', 1),
      chunk({}, 'tool_calls'),
    ];
    if (isMain) return textChunks('combined answer');
    // subagent turns: one gated command, then findings
    if (!hasToolMsg) return [toolCallChunk('run_command', { command: 'true' }), chunk({}, 'tool_calls')];
    return textChunks('sub findings');
  });

  // Permission stub resolves only after BOTH subagents have asked.
  // If spawns ran serially, the second request never arrives -> test times out. This proves parallelism.
  const permAgents = [];
  let release; const bothAsked = new Promise(r => release = r);
  const permission = (name, args, agentId) => {
    permAgents.push(agentId);
    if (permAgents.length === 2) release();
    return bothAsked.then(() => true);
  };

  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, permission);
  });

  assert.deepStrictEqual(new Set(permAgents), new Set(['sub-1', 'sub-2']));
  const subToolEvents = events.filter(e => e.type === 'tool_call' && e.name === 'run_command');
  assert.deepStrictEqual(new Set(subToolEvents.map(e => e.agent)), new Set(['sub-1', 'sub-2']));
  const spawnResults = events.filter(e => e.type === 'tool_result' && e.name === 'spawn_agent');
  assert.strictEqual(spawnResults.length, 2);
  for (const r of spawnResults) assert.match(r.result, /sub findings/);
  // no recursion: subagent requests must not offer spawn_agent
  const subReqs = server.requests.filter(b => !(b.tools ?? []).some(t => t.function.name === 'spawn_agent'));
  assert.ok(subReqs.length >= 2);
  assert.deepStrictEqual(events.filter(e => e.type === 'message').map(e => e.agent), Array(events.filter(e => e.type === 'message').length).fill('main'));
  server.close();
});

test('subagent failure is contained as error tool result', async () => {
  const server = await startServer((body) => {
    const isMain = (body.tools ?? []).some(t => t.function.name === 'spawn_agent');
    const hasToolMsg = body.messages.some(m => m.role === 'tool');
    if (isMain && !hasToolMsg) return [toolCallChunk('spawn_agent', { task: 'boom' }), chunk({}, 'tool_calls')];
    if (isMain) return textChunks('recovered');
    return { status: 400 }; // subagent model call fails
  });
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true);
  });
  const r = events.find(e => e.type === 'tool_result' && e.name === 'spawn_agent');
  assert.match(r.result, /^Error: /);
  assert.strictEqual(events.filter(e => e.type === 'error').length, 0); // parent turn survived
  server.close();
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → subagents tests FAIL (`spawn_agent` unknown tool / no tool_result).

- [ ] **Step 3: Implement `spawn_agent` inside `makeTools`**

Append after `list_dir`, guarded by `includeSpawn`:

```ts
    if (includeSpawn) {
        tools.spawn_agent = tool({
            description: 'Delegate a self-contained task to a parallel subagent with its own tool access. The subagent cannot ask you questions — include all needed context in the task. Returns its plain-text findings. You may call spawn_agent multiple times in one step to run tasks in parallel.',
            inputSchema: z.object({
                task: z.string().describe('Complete, self-contained task description with all necessary context.'),
            }),
            execute: async ({ task }) => {
                const subId = `sub-${++spawnState.counter}`;
                emit({ type: 'tool_call', name: 'spawn_agent', arguments: JSON.stringify({ task }) });
                const subSystemPrompt = `You are a Moon Agent subagent working autonomously in the workspace at ${workspace}. Complete the following task using your tools, then reply with concise plain-text findings. Do not ask questions; do not output JSON UI specs.
${spawnState.projectMemory ? `\nPROJECT INSTRUCTIONS (from MOON.md in the workspace root — follow these):\n${spawnState.projectMemory}\n` : ''}`;
                try {
                    const subTools = makeTools({ workspace, onEvent, requestPermission, agentId: subId, includeSpawn: false, settings, spawnState });
                    const { text } = await runAgentLoop({
                        prompt: task, workspace, settings, history: [],
                        onEvent, requestPermission, agentId: subId,
                        tools: subTools, systemPrompt: subSystemPrompt, emitText: false,
                    });
                    const res = text?.trim() ? text : 'Subagent finished with no output.';
                    onEvent({ type: 'tool_result', name: 'spawn_agent', agent: agentId, result: res });
                    return res;
                } catch (e: any) {
                    const errMsg = `Error: subagent failed: ${e.message}`;
                    onEvent({ type: 'tool_result', name: 'spawn_agent', agent: agentId, result: errMsg });
                    return errMsg;
                }
            }
        });
    }
```

- [ ] **Step 4: Run** — `npm test` → all PASS. (If spawns serialize, the parallelism test deadlocks and fails via its explicit 10s `timeout` option — that is the failure signal.)

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts test/subagents.test.js
git commit -m "feat: spawn_agent tool - parallel subagents with permission inheritance"
```

---

### Task 4: History compaction with LLM summary + fallback

**Files:**
- Modify: `src/main/agent.ts`
- Test: `test/compaction.test.js` (create)

**Interfaces:**
- Consumes: `handlePrompt` from Task 2/3.
- Produces: internal `compactHistory(history, settings, onEvent) -> Promise<history>`; `status` event `{ type: 'status', agent: 'main', content: 'Compacting history…' }`; post-turn slice in `handlePrompt` REMOVED (pre-turn compaction replaces it).

- [ ] **Step 1: Write failing tests**

```js
// test/compaction.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

const longHistory = () => Array.from({ length: 25 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));

function run(server, history) {
  return new Promise((resolve) => {
    const events = [];
    handlePrompt('next question', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' },
      history, (e) => { events.push(e); if (e.type === 'done') resolve(events); }, async () => true);
  });
}

test('history over MAX_HISTORY is summarized into one message', async () => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : textChunks('THE-SUMMARY'));
  const events = await run(server, longHistory());

  assert.ok(events.some(e => e.type === 'status' && /Compacting/.test(e.content)));
  const summarizeReq = server.requests.find(b => !b.tools);
  assert.ok(summarizeReq, 'summarize call was made');
  const mainReq = server.requests.find(b => b.tools);
  const first = mainReq.messages.filter(m => m.role !== 'system')[0];
  assert.match(first.content, /^\[Earlier conversation summary\]\nTHE-SUMMARY/);
  // summary + last 8 kept + new user prompt
  assert.strictEqual(mainReq.messages.filter(m => m.role !== 'system').length, 10);
  const done = events.find(e => e.type === 'done');
  assert.match(done.history[0].content, /^\[Earlier conversation summary\]/);
  assert.strictEqual(done.history.length, 11); // summary + 8 recent + user + assistant
  server.close();
});

test('summarize failure falls back to slice, turn still completes', async () => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : { status: 400 });
  const events = await run(server, longHistory());
  const done = events.find(e => e.type === 'done');
  assert.ok(done.history.length > 0);
  assert.strictEqual(events.filter(e => e.type === 'error').length, 0);
  const mainReq = server.requests.find(b => b.tools);
  assert.strictEqual(mainReq.messages.filter(m => m.role !== 'system').length, 21); // sliced 20 + new prompt
  server.close();
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → compaction tests FAIL (no summarize call, wrong counts).

- [ ] **Step 3: Implement**

Add to `agent.ts` (top: also `import { generateText } from 'ai'` — extend the existing import):

```ts
const KEEP_RECENT = 8;
const TRANSCRIPT_CHAR_LIMIT = 30000;

function sliceHistory(history) {
    let cutIndex = history.length - MAX_HISTORY;
    while (cutIndex < history.length && history[cutIndex].role === 'tool') cutIndex++;
    return history.slice(cutIndex);
}

async function compactHistory(history, settings, onEvent) {
    if (!history || history.length <= MAX_HISTORY) return history;
    let cut = history.length - KEEP_RECENT;
    while (cut < history.length && history[cut].role === 'tool') cut++;
    const old = history.slice(0, cut);
    const recent = history.slice(cut);
    try {
        onEvent({ type: 'status', agent: 'main', content: 'Compacting history…' });
        const transcript = old.map(m =>
            `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
        ).join('\n').slice(-TRANSCRIPT_CHAR_LIMIT);
        const customOpenAI = createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined });
        const { text } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: 'Summarize the conversation compactly. Preserve file paths, decisions made, code changes, and unresolved tasks.',
            prompt: `Conversation to summarize:\n${transcript}`,
            maxRetries: 1,
        });
        return [{ role: 'user', content: `[Earlier conversation summary]\n${text}` }, ...recent];
    } catch {
        return sliceHistory(history);
    }
}
```

In `handlePrompt`: first line of `try` becomes `history = await compactHistory(history, settings, onEvent);` and DELETE the post-turn `if (newHistory.length > MAX_HISTORY) {...}` block (`newHistory` is used as-is).

- [ ] **Step 4: Run** — `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts test/compaction.test.js
git commit -m "feat: LLM history compaction with slice fallback"
```

---

### Task 5: Renderer — agent badges, per-agent result matching, status line, modal badge

**Files:**
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: events with `agent` field, `status` event, `permission_request.agent` (Tasks 2–4).
- Produces: UI only; no exports.

- [ ] **Step 1: `tool_result` matching by (name, agent)**

In the `onAgentEvent` handler replace the `findIndex` line:

```ts
const callIdx = lastMsg.toolCalls.findIndex((c: any) =>
    c.name === event.name && (c.agent ?? 'main') === (event.agent ?? 'main') && !c.result);
```

- [ ] **Step 2: `status` event + status line**

Add state `const [statusText, setStatusText] = useState<string | null>(null);`
In `onAgentEvent`: `if (event.type === 'status') { setStatusText(event.content); return; }`
In the `done` branch add `setStatusText(null);` and in `handleSend` add `setStatusText(null);`
Change the typing row text: `{statusText ?? 'Agent is thinking...'}`

- [ ] **Step 3: Agent badge on tool rows**

Inside the tool-call row `<span>`, before the tool name:

```tsx
{tool.agent && tool.agent !== 'main' && (
    <span style={{ background: 'rgba(255,255,255,0.1)', borderRadius: '4px', padding: '1px 6px', marginRight: '4px', fontSize: '10px' }}>
        {tool.agent}
    </span>
)}
<span>{tool.result ? 'Ran' : 'Executing'} <strong>{tool.name}</strong>{tool.result ? '' : '...'}</span>
```

- [ ] **Step 4: Modal badge**

In the permission modal paragraph:

```tsx
<p style={{ margin: '8px 0', color: 'var(--text-secondary)' }}>
    {permissionQueue[0].agent && permissionQueue[0].agent !== 'main' ? `Subagent ${permissionQueue[0].agent}` : 'The agent'} wants to run <strong>{permissionQueue[0].name}</strong>:
</p>
```

- [ ] **Step 5: Verify** — Run: `npx tsc --noEmit && npx vite build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: renderer support for subagent badges, status line, per-agent tool results"
```
