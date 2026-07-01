# Structured Assistant Message Rendering (json-render) — Design

## Problem

Assistant replies containing tabular data, code, or lists render as raw markdown-ish text (`{msg.content}` is a plain string, no parsing) — pipe characters, asterisks, and backticks show up literally instead of as a table, bold text, or a code block. Example observed: a file-listing reply rendered as a wall of `| Type | Name | Modified |` pipe text instead of a real table.

## Approach chosen: json-render (Vercel's generative-UI framework)

Considered and rejected first: `react-markdown` + `remark-gfm` + `rehype-highlight` — lower risk (renders what the model already naturally produces, no prompt changes), but explicitly passed over in favor of `json-render` per user direction, accepting the tradeoff below.

**Known risk, accepted deliberately:** `json-render` has no official Vercel AI SDK adapter (`@json-render/ai-sdk` does not exist on npm, despite being listed on the marketing site). The real mechanism is prompt-based: `catalog.prompt()` generates a system-prompt description of the schema, and the model is expected to emit JSONL RFC 6902 patches as its raw text output — this is prompt-following, not schema-enforced structured output. For a small model (`@cf/meta/llama-3-8b-instruct` via Cloudflare, the model in active testing), this is meaningfully less reliable than markdown, which every instruct model is heavily trained on. Mitigation: parsing is wrapped in a fallback that renders plain text on any failure — the UI never breaks, it just occasionally looks like it does today.

## Goals

- Tabular data, code, and lists in assistant replies render as real UI elements.
- No change to the tool-calling loop, conversation history, or history trimming (all already shipped and reviewed).
- Never a blank or broken message — malformed model output falls back to today's plain-text rendering.

## Non-goals

- Interactive components (buttons, forms, actions) — this is read-only display rendering, not a form builder.
- Real-time streaming JSONL patch application (`SpecStream` incremental push) — `generateText` returns one final string, not token deltas, so the full JSONL is parsed at once.
- Fixing the model's reliability at following instructions in general — that's a model-quality concern, not something this change can solve.

## Architecture

