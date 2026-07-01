# Subagents + History Compaction — Design

Date: 2026-07-02
Status: Approved (roadmap item 6)

## Goal

Let the main agent delegate scoped tasks to parallel subagents, and stop silently losing context by replacing the hard 20-message history slice with LLM-summarized compaction.

## Architecture

In-process: everything lives in `src/main/agent.ts`. No new processes, no new IPC channels. The existing `agent:event` renderer channel and `agent:permission-response` gate are reused.

### 1. Shared loop: `runAgentLoop`

Extract the current `handlePrompt` body into:

```ts
runAgentLoop({
  prompt, workspace, settings, history,
  onEvent, requestPermission,
  agentId,        // 'main' or 'sub-N'
  tools,          // toolset for this loop
  systemPrompt,   // caller-supplied
}) -> Promise<{ text, responseMessages }>
```

- Streams via `streamText`, `stopWhen: stepCountIs(10)`.
- Emits `message` (text deltas), `tool_call`, `tool_result` events — every event carries an `agent` field.
- Subagent loops suppress `message` delta events (only the main agent's text streams into the chat bubble); their activity is visible through tool rows and their final text returns to the parent as a tool result.
- `handlePrompt` becomes a thin wrapper: compaction, main toolset, UI-spec system prompt, history management, `done`/`error` events.

### 2. `spawn_agent` tool

Available to the main agent only.

- Schema: `{ task: string }` — a self-contained task description.
- Runs `runAgentLoop` with:
  - fresh empty history;
  - toolset = all tools minus `spawn_agent` (no recursion);
  - system prompt: coding subagent for workspace, MOON.md project instructions included, "Complete the task, then reply with concise plain-text findings" — no UI-spec JSONL;
  - `agentId: 'sub-N'` (per-turn counter).
- Returns the subagent's final text as the tool result.
- Parallelism: when the model emits several `spawn_agent` calls in one assistant step, the AI SDK runs their `execute` callbacks concurrently — no extra scheduling code.
- Subagent errors are caught and returned as `Error: <message>` tool results; they never kill the parent turn.

### 3. Events & renderer

- All agent events gain `agent: string`.
- `App.tsx` tool rows render a badge when `event.agent !== 'main'` (e.g. `sub-1 · run_command`).
- `tool_result` attachment matches on `(name, agent, pending)` instead of `(name, pending)` to prevent cross-attribution between concurrent agents.
- New `status` event type: renderer shows its text in the existing "Agent is thinking…" row (used by compaction).

### 4. Permissions

- Subagent tools call the same `requestPermission` — the gate cannot be bypassed by delegation.
- Session "always allow" is keyed by tool name only, so an approval covers main and subagents alike.
- The permission modal shows the requesting agent's badge. Concurrent requests queue (renderer already queues).

### 5. Compaction

In `handlePrompt`, before building the model messages:

- Trigger: `history.length > 20` (MAX_HISTORY).
- Split: `old` = everything except the last 8 messages; boundary advanced past `tool`-role messages so no orphaned tool results (reuse existing skip loop).
- One `generateText` call (same model/settings): "Summarize this conversation compactly. Preserve file paths, decisions made, code changes, and unresolved tasks."
- Replace `old` with a single user-role message: `[Earlier conversation summary]\n<summary>`.
- Emit `{ type: 'status', agent: 'main', content: 'Compacting history…' }` before the call.
- On any failure: fall back to the current slice-at-20 behavior. Compaction must never fail a turn.
- The compacted history is what gets persisted via the `done` event, so compaction runs at most once per crossing, not per turn.

## Error handling

- Subagent failure → error string tool result to parent; parent decides how to proceed.
- Compaction failure → silent fallback to slice.
- Permission denial inside a subagent behaves exactly as in the main agent (denial text returned to the subagent's model loop).

## Testing

Extend the fake-OpenAI-SSE-server harness (`scratch-e2e` pattern, real compiled `handlePrompt`):

1. **Parallel subagents:** parent step emits two `spawn_agent` calls → each subagent runs one gated tool → assert: both permission calls observed, event `agent` tags correct (`sub-1`, `sub-2`), executions overlap in time, parent receives both results, final answer streams.
2. **No recursion:** subagent request body contains no `spawn_agent` tool definition.
3. **Compaction:** seed 25-message history → assert summarize request issued, next model request's messages = summary message + recent tail, and `done` history is the compacted one.
4. **Compaction fallback:** summarize call fails → turn still completes with sliced history.

## Out of scope

- Process isolation per subagent (utilityProcess).
- Subagent UI tabs/sessions.
- Nested subagents (recursion).
- Token-based (rather than message-count) compaction triggers.
