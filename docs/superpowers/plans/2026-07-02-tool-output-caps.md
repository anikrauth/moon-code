# Tool Output Caps + Token-Aware Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every tool result before it reaches the model/renderer; trigger history compaction on estimated token size, not just message count.

**Architecture:** All changes in `src/main/agent.ts` (constants + `truncateOutput` helper + per-tool caps + `historyTokens` trigger in `compactHistory`). Subagents inherit via the shared `makeTools`. Tests extend the existing fake-OpenAI harness.

**Tech Stack:** node:test + `test/helpers/fake-openai.js`; `npm test` = `tsc -p tsconfig.main.json && node --test test/*.test.js`. All source files start `// @ts-nocheck`.

## Global Constraints

- Constants (exact values): `TOOL_OUTPUT_CHAR_LIMIT = 30000`, `READ_DEFAULT_LINES = 2000`, `READ_CHAR_LIMIT = 50000`, `LIST_DIR_MAX_ENTRIES = 500`, `HISTORY_TOKEN_BUDGET = 40000`.
- `truncateOutput`: unchanged when `length <= limit`; else `head = floor(limit*0.8)` chars + `\n[... truncated <removed> chars ...]\n` + last `floor(limit*0.1)` chars.
- `read_file` paging marker (exact format): `\n[showing lines <first>–<last> of <total> total — call again with offset/limit for more]`; only appended when the window doesn't cover the whole file. Out-of-range: `Error: offset <offset> is beyond end of file (<total> lines).`
- Token estimate: `Math.ceil(s.length / 4)`; compaction proceeds when `history.length > MAX_HISTORY || historyTokens(history) > HISTORY_TOKEN_BUDGET`.
- The truncated string is the single artifact: returned to the model AND emitted in the `tool_result` event.
- Existing 15 tests must keep passing (17+ after Task 1, 19+ after Task 2).
- Tests: `t.after(() => server.close())`; temp workspaces via `fs.mkdtempSync` cleaned in `t.after`.

---

### Task 1: Output caps — `truncateOutput`, read_file paging, list_dir cap (TDD)

**Files:**
- Modify: `src/main/agent.ts`
- Create: `test/output-caps.test.js`

**Interfaces:**
- Produces: `truncateOutput(text, limit?)` module-level helper (Task 2 does not consume it, but the final review will expect this exact name); `read_file` schema gains `offset`/`limit`.

- [ ] **Step 1: Write failing tests**

```js
// test/output-caps.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

function mkWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Drives one turn: first model step issues `call`, second returns text.
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
  return events.find((e) => e.type === 'tool_result' && e.name === call.name).result;
}

test('read_file caps large files with paging marker', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'big.txt' } });
  assert.ok(result.includes('line 1\n'));
  assert.ok(!result.includes('line 3000\n'));
  assert.match(result, /\[showing lines 1–2000 of 5000 total — call again with offset\/limit for more\]$/);
});

test('read_file offset/limit returns exact window', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'big.txt', offset: 4990, limit: 5 } });
  assert.ok(result.startsWith('line 4990'));
  assert.ok(result.includes('line 4994'));
  assert.ok(!result.includes('line 4995'));
  assert.match(result, /\[showing lines 4990–4994 of 5000 total/);
});

test('read_file out-of-range offset returns error string', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'small.txt'), 'a\nb\nc');
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'small.txt', offset: 100 } });
  assert.strictEqual(result, 'Error: offset 100 is beyond end of file (3 lines).');
});

test('small read_file passes through unmarked', async (t) => {
  const ws = mkWorkspace(t);
  fs.writeFileSync(path.join(ws, 'small.txt'), 'hello\nworld');
  const result = await runTool(t, ws, { name: 'read_file', args: { filePath: 'small.txt' } });
  assert.strictEqual(result, 'hello\nworld');
});

test('run_command output over 30k chars is middle-truncated', async (t) => {
  const ws = mkWorkspace(t);
  const cmd = `node -e "process.stdout.write('A'.repeat(40000) + 'MIDDLE' + 'B'.repeat(40000))"`;
  const result = await runTool(t, ws, { name: 'run_command', args: { command: cmd } });
  assert.ok(result.length < 31000);
  assert.ok(result.startsWith('AAAA'));
  assert.ok(result.endsWith('BBBB'));
  assert.ok(!result.includes('MIDDLE'));
  assert.match(result, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
});

test('small run_command output passes through byte-identical', async (t) => {
  const ws = mkWorkspace(t);
  const result = await runTool(t, ws, { name: 'run_command', args: { command: 'echo hello' } });
  assert.strictEqual(result, 'hello\n');
});

test('list_dir caps entries at 500', async (t) => {
  const ws = mkWorkspace(t);
  for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(ws, `f${String(i).padStart(3, '0')}.txt`), '');
  const result = await runTool(t, ws, { name: 'list_dir', args: { dirPath: '.' } });
  assert.strictEqual(result.split('\n').length, 501); // 500 entries + marker line
  assert.match(result, /\[\.\.\. 10 more entries not shown\]$/);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`: paging/truncation tests FAIL (no markers, full output).

- [ ] **Step 3: Implement in `src/main/agent.ts`**

Constants after `MAX_HISTORY`:

```ts
const TOOL_OUTPUT_CHAR_LIMIT = 30000;
const READ_DEFAULT_LINES = 2000;
const READ_CHAR_LIMIT = 50000;
const LIST_DIR_MAX_ENTRIES = 500;
```

Helper (module level):

