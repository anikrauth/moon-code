# Conversation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model real conversation memory across messages within a session, fixing the confirmed bug where follow-up questions get no answer because each prompt was sent with zero prior context.

**Architecture:** Renderer (`App.tsx`) owns an opaque `history` blob (`ResponseMessage[]` from the AI SDK's `generateText` result) alongside its existing display `messages` array. It's threaded through IPC (`preload.ts` → `main.ts` → `agent.ts`) each turn, updated from the `'done'` event, and reset on workspace switch or a new "New Chat" button.

**Tech Stack:** Electron + React (renderer, `// @ts-nocheck`), Node/TypeScript main process (`// @ts-nocheck` on `main.ts`/`agent.ts`), `ai` SDK v7 (`generateText`, `stepCountIs`), `@ai-sdk/openai` v4.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-conversation-history-design.md` — read before starting.
- No disk persistence — history lives only in renderer memory for the running session.
- `MAX_HISTORY = 20` — hard cap on stored message count, oldest dropped first, trimmed in `agent.ts`.
- No test framework exists in this project (confirmed: no `test` script in `package.json`, no jest/vitest/mocha dependency). Verification is: (a) `npx tsc --noEmit` after each step as a syntax sanity check (note: `agent.ts`, `main.ts`, and `App.tsx` all have `// @ts-nocheck`, so this only catches parse errors in those three, not type errors — `preload.ts` is the one file where `tsc` does real type-checking), and (b) manual end-to-end verification in the running Electron app in the final task.
- `agent.ts`'s `generateText` result field for accumulated messages is `responseMessages` (NOT `response.messages` — `response` is deprecated call metadata in this SDK version). This was confirmed against `node_modules/ai/dist/index.d.ts` during spec review — don't re-derive it, use it directly.
- Main-process files (`agent.ts`, `main.ts`, `preload.ts`) require a full app restart to pick up changes — Vite HMR only covers the renderer (`App.tsx`). Each backend task ends with a restart-and-smoke-test step for this reason.

---

### Task 1: `agent.ts` — accept and return conversation history

**Files:**
- Modify: `src/main/agent.ts:17` (function signature), `:107-116` (generateText call + done event)

**Interfaces:**
- Consumes: nothing new from other tasks (this is the first task)
- Produces: `handlePrompt(prompt: string, workspace: string, settings: any, history: any[] | undefined, onEvent: (event: any) => void)` — 4th positional param is `history`, inserted before `onEvent`. `onEvent({type: 'done', history: <array>})` now carries the updated blob. Later tasks (`main.ts`, `preload.ts`, `App.tsx`) must match this exact parameter order and the `event.history` field name on `'done'`.

- [ ] **Step 1: Add the `MAX_HISTORY` constant and update the function signature**

In `src/main/agent.ts`, change line 17 from:

```typescript
export async function handlePrompt(prompt: string, workspace: string, settings: any, onEvent: (event: any) => void) {
```

to:

```typescript
const MAX_HISTORY = 20;

export async function handlePrompt(prompt: string, workspace: string, settings: any, history: any[] | undefined, onEvent: (event: any) => void) {
```

- [ ] **Step 2: Replace the `generateText` call and the success-path event emission**

Change lines 107-116 from:

```typescript
        const { text } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: `You are Moon Agent, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely.`,
            prompt: prompt,
            tools: tools,
            stopWhen: stepCountIs(10),
        });

        onEvent({ type: 'message', content: text });
        onEvent({ type: 'done' });
```

to:

```typescript
        const userMsg = { role: 'user', content: prompt };
        const { text, responseMessages } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: `You are Moon Agent, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely.`,
            messages: [...(history ?? []), userMsg],
            tools: tools,
            stopWhen: stepCountIs(10),
        });

        let newHistory = [...(history ?? []), userMsg, ...responseMessages];
        if (newHistory.length > MAX_HISTORY) {
            newHistory = newHistory.slice(-MAX_HISTORY);
        }

        onEvent({ type: 'message', content: text });
        onEvent({ type: 'done', history: newHistory });
```

Note: the `catch` block below (currently `onEvent({ type: 'error', ... }); onEvent({ type: 'done' });`) is unchanged — on error, `'done'` fires with no `history` field, so the caller's history stays whatever it already was (per spec: failed turns aren't remembered).

