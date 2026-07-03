# Slash Commands + Skills Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/` command menu in the input (clear/compact/model/skills/sessions/mcp/settings/help); active skills finally injected into the system prompt (main agent + subagents); `/compact` forces compaction on demand.

**Architecture:** Shared `skillCatalog` module (renderer panel + main injection); `handlePrompt` gains trailing `skillsText`; `compactHistory` gains `force`; `agent:compact` IPC; RichInput autocomplete menu driven by an App-side command registry.

**Tech Stack:** node:test harness; suite currently 70 → 75 after.

## Global Constraints

- `SKILL_CATALOG` moves to `src/shared/skillCatalog.ts` with the spec's 8 entries VERBATIM (ids: code-review, tdd, debugging, refactor, git-flow, docs, planning, concise) — each `{id, name, category, description, instructions}`.
- Skills block format: `ACTIVE SKILLS — follow these working practices:\n\n<Name>:\n<instructions>` joined by `\n\n`; empty string when no active skills; appears in BOTH main and subagent system prompts.
- `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission, abortSignal?, extraTools?, skillsText?)` — 9th trailing param.
- `compactHistory(history, settings, onEvent, abortSignal, force?)`: `force` bypasses the size trigger but still returns unchanged when `history.length <= 2`. Exported `forceCompact(history, settings, onEvent)`.
- `agent:compact` returns `{ok:true, history}` or `{ok:false, error}` — never rejects.
- Command menu: opens when input starts with `/`; prefix filter on the first word; ↑/↓/Enter/Esc; Enter with matches runs selected (arg = text after first space) and clears input; no matches → Enter sends normally.
- `// @ts-nocheck` everywhere touched.

---

### Task 1: shared skill catalog + prompt injection (TDD)

**Files:**
- Create: `src/shared/skillCatalog.ts`
- Modify: `src/main/agent.ts`, `src/main/main.ts`, `src/renderer/SkillsPanel.tsx`, `src/renderer/App.tsx` (import path only)
- Test: `test/skills-prompt.test.js`

**Interfaces:**
- Produces: `SKILL_CATALOG` export (shared); `handlePrompt` 9th param `skillsText`. Task 3 does not consume these directly; main.ts wiring is here.

- [ ] **Step 1: Write failing tests**

```js
// test/skills-prompt.test.js
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
```

- [ ] **Step 2: Run to verify failure** — `npm test`: skillsText param ignored, assertions fail.

- [ ] **Step 3: Create `src/shared/skillCatalog.ts`**

`// @ts-nocheck` header + the spec's `SKILL_CATALOG` array verbatim (all 8 entries with full `instructions` text from the spec document).

- [ ] **Step 4: agent.ts**

- `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission, abortSignal, extraTools, skillsText)`.
- System prompt template: after the projectMemory block insert `${skillsText ? `\n${skillsText}\n` : ''}`.
- `spawnState` gains `skillsText` (`handlePrompt` builds `spawnState: { counter: 0, projectMemory, skillsText: skillsText ?? '' }`); `spawn_agent`'s `subSystemPrompt` gains the same conditional block after its projectMemory section.

- [ ] **Step 5: main.ts**

`import { SKILL_CATALOG } from '../shared/skillCatalog';` — in `agent:prompt`, before `handlePrompt`:

```ts
const activeSkills = configStore.getConfig().activeSkillIds
    .map((sid) => SKILL_CATALOG.find((s) => s.id === sid))
    .filter(Boolean);
const skillsText = activeSkills.length
    ? 'ACTIVE SKILLS — follow these working practices:\n\n' + activeSkills.map((s) => `${s.name}:\n${s.instructions}`).join('\n\n')
    : '';
```

…and pass `skillsText` as the 9th `handlePrompt` arg.

- [ ] **Step 6: Renderer catalog switch**

`SkillsPanel.tsx`: delete the local `SKILL_CATALOG` + `SkillEntry` interface; `import { SKILL_CATALOG } from '../shared/skillCatalog';` (keep `export type SkillEntry = any;`-free — App's `SkillEntry` import switches to a plain `any` usage: change `App.tsx`'s `import SkillsPanel, { SkillEntry } from './SkillsPanel'` and `import { SKILL_CATALOG } from './SkillsPanel'` to import `SKILL_CATALOG` from `'../shared/skillCatalog'` and drop the `SkillEntry` type import — the two handler signatures using `SkillEntry` become `(skill: any)`). Panel UI unchanged (name/description/category all still present).

- [ ] **Step 7: Verify** — `npm test && npx tsc --noEmit && npx vite build` → 72/72 clean.

- [ ] **Step 8: Commit**

