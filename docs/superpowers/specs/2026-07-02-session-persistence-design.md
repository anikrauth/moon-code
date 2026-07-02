# Session Persistence — Design

Date: 2026-07-02
Status: Approved

## Problem

Conversations live only in renderer state; every app restart (or reload) wipes all chats and model history.

## Goal

Every chat is saved automatically and can be reopened from a sessions panel after restart. Multi-session: list, open, delete.

## Architecture

Main process owns storage (same pattern as `configStore`): JSON files under `app.getPath('userData')/sessions/`, exposed over `ipcRenderer.invoke` channels. Renderer snapshots the conversation after each completed turn.

### 1. `src/main/sessionStore.ts`

`createSessionStore({ dir })` (dir = the `sessions/` directory; created on demand) returning:

- `listSessions()` → `[{id, title, workspace, updatedAt}]` sorted by `updatedAt` desc — read from `index.json`.
- `getSession(id)` → full session `{id, title, workspace, createdAt, updatedAt, messages, history}` or `null` (missing/corrupt file).
- `saveSession({id?, title, workspace, messages, history})` → `id`. No id or unknown id → new `s-<randomUUID>` with `createdAt = updatedAt = now`; existing id → overwrite payload fields, preserve `createdAt`, bump `updatedAt`. Writes `<id>.json` and updates `index.json` (insert/replace entry, re-sort desc).
- `deleteSession(id)` → removes `<id>.json` (ignore ENOENT) and its index entry.

Durability rules (match configStore): atomic write = `<file>.tmp` + rename, for both session files and index; corrupt/missing `index.json` → empty list, next save rewrites it; `getSession` on corrupt JSON → `null`, never a throw.

Timestamps: `Date.now()` (ms epoch).

### 2. IPC surface (`main.ts` + `preload.ts`)

| Channel | Payload → Result |
|---|---|
| `sessions:list` | → list array |
| `sessions:get` | `(id)` → full session \| null |
| `sessions:save` | `(snapshot)` → `id` |
| `sessions:delete` | `(id)` → fresh list array |

Handlers wrap store calls in try/catch (`console.error`) and return a safe value (`[]` / `null` / existing id) on failure. Preload: `listSessions()`, `getSession(id)`, `saveSession(snapshot)`, `deleteSession(id)`.

### 3. Renderer

- **State:** `currentSessionId: string | null`, `showSessionsPanel: boolean`.
- **Snapshot on done:** in the `done` branch, when `event.history` exists and there is at least one user message: build `{id: currentSessionId ?? undefined, title, workspace, messages: <the post-update messages array>, history: event.history}` and `saveSession` fire-and-forget, adopting the returned id into `currentSessionId`. `title` = first user message content, trimmed, sliced to 60 chars. (Implementation note: the `done` branch lives outside the `setMessages` updater; read the messages via a ref that tracks the latest messages state to avoid stale closures.)
- **New Chat** (`startNewChat`) and workspace switch: `setCurrentSessionId(null)`.
- **`src/renderer/SessionsPanel.tsx`** (SkillsPanel modal pattern): props `{open, onClose, onSelect(id), onDelete(id), sessions, busy}`. Rows show title, workspace basename, relative updated time ("2h ago" style, coarse); click row → `onSelect`; trash icon → `onDelete` (stops propagation). Empty state text. Rows inert while `busy`.
- **App wiring:** History (lucide `History` icon) button in the header opens the panel and refreshes the list via `listSessions`. `onSelect`: `getSession(id)` → set `workspace`, `messages`, `history`, `currentSessionId`, close panel. `onDelete`: `deleteSession(id)` → replace list; if it was `currentSessionId`, keep chat on screen but null the id (next turn saves as a new session). Panel unusable while `isTyping` (`busy`).

### 4. Data notes

- `messages` persist exactly as rendered (including `toolCalls` with capped results) — reopening a session restores the full activity timeline.
- `history` persists the model messages verbatim; next turn compaction applies as usual.
- Sessions are per-snapshot overwrites — no incremental append; a crashed/cancelled turn simply isn't saved (last completed turn wins).
- Reopened sessions continue under the currently active model profile; the originating profile is not stored.

## Error handling

- Store failures never break a turn: save is fire-and-forget after `done`.
- Deleting the open session: UI keeps the transcript, id nulled.
- Loading a session whose workspace no longer exists: workspace is set anyway; first tool call fails with a normal tool error (acceptable; user can re-pick workspace).

## Testing

`test/session-store.test.js` (node:test, temp dir per test, `t.after` cleanup, real compiled `dist/main/sessionStore.js`):

1. Save without id → new id returned; list has one entry with right title/workspace; file exists.
2. Save with same id → `createdAt` preserved, `updatedAt` bumped, index re-sorted (older second session drops below).
3. `getSession` round-trips `messages`/`history` deep-equal.
4. `getSession('missing')` → null; corrupt `<id>.json` → null, no throw.
5. Corrupt `index.json` → `listSessions()` `[]`; subsequent save rewrites a valid index.
6. `deleteSession` removes file + index entry; deleting unknown id is a no-op.

Renderer/IPC: `npx tsc --noEmit && npx vite build` + existing 38 tests unaffected.

## Out of scope

- Auto-restore on launch; session search/rename/export; per-workspace filtering; capping stored session count; migrating in-flight (pre-feature) conversations.