- [ ] **Step 3: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). This file has `// @ts-nocheck` so it won't catch type mismatches, only parse errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/agent.ts
git commit -m "feat: thread conversation history through handlePrompt"
```

(Skip this step if the project isn't a git repo — confirm with `git status` first; if it errors with "not a git repository", just move to Task 2.)

---

### Task 2: `preload.ts` — thread `history` through the IPC bridge

**Files:**
- Modify: `src/preload/preload.ts:5`

**Interfaces:**
- Consumes: nothing (this task only forwards an opaque value)
- Produces: `window.electron.sendPrompt(prompt: string, workspace: string, settings: any, history: any[] | undefined)` — 4th param added. `App.tsx` (Task 4) must call it with this exact signature.

- [ ] **Step 1: Add the `history` parameter**

Change line 5 from:

```typescript
  sendPrompt: (prompt: string, workspace: string, settings: any) => ipcRenderer.send('agent:prompt', prompt, workspace, settings),
```

to:

```typescript
  sendPrompt: (prompt: string, workspace: string, settings: any, history: any) => ipcRenderer.send('agent:prompt', prompt, workspace, settings, history),
```

- [ ] **Step 2: Typecheck (this file has no `// @ts-nocheck`, so this is a real check)**

Run: `npx tsc --noEmit`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat: thread history param through preload sendPrompt bridge"
```

(Skip if not a git repo, same as Task 1.)

---

### Task 3: `main.ts` — forward `history` to `handlePrompt`

**Files:**
- Modify: `src/main/main.ts:46-51`

**Interfaces:**
- Consumes: `handlePrompt(prompt, workspace, settings, history, onEvent)` from Task 1 — must match positional order exactly.
- Produces: nothing new for later tasks — this is pure plumbing between Task 1 and Task 4.

- [ ] **Step 1: Read the extra IPC argument and pass it through**

Change lines 46-51 from:

```typescript
  ipcMain.on('agent:prompt', (event, prompt: string, workspace: string, settings: any) => {
    // Call the agent loop and stream results back
    handlePrompt(prompt, workspace, settings, (agentEvent) => {
      event.reply('agent:event', agentEvent);
    });
  });
```

to:

```typescript
  ipcMain.on('agent:prompt', (event, prompt: string, workspace: string, settings: any, history: any) => {
    // Call the agent loop and stream results back
    handlePrompt(prompt, workspace, settings, history, (agentEvent) => {
      event.reply('agent:event', agentEvent);
    });
  });
```

- [ ] **Step 2: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). This file has `// @ts-nocheck`, so this only catches parse errors.

- [ ] **Step 3: Restart the dev app and smoke-test the plumbing**

Main-process files don't hot-reload. Restart:

```bash
pkill -9 -f "moon-agent/node_modules/electron/dist/Electron.app" 2>/dev/null
pkill -9 -f "moon-agent/node_modules/.bin/vite" 2>/dev/null
sleep 1
nohup npm run dev > /tmp/moon-agent-dev.log 2>&1 &
disown
sleep 8
tail -n 25 /tmp/moon-agent-dev.log
```

Expected: log shows `VITE ... ready` and no thrown errors; a new Electron window opens. Send one message ("hi") in the app with a workspace + valid API settings configured — it should still get a normal single-turn reply (history is `undefined` on the first message, so behavior is unchanged so far — `App.tsx` hasn't been wired to send/store it yet).

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: forward history argument from IPC to handlePrompt"
```

(Skip if not a git repo.)

---

### Task 4: `App.tsx` — track, send, and reset conversation history

**Files:**
- Modify: `src/renderer/App.tsx:3` (icon import), `:22-31` (state), `:76-82` (done handler), `:84-88` (selectWorkspace), `:90-99` (handleSend), `:269-286` (header buttons)

**Interfaces:**
- Consumes: `window.electron.sendPrompt(prompt, workspace, settings, history)` from Task 2; `event.history` on the `'done'` event from Task 1.
- Produces: nothing consumed by later tasks (this is the last code task).

- [ ] **Step 1: Add a `Plus` icon import for the New Chat button**

Change line 3 from:

```typescript
import { FolderOpen, Terminal, FileEdit, Settings, Bot, X } from 'lucide-react';
```

to:

```typescript
import { FolderOpen, Terminal, FileEdit, Settings, Bot, X, Plus } from 'lucide-react';
```

- [ ] **Step 2: Add `history` state**

Change lines 22-31 from:

```typescript
export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('moon-agent-settings');
    return saved ? JSON.parse(saved) : { provider: 'OpenAI', apiKey: '', model: 'gpt-4o', baseUrl: '' };
  });
```

to:

```typescript
export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<any[] | undefined>(undefined);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('moon-agent-settings');
    return saved ? JSON.parse(saved) : { provider: 'OpenAI', apiKey: '', model: 'gpt-4o', baseUrl: '' };
  });