```bash
git add src/shared/skillCatalog.ts src/main/agent.ts src/main/main.ts src/renderer/SkillsPanel.tsx src/renderer/App.tsx test/skills-prompt.test.js
git commit -m "feat: wire active skills into agent and subagent system prompts"
```

---

### Task 2: forced compaction (TDD)

**Files:**
- Modify: `src/main/agent.ts`, `src/main/main.ts`, `src/preload/preload.ts`
- Test: `test/force-compact.test.js`

**Interfaces:**
- Produces: exported `forceCompact(history, settings, onEvent)`; IPC `agent:compact(profileId, history) -> {ok, history?|error?}`; preload `compactNow`.

- [ ] **Step 1: Write failing tests**

```js
// test/force-compact.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, baseUrlOf } = require('./helpers/fake-openai');
const { forceCompact } = require('../dist/main/agent.js');

const smallHistory = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));

test('force bypasses the size trigger', async (t) => {
  const server = await startServer((body) => (body.tools ? textChunks('x') : textChunks('FORCED-SUMMARY')));
  t.after(() => server.close());
  const out = await forceCompact(smallHistory(6), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, () => {});
  assert.ok(server.requests.some((b) => !b.tools), 'summarize call fired despite small history');
  assert.match(out[0].content, /^\[Earlier conversation summary\]\nFORCED-SUMMARY/);
  assert.ok(out.length < 6 + 1);
});

test('force with summarize failure falls back without losing history', async (t) => {
  const server = await startServer(() => ({ status: 400 }));
  t.after(() => server.close());
  const out = await forceCompact(smallHistory(6), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, () => {});
  assert.strictEqual(out.length, 6);
});

test('history of 2 or fewer returns unchanged, no request', async (t) => {
  const server = await startServer(() => textChunks('never'));
  t.after(() => server.close());
  const h = smallHistory(2);
  const out = await forceCompact(h, { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, () => {});
  assert.strictEqual(out, h);
  assert.strictEqual(server.requests.length, 0);
});
```

- [ ] **Step 2: Run to verify failure** — `forceCompact is not a function`.

- [ ] **Step 3: agent.ts**

`compactHistory(history, settings, onEvent, abortSignal, force = false)`; early return becomes:

```ts
if (!history || history.length <= 2) return history;
if (!force && history.length <= MAX_HISTORY && historyTokens(history) <= HISTORY_TOKEN_BUDGET) return history;
```

Export:

```ts
export async function forceCompact(history, settings, onEvent) {
    return compactHistory(history, settings, onEvent, undefined, true);
}
```

