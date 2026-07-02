# Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat auto-saves after each completed turn; sessions panel lists, reopens, and deletes them across app restarts.

**Architecture:** `sessionStore` in main (configStore pattern: JSON under `userData/sessions/`, `index.json` list, atomic writes) + 4 invoke channels + renderer snapshot-on-done and a `SessionsPanel` modal.

**Tech Stack:** node:test (store unit tests, temp dirs); `npm test` currently 38 passing. Renderer verified by `tsc + vite build` (project convention).

## Global Constraints

- Session id format `s-<randomUUID>`; index entries `{id, title, workspace, updatedAt}` sorted `updatedAt` desc.
- `saveSession` with unknown/absent id creates; known id preserves `createdAt`, bumps `updatedAt`.
- Corrupt/missing index → `[]`; corrupt/missing session file → `null`; never throw. Atomic write = tmp + rename.
- Snapshot save is fire-and-forget after `done`; failures never break a turn.
- The `done` handler lives outside React state closures — snapshot data MUST come from a ref (`sessionSnapshotRef`), not from captured state.
- Title = first user message content, trimmed, sliced to 60 chars. Save only when a user message and a workspace exist.
- `// @ts-nocheck` kept in all touched source files.

---

### Task 1: `sessionStore` module + unit tests (TDD)

**Files:**
- Create: `src/main/sessionStore.ts`
- Test: `test/session-store.test.js`

**Interfaces:**
- Produces: `createSessionStore({ dir })` → `{ listSessions(), getSession(id), saveSession(snapshot) -> id, deleteSession(id) }`. Task 2 consumes these names exactly.

- [ ] **Step 1: Write failing tests**

```js
// test/session-store.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setTimeout: delay } = require('node:timers/promises');
const { createSessionStore } = require('../dist/main/sessionStore.js');

const tmpDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-sess-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'sessions');
};

const snap = (over = {}) => ({
  title: 'first prompt', workspace: '/tmp/ws',
  messages: [{ id: '1', role: 'user', content: 'first prompt' }],
  history: [{ role: 'user', content: 'first prompt' }],
  ...over,
});

test('save without id creates session, file, and index entry', (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const id = s.saveSession(snap());
  assert.match(id, /^s-/);
  const list = s.listSessions();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, id);
  assert.strictEqual(list[0].title, 'first prompt');
  assert.strictEqual(list[0].workspace, '/tmp/ws');
});

test('update preserves createdAt, bumps updatedAt, re-sorts index', async (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const a = s.saveSession(snap({ title: 'A' }));
  await delay(5);
  const b = s.saveSession(snap({ title: 'B' }));
  const createdA = s.getSession(a).createdAt;
  await delay(5);
  assert.strictEqual(s.saveSession(snap({ id: a, title: 'A2' })), a);
  const after = s.getSession(a);
  assert.strictEqual(after.createdAt, createdA);
  assert.ok(after.updatedAt > createdA);
  const list = s.listSessions();
  assert.deepStrictEqual(list.map((e) => e.id), [a, b]);
  assert.strictEqual(list[0].title, 'A2');
});

test('getSession round-trips messages and history', (t) => {
  const s = createSessionStore({ dir: tmpDir(t) });
  const payload = snap({
    messages: [{ id: '1', role: 'user', content: 'hi' }, { id: '2', role: 'assistant', content: 'yo', toolCalls: [{ name: 'run_command', agent: 'main', arguments: '{"command":"ls"}', result: 'a.txt' }] }],
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
  });
  const id = s.saveSession(payload);
  const got = s.getSession(id);
  assert.deepStrictEqual(got.messages, payload.messages);
  assert.deepStrictEqual(got.history, payload.history);
});

test('missing or corrupt session file yields null', (t) => {
  const dir = tmpDir(t);
  const s = createSessionStore({ dir });
  assert.strictEqual(s.getSession('s-nope'), null);
  const id = s.saveSession(snap());
  fs.writeFileSync(path.join(dir, `${id}.json`), '{broken');
  assert.strictEqual(s.getSession(id), null);
});

test('corrupt index yields empty list; next save repairs it', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), 'not json');
  const s = createSessionStore({ dir });
  assert.deepStrictEqual(s.listSessions(), []);
  const id = s.saveSession(snap());
  assert.strictEqual(s.listSessions()[0].id, id);
});

test('delete removes file and index entry; unknown id is a no-op', (t) => {
  const dir = tmpDir(t);
  const s = createSessionStore({ dir });
  const id = s.saveSession(snap());
  s.deleteSession('s-unknown');
  assert.strictEqual(s.listSessions().length, 1);
  s.deleteSession(id);
  assert.deepStrictEqual(s.listSessions(), []);
  assert.ok(!fs.existsSync(path.join(dir, `${id}.json`)));
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`: new tests FAIL (`Cannot find module '../dist/main/sessionStore.js'`).

