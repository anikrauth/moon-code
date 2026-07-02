# Turn Cancellation + Raised Step Limit — Design

Date: 2026-07-02
Status: Approved

## Problem

1. No way to stop a running turn: a runaway loop or long command burns tokens and time until it finishes on its own.
2. `stopWhen: stepCountIs(10)` cuts real coding tasks short.

## Design

### 1. Step limit

`const MAX_STEPS = 50;` in `agent.ts`; both `streamText` call sites (main loop is the only one — subagents share `runAgentLoop`) use `stopWhen: stepCountIs(MAX_STEPS)`.

### 2. Abort plumbing (main process)

- `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission, abortSignal?)` — new trailing param.
- `runAgentLoop` gains `abortSignal`, passed to `streamText({ abortSignal })`.
- `makeTools` gains `abortSignal`; `run_command`'s `execAsync(command, { cwd, timeout: 60000, signal: abortSignal })` — abort kills the child process.
- `spawn_agent` passes the same `abortSignal` into the subagent's `makeTools` and `runAgentLoop` — cancel stops subagents too.
- Cancellation surfaces as a rejection out of the stream loop; `handlePrompt`'s catch inspects `abortSignal?.aborted` (or error name `AbortError`) and emits `{ type: 'error', agent: 'main', content: 'Cancelled.' }` then `{ type: 'done' }`. Cancelled turns drop from history (same contract as existing errors).

### 3. main.ts wiring

- Module-scope (inside `whenReady`): `let activeTurn: AbortController | null = null;`
- `agent:prompt`: `activeTurn?.abort(); activeTurn = new AbortController();` pass `activeTurn.signal` as the new `handlePrompt` arg (stale-turn safety; UI already prevents concurrent turns).
- New `ipcMain.on('agent:cancel')`: abort `activeTurn`, then resolve `false` and clear every entry in `pendingPermissions` (a cancelled turn must not leave the agent awaiting a modal).

### 4. Renderer

- `preload.ts`: `cancelPrompt: () => ipcRenderer.send('agent:cancel')`.
- `RichInput`: new props `busy: boolean`, `onStop: () => void`. When `busy`, the send button renders a Stop control (Square icon from lucide-react) that is ALWAYS enabled (ignores `disabled`) and calls `onStop`; otherwise the existing send behavior/gating is unchanged.
- `App.tsx`: passes `busy={isTyping}` and `onStop={() => window.electron?.cancelPrompt()}`. The `done` branch of `onAgentEvent` additionally calls `setPermissionQueue([])` (queue is always empty on normal completion; on cancel it flushes stale modals).

## Error handling

- Abort during a tool's `execAsync`: the child is killed; the tool's own catch turns it into an `Error: ...` tool result; the loop then aborts at the next stream read. Either ordering ends in the Cancelled error + done pair.
- Abort with no active turn: `agent:cancel` is a no-op.
- Permission modal open at cancel time: pending promise resolves `false` in main; renderer queue cleared on the `done` event.

## Testing

`test/cancel.test.js` (fake-SSE harness):

1. **Stream abort:** route holds the response (writes headers + one delta, then stalls); abort the controller after the first `message` event → expect `error` event matching `/Cancel/`, then `done`, within 2s; no unhandled rejection (process exits clean).
2. **Command kill:** first model step calls `run_command` with `sleep 5`; abort 200ms after the `tool_call` event → turn completes in well under 5s; `done` received.
3. **Step limit:** route ALWAYS returns a `run_command('true')` tool call → generation stops by `MAX_STEPS`; assert server received ≤ `MAX_STEPS + 1` requests and a `done` event arrived.
4. Existing 34 tests keep passing.

## Out of scope

- Preserving partial turns in history on cancel.
- Cancelling a single subagent while the parent continues.
- Per-tool timeouts beyond the existing 60s exec timeout.
