# Conversation History — Design

## Problem

`agent.ts`'s `handlePrompt` calls `generateText` with a single `prompt: prompt` string per user message — no prior turns are ever included. Every message starts with zero memory. Confirmed root cause of an observed bug: asking a follow-up question ("what you found") after a tool ran (`list_dir`) got no answer, because the model had no record of the prior exchange.

## Goals

- Model sees full conversation history (including tool calls/results) on every turn, within the same app session.
- No disk persistence — history lives only while the app is running (matches current behavior of everything except settings).
- Conversation resets when it should (new workspace, explicit "New Chat"), not when it shouldn't (mid-conversation).
- Simple safety valve against unbounded growth given small models (e.g. 8B Llama via Cloudflare) have tight context windows.

## Non-goals

- Real compaction/summarization (deferred — not needed at current scale).
- Disk-backed session persistence / resume across app restarts.
- Multi-workspace concurrent history (single workspace at a time, as today).

## Architecture

One new piece of session state in `App.tsx`: `history`, an opaque blob shaped like the AI SDK's `ResponseMessage[]` (`responseMessages` from `generateText`'s result). It is never rendered — separate from the existing `messages` array used for the chat UI. The renderer treats it as an opaque value: store what the backend returns, forward it unchanged next call.

Per-turn flow:

1. Renderer: `window.electron.sendPrompt(input, workspace, settings, history)` — passes the current blob alongside the new prompt.
2. `preload.ts`: `sendPrompt` forwards the 4th arg through `ipcRenderer.send('agent:prompt', prompt, workspace, settings, history)` unchanged.
3. `main.ts`: `ipcMain.on('agent:prompt', ...)` reads the extra arg, forwards to `handlePrompt(prompt, workspace, settings, history, onEvent)`.
4. `agent.ts`: builds `messages: [...(history ?? []), {role: 'user', content: prompt}]` and calls `generateText({ model, system, messages, tools, stopWhen })`. This replaces the current `prompt:` field — `prompt` and `messages` are mutually exclusive in the AI SDK, so this change is required regardless of history.
5. After `generateText` resolves: `const { text, responseMessages } = result`; `newHistory = [...(history ?? []), userMsg, ...responseMessages]`, trimmed to the last `MAX_HISTORY` (20) entries, oldest dropped first.
6. `onEvent({ type: 'done', history: newHistory })` carries the updated blob back.
7. Renderer's `'done'` handler stores `event.history` into the `history` state, replacing the previous value.

On error (existing `'error'` event path, added in an earlier fix), `history` is left untouched — a failed turn is not remembered by the model. The user sees the error text in chat and can retry from the last known-good context.

## Components (files touched)

- **`src/main/agent.ts`**
  - `handlePrompt` signature: `(prompt, workspace, settings, history, onEvent)`
  - Swap `prompt: prompt` → `messages: [...(history ?? []), {role: 'user', content: prompt}]`
  - Build `newHistory`, trim to `MAX_HISTORY = 20`, include on the `'done'` event
- **`src/preload/preload.ts`**
  - `sendPrompt(prompt, workspace, settings, history)` — 4th arg threaded through `ipcRenderer.send`
- **`src/main/main.ts`**
  - `ipcMain.on('agent:prompt', ...)` reads the extra arg, forwards to `handlePrompt`
- **`src/renderer/App.tsx`**
  - New state: `history` (`useState<any[] | undefined>(undefined)`)
  - `handleSend()` passes `history` into `sendPrompt`
  - `'done'` branch in `onAgentEvent` stores `event.history`
  - `selectWorkspace()` resets both `messages` and `history` when a new folder is picked
  - New "New Chat" button (near workspace/settings controls) resets both, same reset path as workspace-switch

## Error handling

- API/tool errors: existing `'error'` event path unchanged — renders error text, `history` not updated.
- Trimming: pure slice (`newHistory.length > MAX_HISTORY ? newHistory.slice(-MAX_HISTORY) : newHistory`), no edge cases.
- Workspace switch / New Chat: `messages` and `history` always reset together — no partial-state risk.
- First message of a session: `history ?? []` guards `undefined`.

## Testing

No test framework in this project — manual/exploratory verification, consistent with how prior fixes this session were verified:

1. **Multi-turn memory**: repeat the bug scenario — "read the code" → tool runs → "what you found" — confirm the second reply answers from memory instead of re-exploring or going silent.
2. **Workspace switch**: mid-conversation, pick a new folder, confirm chat clears.
3. **New Chat button**: same reset, no folder change involved.
4. **Cap**: temporarily lower `MAX_HISTORY` to 2-3, run several turns, confirm oldest turns drop with no crash or context error.