```ts
function truncateOutput(text, limit = TOOL_OUTPUT_CHAR_LIMIT) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit * 0.8);
    const tail = Math.floor(limit * 0.1);
    const removed = text.length - head - tail;
    return `${text.slice(0, head)}\n[... truncated ${removed} chars ...]\n${text.slice(-tail)}`;
}
```

`run_command`: `const finalOut = output.trim() ? truncateOutput(output) : 'Command executed successfully (no output).';`

`read_file` — schema:

```ts
inputSchema: z.object({
    filePath: z.string().describe('Path to the file, relative to workspace.'),
    offset: z.number().int().min(1).nullable().describe('1-based line number to start reading from. Default 1.'),
    limit: z.number().int().min(1).nullable().describe('Maximum number of lines to return. Default 2000.'),
}),
```

`read_file` — execute body (inside the existing try, replacing the plain read/return):

```ts
const absPath = path.join(workspace, filePath);
const content = await fs.promises.readFile(absPath, 'utf-8');
const lines = content.split('\n');
const total = lines.length;
const start = (offset ?? 1) - 1;
if (start >= total) {
    const errMsg = `Error: offset ${offset} is beyond end of file (${total} lines).`;
    emit({ type: 'tool_result', name: 'read_file', result: errMsg });
    return errMsg;
}
const window = lines.slice(start, start + (limit ?? READ_DEFAULT_LINES));
let text = window.join('\n');
let charCut = false;
if (text.length > READ_CHAR_LIMIT) {
    text = text.slice(0, READ_CHAR_LIMIT);
    charCut = true;
}
const lastLine = charCut ? start + text.split('\n').length : start + window.length;
if (start > 0 || lastLine < total || charCut) {
    text += `\n[showing lines ${start + 1}–${lastLine} of ${total} total — call again with offset/limit for more]`;
}
emit({ type: 'tool_result', name: 'read_file', result: text });
return text;
```

(The `tool_call` emit at the top of execute now includes `offset`/`limit` in its arguments JSON: `JSON.stringify({ filePath, offset, limit })`.)

`list_dir` result construction:

```ts
let res;
if (items.length === 0) res = 'Directory is empty.';
else if (items.length > LIST_DIR_MAX_ENTRIES) {
    res = `${items.slice(0, LIST_DIR_MAX_ENTRIES).join('\n')}\n[... ${items.length - LIST_DIR_MAX_ENTRIES} more entries not shown]`;
} else res = items.join('\n');
```

- [ ] **Step 4: Run to verify pass** — `npm test`: 22/22 (15 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts test/output-caps.test.js
git commit -m "feat: bound tool outputs - read_file paging, command truncation, list_dir cap"
```

---

### Task 2: Token-aware compaction trigger (TDD)

**Files:**
- Modify: `src/main/agent.ts` (compaction section)
- Modify: `test/compaction.test.js` (add two tests)

**Interfaces:**
- Consumes: existing `compactHistory`, `MAX_HISTORY`, `KEEP_RECENT`.
- Produces: `HISTORY_TOKEN_BUDGET`, `estimateTokens`, `historyTokens` module-level; `compactHistory` gains the token trigger and a `cut` floor.

- [ ] **Step 1: Add failing tests to `test/compaction.test.js`**

```js
test('few huge messages trigger token-based compaction', async (t) => {
  const server = await startServer((body) =>
    body.tools ? textChunks('answer') : textChunks('BIG-SUMMARY'));
  t.after(() => server.close());
  const huge = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(30000) }));
  const events = await run(server, huge);
  const summarizeReq = server.requests.find((b) => !b.tools);
  assert.ok(summarizeReq, 'token budget exceeded -> summarize call made');
  const mainReq = server.requests.find((b) => b.tools);
  const nonSystem = mainReq.messages.filter((m) => m.role !== 'system');
  assert.match(nonSystem[0].content, /^\[Earlier conversation summary\]\nBIG-SUMMARY/);
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
});

test('small short history skips compaction entirely', async (t) => {
  const server = await startServer(() => textChunks('answer'));
  t.after(() => server.close());
  const small = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  await run(server, small);
  assert.strictEqual(server.requests.length, 1);
  assert.ok(server.requests[0].tools, 'only the main call, no summarize');
});
```

(`run` already exists in this file; if its `t.after` server close was added at file level in the earlier fix round, follow the existing pattern.)

- [ ] **Step 2: Run to verify failure** — first new test FAILS (no summarize call for 6 messages).

- [ ] **Step 3: Implement**

Constants + helpers near `KEEP_RECENT`:

```ts
const HISTORY_TOKEN_BUDGET = 40000;
const estimateTokens = (s) => Math.ceil(s.length / 4);
const historyTokens = (history) => history.reduce((sum, m) =>
    sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);
```

`compactHistory` — replace the early return and the cut computation:

```ts
if (!history || (history.length <= MAX_HISTORY && historyTokens(history) <= HISTORY_TOKEN_BUDGET)) return history;
let cut = Math.max(2, history.length - KEEP_RECENT);
```

(The `Math.max(2, ...)` floor matters: the token path can fire with fewer than `KEEP_RECENT` messages, where the old `history.length - KEEP_RECENT` went negative. With the floor, at least the two oldest messages are summarized and the remainder is kept. The tool-role skip walk after it is unchanged.)

- [ ] **Step 4: Run to verify pass** — `npm test`: 24/24.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts test/compaction.test.js
git commit -m "feat: token-aware compaction trigger"
```