- [ ] **Step 3: Implement `src/main/sessionStore.ts`**

```ts
// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export function createSessionStore({ dir }) {
    const indexFile = path.join(dir, 'index.json');

    function atomicWrite(file, data) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }

    function readIndex() {
        try {
            const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function writeIndex(entries) {
        entries.sort((a, b) => b.updatedAt - a.updatedAt);
        atomicWrite(indexFile, entries);
    }

    function getSessionById(id) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
            return parsed && parsed.id === id ? parsed : null;
        } catch {
            return null;
        }
    }

    return {
        listSessions: () => readIndex(),

        getSession: (id) => getSessionById(id),

        saveSession({ id, title, workspace, messages, history }) {
            const now = Date.now();
            const existing = id ? getSessionById(id) : null;
            const sessionId = existing ? existing.id : `s-${randomUUID()}`;
            const session = {
                id: sessionId,
                title,
                workspace,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
                messages,
                history,
            };
            atomicWrite(path.join(dir, `${sessionId}.json`), session);
            const index = readIndex().filter((e) => e.id !== sessionId);
            index.push({ id: sessionId, title, workspace, updatedAt: now });
            writeIndex(index);
            return sessionId;
        },

        deleteSession(id) {
            try {
                fs.unlinkSync(path.join(dir, `${id}.json`));
            } catch {
                // already gone
            }
            writeIndex(readIndex().filter((e) => e.id !== id));
        },
    };
}
```