(`handlePrompt`'s internal call site is unchanged — default `force = false`; the `length <= 2` guard is new but strictly narrower than the old trigger for the non-forced path.)

- [ ] **Step 4: main.ts + preload**

```ts
ipcMain.handle('agent:compact', async (event, profileId: string, history: any) => {
    try {
        const settings = configStore.resolveSettings(profileId);
        if (!settings) return { ok: false, error: 'Selected model profile has no API key.' };
        const compacted = await forceCompact(history ?? [], settings, (e) => event.sender.send('agent:event', e));
        return { ok: true, history: compacted };
    } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
    }
});
```

Import `forceCompact` alongside `handlePrompt`. Preload: `compactNow: (profileId: string, history: any) => ipcRenderer.invoke('agent:compact', profileId, history),`

- [ ] **Step 5: Verify** — `npm test && npx tsc --noEmit` → 75/75 clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent.ts src/main/main.ts src/preload/preload.ts test/force-compact.test.js
git commit -m "feat: on-demand history compaction via agent:compact"
```

---

### Task 3: command menu + registry

**Files:**
- Modify: `src/renderer/RichInput.tsx`, `src/renderer/App.tsx`, `src/renderer/index.css`

**Interfaces:**
- Consumes: preload `compactNow` (Task 2); existing panel/setting setters.
- Produces: RichInput `commands` prop.

- [ ] **Step 1: RichInput menu**

Props gain `commands = []`. Internal:

```tsx
const [cmdIndex, setCmdIndex] = useState(0);
const cmdQuery = value.startsWith('/') ? value.slice(1).split(' ')[0].toLowerCase() : null;
const cmdMatches = cmdQuery !== null ? commands.filter((c) => c.name.startsWith(cmdQuery)) : [];
useEffect(() => { setCmdIndex(0); }, [cmdQuery]);

const runCommand = (cmd) => {
  const sp = value.indexOf(' ');
  const arg = sp >= 0 ? value.slice(sp + 1).trim() || undefined : undefined;
  onChange('');
  cmd.run(arg);
};
```

`handleKeyDown` becomes:

```tsx
const handleKeyDown = (e: React.KeyboardEvent) => {
  if (cmdMatches.length > 0) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % cmdMatches.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length); return; }
    if (e.key === 'Escape') { e.preventDefault(); onChange(''); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCommand(cmdMatches[Math.min(cmdIndex, cmdMatches.length - 1)]); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
};
```

Menu JSX — FIRST child inside the `rich-input-container` div (before the chips row); container needs `position: relative` (add via CSS below):

```tsx
{cmdMatches.length > 0 && (
  <div className="ri-cmd-menu">
    {cmdMatches.map((c, i) => (
      <div
        key={c.name}
        className={`ri-cmd-item ${i === cmdIndex ? 'ri-cmd-active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); runCommand(c); }}
      >
        <span className="ri-cmd-name">/{c.name}</span>
        <span className="ri-cmd-desc">{c.description}</span>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2: CSS**

```css
/* ---- Slash command menu ---- */
.rich-input-container {
  position: relative;
}
.ri-cmd-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  background: var(--panel-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 6px;
  max-height: 260px;
  overflow-y: auto;
  z-index: 50;
}
.ri-cmd-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.ri-cmd-item:hover, .ri-cmd-active {
  background: var(--surface-hover);
}
.ri-cmd-name {
  color: var(--accent-color);
  font-weight: 600;
  white-space: nowrap;
}
.ri-cmd-desc {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

(Note: `.rich-input-container { position: relative; }` is additive — append as a new rule, don't edit the existing block.)

- [ ] **Step 3: App registry**

Helper near the other handlers:

```tsx
const appendLocalNote = (content: string) => {
  setMessages((prev) => [...prev, { id: Date.now().toString(), role: 'assistant', content }]);
};
```

Registry (defined in the component body so closures see fresh state; help built from a base list):

```tsx
const baseCommands = [
  { name: 'clear', description: 'Start a new chat', run: () => startNewChat() },
  { name: 'compact', description: 'Compact conversation history now', run: async () => {
      if (isTyping) return;
      if (!activeProfile?.hasKey) { appendLocalNote('No active model profile with an API key — configure one in Settings.'); return; }
      if (!history || history.length <= 2) { appendLocalNote('Nothing to compact yet.'); return; }
      const before = history.length;
      const res = await window.electron?.compactNow(config.activeProfileId, history);
      if (res?.ok) {
        setHistory(res.history);
        appendLocalNote(`History compacted: ${before} → ${res.history.length} messages.`);
      } else {
        appendLocalNote(`Compaction failed${res?.error ? `: ${res.error}` : '.'}`);
      }
    } },
  { name: 'model', description: 'Switch model profile: /model <name>', run: (arg?: string) => {
      const profiles = config?.profiles ?? [];
      if (arg) {
        const match = profiles.find((p: any) => p.name.toLowerCase().includes(arg.toLowerCase()));
        if (match) {
          window.electron?.setActiveProfile(match.id).then(setConfig);
          appendLocalNote(`Model switched to ${match.name}.`);
          return;
        }
      }
      appendLocalNote(`Profiles: ${profiles.map((p: any) => p.name).join(', ') || '(none configured)'}. Usage: /model <name>.`);
    } },
  { name: 'skills', description: 'Open the skills panel', run: () => setShowSkillsPanel(true) },
  { name: 'sessions', description: 'Open saved sessions', run: async () => {
      const list = await window.electron?.listSessions();
      setSessionList(list ?? []);
      setShowSessionsPanel(true);
    } },
  { name: 'mcp', description: 'Open MCP servers', run: async () => {
      const d = await window.electron?.mcpList?.();
      if (d) setMcpData(d);
      setShowMcpPanel(true);
    } },
  { name: 'settings', description: 'Open settings', run: () => setShowSettings(true) },
];
const slashCommands = [
  ...baseCommands,
  { name: 'help', description: 'List available commands', run: () =>
      appendLocalNote(baseCommands.concat([{ name: 'help', description: 'List available commands' }])
        .map((c: any) => `/${c.name} — ${c.description}`).join('\n')) },
];
```

`<RichInput ... commands={slashCommands} />`.

- [ ] **Step 4: Verify** — `npx tsc --noEmit && npx vite build && npm test` → clean, 75/75. Manual via HMR: type `/` → menu; `/hel` filters; Enter runs /help → local note; `/compact` on a short chat → "Nothing to compact yet."

- [ ] **Step 5: Commit**

```bash
git add src/renderer/RichInput.tsx src/renderer/App.tsx src/renderer/index.css
git commit -m "feat: slash command menu with clear/compact/model/panel commands"
```
