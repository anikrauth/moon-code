# Activity Timeline UI + Header Clip Fix — Design

Date: 2026-07-02
Status: Approved

## Problems

1. When chat content overflows, the whole page scrolls and the header slides under the hidden-inset titlebar (half-cut "Moon Agent" title). Cause: the App container is `height: 100%` plus 60px vertical padding under default `box-sizing: content-box`, so it overflows the viewport; `overflow: hidden` is set on `body` but not `html`, so `html` scrolls.
2. Assistant messages render the response bubble first and tool-status pills after it — reverse chronological order. During a long turn the user sees pills but thinks there is no response; after the turn the response floats above the activity that produced it.

## Goal

Claude Code-style activity display: chronological compact tool lines above the response, in-flight spinner, collapsed result summaries expandable on click. Header never scrolls away.

## Design

### 1. Layout fix

- `src/renderer/index.css`: add `html { height: 100%; overflow: hidden; }`.
- `src/renderer/App.tsx`: root App `<div>` style gets `boxSizing: 'border-box'`.
- Result: viewport-locked chrome; only the chat panel (`overflowY: auto`, already present) scrolls.

### 2. `ToolActivity` component (in `App.tsx`)

Renders one tool call event `{name, agent, arguments, result?}`:

- Marker `⏺`: CSS class `activity-marker`; while `!result` add `activity-pending` (pulse animation, defined in index.css); when resolved, solid `var(--accent-color)`.
- `sub-N` badge when `agent && agent !== 'main'` (reuse existing badge style).
- Label: `name(<arg preview>)` — preview extracted from `JSON.parse(arguments)`: `command` for run_command, `filePath` for file tools, `dirPath` for list_dir, `task` for spawn_agent; truncated to 60 chars with `…`. Parse failure → no preview.
- When resolved: dim second row `⎿ <first non-empty line of result, truncated to 80 chars>`. Results beginning `Error:` or equal to the denial/abort strings render the summary in `var(--warning-color)`.
- Click on the line toggles the full result in a `<pre>` (`max-height: 200px`, `overflow: auto`, existing code-block styling). Only rendered when a result exists.

### 3. Assistant message ordering (`App.tsx` message map)

```
<activity block: msg.toolCalls?.map(t => <ToolActivity …/>)>   ← FIRST
<response bubble>                                              ← only when msg.content !== '' or (streaming last message)
```

The bubble keeps `AssistantContent` (spec-render + streaming fallback). No more empty bubble above tools mid-turn. Existing typing/status row at the bottom is unchanged.

### 4. CSS additions (`index.css`)

`.activity-line` (flex row, 13px, pointer cursor when result present), `.activity-marker`, `.activity-pending` keyframe pulse (opacity 0.3↔1, ~1.2s), `.activity-result-summary` (dim, `⎿` prefix), `.activity-result-full` pre block.

## Out of scope

- True text/tool interleaving (segment message model).
- Persisting expanded/collapsed state.
- Changing the permission modal or typing row.

## Testing

No renderer test infra (project convention): `npx tsc --noEmit && npx vite build && npm test` (15/15 main-process tests) + manual drive: restart dev app, send a tool-using prompt, verify chronological order, expand/collapse a result, verify header stays fixed when content overflows.
