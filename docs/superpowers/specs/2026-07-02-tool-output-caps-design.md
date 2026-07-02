# Tool Output Caps + Token-Aware Compaction — Design

Date: 2026-07-02
Status: Approved

## Problem

Tool results flow into model context unbounded: `read_file` returns whole files, `run_command` full stdout, `list_dir` every entry. One large file read can blow a turn's context. History compaction triggers on message count only (`MAX_HISTORY = 20`), so 20 huge messages never compact.

## Goal

Every tool result bounded before it reaches the model or renderer; compaction additionally triggers on estimated token size. No new dependencies.

## Design

All changes in `src/main/agent.ts`. Subagents inherit automatically (same `makeTools`).

### 1. Constants

```ts
const TOOL_OUTPUT_CHAR_LIMIT = 30000;   // run_command combined output
const READ_DEFAULT_LINES = 2000;        // read_file default line window
const READ_CHAR_LIMIT = 50000;          // read_file hard char cap
const LIST_DIR_MAX_ENTRIES = 500;
const HISTORY_TOKEN_BUDGET = 40000;     // estimated tokens before compaction
```

### 2. `truncateOutput(text, limit = TOOL_OUTPUT_CHAR_LIMIT)`

If `text.length <= limit` return unchanged. Otherwise keep the first `floor(limit * 0.8)` chars and the last `floor(limit * 0.1)` chars, joined by `\n[... truncated <N> chars ...]\n` where N = number of chars removed. Applied to `run_command`'s combined stdout/stderr before the success return/emit.

### 3. `read_file` paging

Schema gains optional `offset` (1-based first line, default 1) and `limit` (line count, default `READ_DEFAULT_LINES`), both `z.number().int().min(1).nullable()` with `.describe(...)` explaining paging. Execution:

1. Read file, split on `\n` → `total` lines.
2. Slice `[offset-1, offset-1+limit)`.
3. Join; if joined text exceeds `READ_CHAR_LIMIT`, cut at the limit (whole result, not per line).
4. If the returned window doesn't cover the whole file (sliced or char-cut), append:
   `\n[showing lines <first>–<last> of <total> total — call again with offset/limit for more]`
5. Same string returned to model and emitted to renderer.

Out-of-range offset (`offset-1 >= total`) → `Error: offset <offset> is beyond end of file (<total> lines).`

### 4. `list_dir` cap

More than `LIST_DIR_MAX_ENTRIES` entries → first 500 joined, then `\n[... <N> more entries not shown]`.

### 5. Token-aware compaction trigger

```ts
const estimateTokens = (s) => Math.ceil(s.length / 4);
const historyTokens = (history) => history.reduce((sum, m) =>
    sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);
```

`compactHistory` early-return becomes: proceed when `history.length > MAX_HISTORY || historyTokens(history) > HISTORY_TOKEN_BUDGET`; otherwise return history unchanged. Everything downstream (KEEP_RECENT, status events, transcript char limit, slice fallback) unchanged. Note: the count-based slice fallback stays as-is — acceptable for the failure path.

## Out of scope

- Real tokenizer; per-model budgets.
- Truncating user prompts or assistant text.
- Renderer changes (truncated strings flow through existing events).

## Testing

Extend the fake-SSE harness (node:test):

1. `read_file` on a generated ~5000-line temp file → result ends with the paging marker, contains line 1, not line 3000; `offset/limit` call returns exactly the requested window.
2. `read_file` with out-of-range offset → error string.
3. `run_command` emitting > 30k chars (node -e loop) → result length ≤ limit + marker overhead, contains marker, preserves head start and tail end.
4. Small outputs pass through byte-identical (no marker).
5. Compaction token path: 6 messages (below MAX_HISTORY) with huge content (> 160k chars total) → summarize request fired; small 6-message history → no summarize call.
6. Existing 15 tests keep passing.