- [ ] **Step 4: Run to verify pass** — `npm test`: 44/44 (38 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/sessionStore.ts test/session-store.test.js
git commit -m "feat: session store with atomic JSON persistence"
```

---

### Task 2: IPC surface

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/preload/preload.ts`

**Interfaces:**
- Consumes: `createSessionStore` (Task 1).
- Produces: `window.electron.listSessions/getSession/saveSession/deleteSession`. Task 3 consumes these.

- [ ] **Step 1: main.ts handlers**

Inside `whenReady`, after the config handlers:

```ts
const sessionStore = createSessionStore({ dir: path.join(app.getPath('userData'), 'sessions') });
ipcMain.handle('sessions:list', () => {
    try { return sessionStore.listSessions(); } catch (e) { console.error('[sessions]', e); return []; }
});
ipcMain.handle('sessions:get', (_event, id: string) => {
    try { return sessionStore.getSession(id); } catch (e) { console.error('[sessions]', e); return null; }
});
ipcMain.handle('sessions:save', (_event, snapshot: any) => {
    try { return sessionStore.saveSession(snapshot); } catch (e) { console.error('[sessions]', e); return snapshot?.id ?? null; }
});
ipcMain.handle('sessions:delete', (_event, id: string) => {
    try { sessionStore.deleteSession(id); } catch (e) { console.error('[sessions]', e); }
    return sessionStore.listSessions();
});
```

Import: `import { createSessionStore } from './sessionStore';` (`path` is already imported).

- [ ] **Step 2: preload**

```ts
listSessions: () => ipcRenderer.invoke('sessions:list'),
getSession: (id: string) => ipcRenderer.invoke('sessions:get', id),
saveSession: (snapshot: any) => ipcRenderer.invoke('sessions:save', snapshot),
deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
```

- [ ] **Step 3: Verify** — `npm test && npx tsc --noEmit` → 44/44, clean.

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts src/preload/preload.ts
git commit -m "feat: sessions IPC surface"
```

---

### Task 3: Renderer — snapshot-on-done, SessionsPanel, wiring

**Files:**
- Create: `src/renderer/SessionsPanel.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/index.css`

**Interfaces:**
- Consumes: preload API (Task 2); existing modal CSS classes (`modal-overlay`, `skills-panel`, `sp-*`).
- Produces: UI only.

- [ ] **Step 1: SessionsPanel component**

```tsx
// @ts-nocheck
import React from 'react';
import { X, History, Trash2, MessageSquare } from 'lucide-react';

function relativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SessionsPanel({ open, onClose, sessions, onSelect, onDelete, busy }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skills-panel glass-panel">
        <div className="sp-header">
          <div className="sp-header-title">
            <History size={18} />
            <h3>Sessions</h3>
          </div>
          <button className="sp-close" onClick={onClose} aria-label="Close sessions panel">
            <X size={16} />
          </button>
        </div>
        <div className="sp-catalog">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`sp-skill-row session-row ${busy ? 'session-row-busy' : ''}`}
              onClick={() => !busy && onSelect(s.id)}
            >
              <div className="sp-skill-info">
                <MessageSquare size={14} className="sp-skill-icon" />
                <div>
                  <span className="sp-skill-name">{s.title || 'Untitled chat'}</span>
                  <span className="sp-skill-desc">{s.workspace?.split('/').pop()} · {relativeTime(s.updatedAt)}</span>
                </div>
              </div>
              <button
                className="sp-close"
                aria-label={`Delete ${s.title || 'session'}`}
                onClick={(e) => { e.stopPropagation(); if (!busy) onDelete(s.id); }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {sessions.length === 0 && <div className="sp-empty">No saved sessions yet.</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS**

Append to `index.css`:

```css
/* ---- Sessions panel ---- */
.session-row {
  cursor: pointer;
}
.session-row-busy {
  opacity: 0.5;
  pointer-events: none;
}
```

- [ ] **Step 3: App.tsx state + snapshot ref**

Imports: add `History` to lucide import; `import SessionsPanel from './SessionsPanel';`.

State (near other panel state):

```tsx
const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
const [sessionList, setSessionList] = useState<any[]>([]);
const [showSessionsPanel, setShowSessionsPanel] = useState(false);
```

Snapshot ref (the done handler runs in a once-registered listener — captured state would be stale):

```tsx
const sessionSnapshotRef = useRef<any>({ messages: [], workspace: null, sessionId: null });
useEffect(() => {
  sessionSnapshotRef.current = { messages, workspace, sessionId: currentSessionId };
}, [messages, workspace, currentSessionId]);
```

(Note: `done` arrives as its own IPC task after the message-event state updates have flushed, so the ref is current by the time it fires.)

- [ ] **Step 4: App.tsx — save on done**

In the `done` branch, replace `if (event.history) setHistory(event.history);` with:

```tsx
if (event.history) {
  setHistory(event.history);
  const snap = sessionSnapshotRef.current;
  const firstUser = snap.messages.find((m: any) => m.role === 'user');
  if (firstUser && snap.workspace) {
    window.electron?.saveSession({
      id: snap.sessionId ?? undefined,
      title: firstUser.content.trim().slice(0, 60),
      workspace: snap.workspace,
      messages: snap.messages,
      history: event.history,
    }).then((id: string) => { if (id) setCurrentSessionId(id); });
  }
}
```

- [ ] **Step 5: App.tsx — new chat, header button, handlers, panel**

`startNewChat` gains `setCurrentSessionId(null);`.

Header (immediately before the New Chat button):

```tsx
<button
  onClick={async () => {
    const list = await window.electron?.listSessions();
    setSessionList(list ?? []);
    setShowSessionsPanel(true);
  }}
  className="glass-panel"
  style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', color: 'var(--text-primary)', cursor: 'pointer' }}
  title="Sessions"
>
  <History size={16} />
</button>
```

Handlers (near the skills handlers):

```tsx
const handleSelectSession = async (id: string) => {
  const s = await window.electron?.getSession(id);
  if (!s) return;
  setWorkspace(s.workspace);
  setMessages(s.messages ?? []);
  setHistory(s.history ?? undefined);
  setCurrentSessionId(s.id);
  setShowSessionsPanel(false);
};

const handleDeleteSession = async (id: string) => {
  const list = await window.electron?.deleteSession(id);
  setSessionList(list ?? []);
  if (id === currentSessionId) setCurrentSessionId(null);
};
```

Panel element (next to the other panels):

```tsx
<SessionsPanel
  open={showSessionsPanel}
  onClose={() => setShowSessionsPanel(false)}
  sessions={sessionList}
  onSelect={handleSelectSession}
  onDelete={handleDeleteSession}
  busy={isTyping}
/>
```

- [ ] **Step 6: Verify** — `npx tsc --noEmit && npx vite build && npm test` → clean, 44/44.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/SessionsPanel.tsx src/renderer/App.tsx src/renderer/index.css
git commit -m "feat: sessions panel with snapshot-on-done persistence"
```