```

- [ ] **Step 3: Store `event.history` on the `'done'` event**

Change lines 76-78 from:

```typescript
        } else if (event.type === 'done') {
            setIsTyping(false);
        }
```

to:

```typescript
        } else if (event.type === 'done') {
            setIsTyping(false);
            if (event.history) setHistory(event.history);
        }
```

- [ ] **Step 4: Reset history (and messages) when switching workspace**

Change lines 84-88 from:

```typescript
  const selectWorkspace = async () => {
    if (!window.electron?.selectFolder) return;
    const path = await window.electron.selectFolder();
    if (path) setWorkspace(path);
  };
```

to:

```typescript
  const startNewChat = () => {
    setMessages([]);
    setHistory(undefined);
  };

  const selectWorkspace = async () => {
    if (!window.electron?.selectFolder) return;
    const path = await window.electron.selectFolder();
    if (path) {
      setWorkspace(path);
      startNewChat();
    }
  };
```

- [ ] **Step 5: Pass `history` into `sendPrompt`**

Change line 98 from:

```typescript
    window.electron?.sendPrompt(input, workspace, settings);
```

to:

```typescript
    window.electron?.sendPrompt(input, workspace, settings, history);
```

- [ ] **Step 6: Add a "New Chat" button in the header**

Change lines 269-286 from:

```typescript
        <div style={{ display: 'flex', gap: '10px' }}>
            <button 
            onClick={selectWorkspace}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '14px' }}
            >
            <FolderOpen size={16} />
            {workspace ? workspace.split('/').pop() : 'Select Workspace'}
            </button>

            <button 
            onClick={() => setShowSettings(true)}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
            <Settings size={16} />
            </button>
        </div>
```

to:

```typescript
        <div style={{ display: 'flex', gap: '10px' }}>
            <button 
            onClick={selectWorkspace}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '14px' }}
            >
            <FolderOpen size={16} />
            {workspace ? workspace.split('/').pop() : 'Select Workspace'}
            </button>

            <button 
            onClick={startNewChat}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
            title="New Chat"
            >
            <Plus size={16} />
            </button>

            <button 
            onClick={() => setShowSettings(true)}
            className="glass-panel"
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
            >
            <Settings size={16} />
            </button>
        </div>
```

- [ ] **Step 7: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). This file has `// @ts-nocheck`, so this only catches parse errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: track and send conversation history, add New Chat button"
```

(Skip if not a git repo.)

---

### Task 5: End-to-end verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: the fully wired app from Tasks 1-4.
- Produces: nothing (terminal task).

- [ ] **Step 1: Restart the dev app clean**

```bash
pkill -9 -f "moon-agent/node_modules/electron/dist/Electron.app" 2>/dev/null
pkill -9 -f "moon-agent/node_modules/.bin/vite" 2>/dev/null
sleep 1
nohup npm run dev > /tmp/moon-agent-dev.log 2>&1 &
disown
sleep 8
tail -n 25 /tmp/moon-agent-dev.log
```

Expected: `VITE ... ready`, no errors, one Electron window opens.

- [ ] **Step 2: Verify multi-turn memory (the original bug scenario)**

In the app: select a workspace, configure valid model settings, send a message that triggers a tool call (e.g. "list the files here" or "read the code"), wait for it to finish, then send a follow-up that only makes sense with memory of the first exchange (e.g. "what did you find?" or "summarize that").

Expected: the second reply references the actual tool output from the first turn, instead of re-running the same tool from scratch or returning nothing.

- [ ] **Step 3: Verify workspace-switch reset**

Mid-conversation (chat has messages in it), click "Select Workspace" and pick a different folder.

Expected: the chat area clears back to empty immediately.

- [ ] **Step 4: Verify the New Chat button**

Without switching workspace, send a message so the chat has content, then click the new "+" button in the header.

Expected: chat area clears, next message sent has no memory of the pre-clear conversation (e.g. ask "what did we just talk about?" — model should not know).

- [ ] **Step 5: Verify the history cap**

Temporarily edit `src/main/agent.ts`'s `MAX_HISTORY` constant from `20` to `2`, restart the app (main-process file, needs restart — same restart command as Step 1), and send 4-5 back-to-back messages in one conversation.

Expected: no crash, no context-length error from the model provider — confirms trimming works. Then revert `MAX_HISTORY` back to `20` and restart once more.

```bash
git diff src/main/agent.ts
```

Expected after revert: no diff (file matches Task 1's committed state).
