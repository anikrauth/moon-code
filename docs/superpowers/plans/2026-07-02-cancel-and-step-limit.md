# Turn Cancellation + Step Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop button cancels the running turn for real (HTTP stream aborted, shell commands killed, subagents included); step limit raised 10 → 50.

**Architecture:** `AbortController` per turn in `main.ts`, signal threaded `handlePrompt → runAgentLoop/streamText` and `makeTools → execAsync`, `spawn_agent` reuses the same signal. Renderer: Stop button in `RichInput`, `agent:cancel` IPC, permission queue flushed on `done`.

**Tech Stack:** node:test + fake-SSE harness (one test-local stalling server); `npm test` currently 34 passing.

## Global Constraints

- `MAX_STEPS = 50`; `stopWhen: stepCountIs(MAX_STEPS)` in `runAgentLoop` (single call site — subagents share it).
- `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission, abortSignal?)` — new TRAILING param; all existing callers/tests keep working with it undefined.
- Cancel error event exact: `{ type: 'error', agent: 'main', content: 'Cancelled.' }` (detected via `abortSignal?.aborted` in handlePrompt's catch), followed by the normal `done`.
- `agent:cancel` must resolve every pending permission with `false` and clear the map.
- Stop button always clickable while busy, even though the textarea is disabled.
- `// @ts-nocheck` kept everywhere.

---

### Task 1: Main-process abort plumbing + step limit (TDD)

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/main/main.ts`
- Create: `test/cancel.test.js`

**Interfaces:**
- Produces: `handlePrompt(..., abortSignal?)`; `MAX_STEPS`; `agent:cancel` IPC channel. Task 2 consumes `agent:cancel` via preload.

- [ ] **Step 1: Write failing tests**

```js
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
```

- [ ] **Step 2: Run to verify failure** — `npm test`: test 1/2 hang-then-timeout or finish without Cancel error (no signal support); test 3 sees ~10 requests.

- [ ] **Step 3: Implement in `agent.ts`**

- `const MAX_STEPS = 50;` near other constants.
- `makeTools({ workspace, onEvent, requestPermission, agentId, includeSpawn, settings, spawnState, abortSignal })` — `run_command`'s exec options become `{ cwd: workspace, timeout: 60000, signal: abortSignal }`; `spawn_agent` passes `abortSignal` into BOTH its inner `makeTools({...})` and `runAgentLoop({...})` calls.
- `runAgentLoop({ ..., abortSignal })` — `streamText({ ..., abortSignal, stopWhen: stepCountIs(MAX_STEPS) })`.
- `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission, abortSignal)` — pass `abortSignal` to `makeTools` and `runAgentLoop`; catch block becomes:

```ts
} catch (error: any) {
    const cancelled = abortSignal?.aborted;
    onEvent({ type: 'error', agent: 'main', content: cancelled ? 'Cancelled.' : error.message });
    onEvent({ type: 'done' });
}
```

- [ ] **Step 4: Implement in `main.ts`**

Inside `whenReady`, near the permission state:

```ts
let activeTurn: AbortController | null = null;
```

`agent:prompt` handler, before calling `handlePrompt`:

```ts
activeTurn?.abort();
activeTurn = new AbortController();
```

…and pass `activeTurn.signal` as the new trailing arg to `handlePrompt`.

New handler:

```ts
ipcMain.on('agent:cancel', () => {
    activeTurn?.abort();
    for (const resolver of pendingPermissions.values()) resolver(false, false);
    pendingPermissions.clear();
});
```

- [ ] **Step 5: Run to verify pass** — `npm test`: 37/37.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts src/main/main.ts test/cancel.test.js
git commit -m "feat: cancellable turns with AbortController; raise step limit to 50"
```

---

### Task 2: Renderer — Stop button + cancel IPC + queue flush

**Files:**
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/RichInput.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `agent:cancel` channel from Task 1.
- Produces: `window.electron.cancelPrompt()`; `RichInput` props `busy: boolean`, `onStop: () => void`.

- [ ] **Step 1: preload**

```ts
cancelPrompt: () => ipcRenderer.send('agent:cancel'),
```

- [ ] **Step 2: RichInput**

Add `Square` to the lucide-react import. Props interface + destructuring gain `busy` (default `false`) and `onStop`. Replace the send button JSX with:

```tsx
{busy ? (
  <button
    className="ri-send-btn ri-send-active"
    onClick={onStop}
    aria-label="Stop generation"
    title="Stop"
  >
    <Square size={14} />
  </button>
) : (
  <button
    className={`ri-send-btn ${value.trim() && !disabled ? 'ri-send-active' : ''}`}
    onClick={onSend}
    disabled={!value.trim() || disabled}
    aria-label="Send message"
  >
    <Send size={16} />
  </button>
)}
```

(The stop branch has no `disabled` attribute — always clickable.)

- [ ] **Step 3: App.tsx**

`<RichInput />` gains:

```tsx
busy={isTyping}
onStop={() => window.electron?.cancelPrompt()}
```

`done` branch of `onAgentEvent` gains `setPermissionQueue([]);` (after `setStatusText(null);`).

- [ ] **Step 4: Verify** — `npx tsc --noEmit && npx vite build && npm test` → clean, 37/37.

- [ ] **Step 5: Commit**

```bash
git add src/preload/preload.ts src/renderer/RichInput.tsx src/renderer/App.tsx
git commit -m "feat: stop button cancels the running turn"
```