**Shared catalog module — single source of truth.** `src/shared/uiCatalog.ts` (new, no JSX) uses the pre-built schema exported at `@json-render/react/schema` (confirmed present in the published `0.19.0` package — a plain data/schema descriptor, not React component code, safe to import from Node) with `defineCatalog` from `@json-render/core` to declare the 5 components below. Both `src/main/agent.ts` (Node, needs `catalog.prompt()`'s text for the system prompt) and `src/renderer/uiRegistry.tsx` (browser, needs the `catalog` object to build a registry) import from this one file, so the prompt description and the runtime validation can never drift apart.

`tsconfig.main.json`'s `include` gains `"src/shared/**/*"` so `agent.ts` can resolve the import (currently only `src/main/**` and `src/preload/**` are included). Vite already resolves relative imports outside its `root` (`src/renderer`) without configuration changes.

**Catalog (5 components, no actions):**
- `Stack` — root/container, renders children in a vertical flex column. No props.
- `Text` — `{ content: string }` — a paragraph.
- `List` — `{ items: string[], ordered: boolean | null }` — `<ul>`/`<ol>`.
- `Table` — `{ headers: string[], rows: string[][] }` — a real `<table>`.
- `CodeBlock` — `{ code: string, language: string | null }` — syntax-highlighted code.

**Prompt change (`agent.ts`).** The existing system prompt string gets `catalog.prompt({...})` appended, instructing: the final answer (after any tool calls finish) must be a single root `Stack` of JSONL SpecStream patches, no prose outside it; tabular/file-listing data goes in `Table`; code/command output in `CodeBlock`; everything else in `Text`; even a one-sentence answer must be wrapped in a `Stack` with one `Text` block. No other change to `agent.ts` — the tool-calling loop, `stopWhen`, history construction, and trim logic (all previously shipped) are untouched. The IPC event shape is unchanged: `onEvent({type: 'message', content: text})` still sends a plain string — it's just that the string is now (ideally) JSONL instead of markdown-ish prose.

**Rendering (`App.tsx` + two new renderer files).** A new pure function, `parseAssistantContent(content: string): Spec | null` (in `src/renderer/parseAssistantContent.ts`), attempts `compileSpecStream(content)` then `validateSpec`/`autoFixSpec`, wrapped in try/catch; returns `null` on any thrown error, validation failure, or an empty spec (`isNonEmptySpec` false). `App.tsx`'s message-rendering branch calls this for `role === 'assistant'` messages: a non-null `Spec` renders via `<StateProvider initialState={{}}><Renderer spec={spec} registry={registry} /></StateProvider>`; `null` falls back to the current plain `{msg.content}` render. User messages are never parsed — unchanged.

`src/renderer/uiRegistry.tsx` (new) holds `defineRegistry(catalog, {...})` — the JSX implementation of each of the 5 components. `CodeBlock` uses `highlight.js` directly (its core API, not the `rehype-highlight` plugin, which only composes inside a remark/rehype AST pipeline we no longer have): `hljs.highlightAuto(code).value` into `dangerouslySetInnerHTML`. This is safe specifically because highlight.js escapes the source text before tokenizing — it cannot inject arbitrary HTML, only wraps recognized syntax tokens in `<span>`s. Theme: `highlight.js/styles/github-dark.css`, imported once, matching the app's existing dark UI.

Tool-call progress cards (`msg.toolCalls`, the "Executing X.../Ran X" UI) are completely untouched — this change only affects how the final assistant text (`msg.content`) renders, not the tool-call-in-progress UI built in the conversation-history feature.

## Components (files touched/created)

- **`src/shared/uiCatalog.ts`** (new) — catalog built from `@json-render/react/schema` + `defineCatalog`, exports `catalog`. No JSX.
- **`tsconfig.main.json`** — add `"src/shared/**/*"` to `include`.
- **`src/main/agent.ts`** — import `catalog`, append `catalog.prompt({...})` to the system prompt string. Nothing else changes.
- **`src/renderer/uiRegistry.tsx`** (new) — `defineRegistry` with JSX for all 5 components. Exports `registry`.
- **`src/renderer/parseAssistantContent.ts`** (new) — the pure parse-or-null function.
- **`src/renderer/App.tsx`** — assistant-message render branch calls `parseAssistantContent`, branches to `<Renderer>` or the existing plain-text fallback.
- **`package.json`** — add `@json-render/core@0.19.0`, `@json-render/react@0.19.0`, `highlight.js`.

## Data flow

Identical event pipeline to today: `'message'` event → `event.content` (a string) → appended to `lastMsg.content` in `App.tsx`'s `onAgentEvent` handler (no change there — that logic already exists and works). The only new step is *interpretation* at render time, not a new data path. Conversation history (from the prior feature) keeps storing the raw JSONL text as the assistant's turn in `responseMessages` — the model reading its own prior JSONL text back next turn is fine; it doesn't need it prettified for its own context.

## Error handling

- `parseAssistantContent` wraps `compileSpecStream` + `validateSpec`/`autoFixSpec` in try/catch. Any thrown exception, a validation failure, or `isNonEmptySpec` returning false all resolve to `null` — no partial/broken render is ever attempted.
- `null` → render `msg.content` as plain text, identical to today's current (pre-this-feature) behavior. This is the primary defense against the small model failing to produce valid JSONL: worst case, the UI looks exactly like it does right now, never blank or throwing.
- Tool-call error paths (existing `'error'` event, `'tool_result'` carrying an error string) are untouched — already plain text, unaffected.
- `hljs.highlightAuto` does not throw on arbitrary/malformed input (designed for untrusted source text) — no additional try/catch needed around it.

## Testing

No test framework in this project — manual verification, consistent with how the conversation-history feature was verified:

1. **Table**: send a message that produces tabular data (e.g. "list the files here") — confirm a real `<table>` renders (header row, borders), not raw pipe-delimited text.
2. **Plain text**: send a plain conversational message (e.g. "hi") — confirm it still renders sensibly as a single `Text` block, not blank.
3. **Code**: send something likely to include code/commands (e.g. "show me the package.json scripts") — confirm `CodeBlock` renders with syntax coloring (dark theme).
4. **Fallback path**: temporarily call `parseAssistantContent` with a deliberately malformed string (e.g. `"not json at all"`) via a scratch check — confirm it returns `null` and `App.tsx`'s plain-text path still renders correctly. Revert the scratch check after confirming.
