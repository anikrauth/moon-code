# Structured Assistant Message Rendering (json-render) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make assistant replies containing tabular data, code, or lists render as real UI elements (tables, syntax-highlighted code blocks, lists) instead of raw markdown-ish text, using Vercel's `json-render` framework, with a plain-text fallback if the model's output doesn't parse.

**Architecture:** A shared catalog (`src/shared/uiCatalog.ts`) defines 5 read-only UI components (Stack/Text/List/Table/CodeBlock). `agent.ts`'s system prompt gets `catalog.prompt()` appended, instructing the model to emit its final answer as JSONL SpecStream patches instead of prose. The renderer (`App.tsx`) tries to parse each assistant message's content as a spec (`parseAssistantContent`); on success it renders via `@json-render/react`'s `Renderer`, on any failure it falls back to today's plain-text render.

**Tech Stack:** `@json-render/core@0.19.0`, `@json-render/react@0.19.0`, `highlight.js@11.11.1`, `zod@4.4.3` (already installed, satisfies json-render's `^4.3.6` peer dep).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-json-render-ui-design.md` — read before starting.
- New files (`src/shared/uiCatalog.ts`, `src/renderer/uiRegistry.tsx`, `src/renderer/parseAssistantContent.ts`) start with `// @ts-nocheck`, matching the project's established convention (every file except `preload.ts` already uses it) — `npx tsc --noEmit` after each task is a syntax check only, not a real type check, same caveat as the conversation-history plan.
- No test framework in this project — verification is `npx tsc --noEmit` + manual verification in the running app.
- `agent.ts`, `main.ts` are main-process files — need a full dev-app restart to pick up changes (Vite hot-reloads renderer files only).
- `parseAssistantContent` must never throw — any failure (parse exception, validation failure, empty spec) returns `null`, and `App.tsx` must fall back to plain-text rendering on `null`. This is the primary defense against the small model (`@cf/meta/llama-3-8b-instruct`) failing to produce valid JSONL.
- Catalog has no `actions` — this is read-only display, not an interactive form builder.
- `@json-render/react/schema`'s `schema` export (not hand-rolled via `defineSchema`) is the correct, verified way to build the catalog — confirmed present in the published `0.19.0` package and confirmed to have zero React/DOM runtime dependency (only requires `@json-render/core`), safe to import from the Electron main process.

---

### Task 1: Dependencies + shared UI catalog

**Files:**
- Modify: `package.json` (add dependencies)
- Modify: `tsconfig.main.json` (add `src/shared/**/*` to `include`)
- Create: `src/shared/uiCatalog.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `catalog` exported from `src/shared/uiCatalog.ts` — a `Catalog` (from `@json-render/core`) with 5 components: `Stack` (children via `slots: ['default']`), `Text` (`content: string`), `List` (`items: string[]`, `ordered: boolean | null`), `Table` (`headers: string[]`, `rows: string[][]`), `CodeBlock` (`code: string`, `language: string | null`). Later tasks (`agent.ts` for `catalog.prompt()`, `uiRegistry.tsx` for `defineRegistry(catalog, ...)`) import this exact `catalog` export.

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/anikrouth/projects/coding-agent/moon-agent
npm install @json-render/core@0.19.0 @json-render/react@0.19.0 highlight.js@11.11.1
```

Expected: `package.json`'s `dependencies` gains all three; no peer dependency warnings about `zod` (project already has `zod@4.4.3`, satisfies json-render's `^4.3.6` requirement).

- [ ] **Step 2: Add `src/shared/**/*` to the main-process TypeScript build**

`tsconfig.main.json` currently reads:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": [
    "src/main/**/*",
    "src/preload/**/*"
  ]
}
```

Change the `include` array to:

```json
  "include": [
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*"
  ]
```

- [ ] **Step 3: Create the shared catalog**

Create `src/shared/uiCatalog.ts`:

```typescript
// @ts-nocheck
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

export const catalog = defineCatalog(schema, {
    components: {
        Stack: {
            props: z.object({}),
            slots: ['default'],
            description: 'A vertical container for one or more blocks. Always the root element of every response.',
        },
        Text: {
            props: z.object({
                content: z.string(),
            }),
            slots: [],
            description: 'A paragraph of plain text.',
        },
        List: {
            props: z.object({
                items: z.array(z.string()),
                ordered: z.boolean().nullable(),
            }),
            slots: [],
            description: 'A bulleted (ordered: false/null) or numbered (ordered: true) list.',
        },
        Table: {
            props: z.object({
                headers: z.array(z.string()),
                rows: z.array(z.array(z.string())),
            }),
            slots: [],
            description: 'A table for tabular or file-listing data. Every row array must have the same length as headers.',
        },
        CodeBlock: {
            props: z.object({
                code: z.string(),
                language: z.string().nullable(),
            }),
            slots: [],
            description: 'A block of code, command output, or file contents. language is a lowercase name like "typescript" or "bash", or null if unknown.',
        },
    },
    actions: {},
});
```

- [ ] **Step 4: Verify the main-process build picks up the new file**

Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: no output (exit 0). This confirms `tsconfig.main.json`'s `include` change works and the new file has no syntax errors (it has `// @ts-nocheck`, so this isn't a full type check).

Also run the project-wide check used throughout this session:

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.main.json src/shared/uiCatalog.ts
git commit -m "feat: add json-render deps and shared UI catalog"
```

---

### Task 2: `agent.ts` — instruct the model to emit structured UI

**Files:**
- Modify: `src/main/agent.ts` (add import, build combined system prompt)

**Interfaces:**
- Consumes: `catalog` from `src/shared/uiCatalog.ts` (Task 1) — specifically `catalog.prompt(options)`.
- Produces: nothing new for later tasks — the emitted `text`/`event.content` shape is unchanged (still a plain string over the same `'message'` event), it's just that the string's *content* is now (ideally) JSONL instead of prose. `App.tsx` (Task 5) doesn't depend on anything from this task beyond "the string might now be JSONL."

- [ ] **Step 1: Add the catalog import**

In `src/main/agent.ts`, add this import alongside the existing ones near the top of the file (after the `dotenv.config();` line, before `export async function handlePrompt`):

```typescript
import { catalog } from '../shared/uiCatalog';
```

- [ ] **Step 2: Build the combined system prompt and use it in the `generateText` call**

Find this block (the `generateText` call added by the conversation-history feature):

```typescript
        const userMsg = { role: 'user', content: prompt };
        const { text, responseMessages } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: `You are Moon Agent, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely.`,
            messages: [...(history ?? []), userMsg],
            tools: tools,
            stopWhen: stepCountIs(10),
        });
```

Replace it with:

```typescript
        const systemPrompt = `You are Moon Agent, an advanced coding agentic IDE for Mac. You have full access to the user's workspace at ${workspace}. You must use tools to accomplish the user's requests autonomously. Do NOT wait for the user if you can figure it out. Answer concisely.

${catalog.prompt({
            system: 'Your final answer to the user must be valid UI spec JSONL (SpecStream format), not plain prose.',
            customRules: [
                'Always wrap your entire response in a single root Stack element, even for a one-sentence answer.',
                'Use Table for any tabular or file-listing data instead of describing it in prose.',
                'Use CodeBlock for command output, code snippets, or file contents.',
                'Use List for enumerated points or suggestions.',
                'Use Text for everything else.',
            ],
            mode: 'standalone',
        })}`;

        const userMsg = { role: 'user', content: prompt };
        const { text, responseMessages } = await generateText({
            model: customOpenAI.chat(settings.model || 'gpt-4o'),
            system: systemPrompt,
            messages: [...(history ?? []), userMsg],
            tools: tools,
            stopWhen: stepCountIs(10),
        });
```

- [ ] **Step 3: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). `agent.ts` has `// @ts-nocheck`, so this only catches parse errors.

- [ ] **Step 4: Restart the dev app and confirm it boots clean**

Main-process file — restart required:

```bash
pkill -9 -f "moon-agent/node_modules/electron/dist/Electron.app" 2>/dev/null
pkill -9 -f "moon-agent/node_modules/.bin/vite" 2>/dev/null
pkill -9 -f "concurrently.*dev:vite.*dev:electron" 2>/dev/null
sleep 1
cd /Users/anikrouth/projects/coding-agent/moon-agent
nohup npm run dev > /tmp/moon-agent-dev.log 2>&1 &
disown
sleep 8
tail -n 25 /tmp/moon-agent-dev.log
```

Expected: `VITE ... ready`, no thrown errors, a new Electron window opens. Full behavior (does the model actually follow the new instructions) can't be confirmed until Task 5's rendering exists — this step only confirms the app doesn't crash on startup with the new system prompt code.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent.ts
git commit -m "feat: instruct model to emit json-render UI spec as final answer"
```

---

### Task 3: `uiRegistry.tsx` — component implementations

**Files:**
- Create: `src/renderer/uiRegistry.tsx`

**Interfaces:**
- Consumes: `catalog` from `src/shared/uiCatalog.ts` (Task 1).
- Produces: `registry` exported from `src/renderer/uiRegistry.tsx` — a `ComponentRegistry` (from `@json-render/react`'s `defineRegistry`) usable as `<Renderer registry={registry} .../>`. Task 5 (`App.tsx`) imports this exact `registry` export.

- [ ] **Step 1: Create the registry file**

Create `src/renderer/uiRegistry.tsx`:

```tsx
// @ts-nocheck
import { defineRegistry } from '@json-render/react';
import hljs from 'highlight.js';
import { catalog } from '../shared/uiCatalog';

function CodeBlock({ props }) {
    const highlighted = props.language && hljs.getLanguage(props.language)
        ? hljs.highlight(props.code, { language: props.language }).value
        : hljs.highlightAuto(props.code).value;
    return (
        <pre style={{ background: 'rgba(0,0,0,0.4)', padding: '12px', borderRadius: '8px', overflowX: 'auto' }}>
            <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
    );
}

export const { registry } = defineRegistry(catalog, {
    components: {
        Stack: ({ children }) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>{children}</div>
        ),
        Text: ({ props }) => <p style={{ margin: 0 }}>{props.content}</p>,
        List: ({ props }) => {
            const Tag = props.ordered ? 'ol' : 'ul';
            return (
                <Tag style={{ margin: 0, paddingLeft: '20px' }}>
                    {props.items.map((item, i) => <li key={i}>{item}</li>)}
                </Tag>
            );
        },
        Table: ({ props }) => (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                    <tr>
                        {props.headers.map((h, i) => (
                            <th key={i} style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)', padding: '6px 10px' }}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {props.rows.map((row, i) => (
                        <tr key={i}>
                            {row.map((cell, j) => (
                                <td key={j} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', padding: '6px 10px' }}>{cell}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        ),
        CodeBlock,
    },
});
```

- [ ] **Step 2: Import the highlight.js dark theme once, in the renderer's global stylesheet entry point**

Read `src/renderer/index.tsx` first to find where CSS is currently imported (it should have an `import './index.css'` line or similar). Add this line alongside it:

```typescript
import 'highlight.js/styles/github-dark.css';
```

- [ ] **Step 3: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). This file has `// @ts-nocheck`, so this only catches parse errors — e.g. unbalanced JSX would still show up here.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/uiRegistry.tsx src/renderer/index.tsx
git commit -m "feat: add json-render component registry (Stack/Text/List/Table/CodeBlock)"
```

---

### Task 4: `parseAssistantContent.ts` — safe parse-or-fallback

**Files:**
- Create: `src/renderer/parseAssistantContent.ts`

**Interfaces:**
- Consumes: `compileSpecStream`, `validateSpec`, `autoFixSpec`, `isNonEmptySpec` from `@json-render/core` (no dependency on Task 1's `catalog` — this function is catalog-agnostic, it only validates spec *structure*, not component-specific prop shapes).
- Produces: `parseAssistantContent(content: string): Spec | null` exported from `src/renderer/parseAssistantContent.ts`. Task 5 (`App.tsx`) calls this exact function with this exact signature.

- [ ] **Step 1: Create the parse function**

Create `src/renderer/parseAssistantContent.ts`:

```typescript
// @ts-nocheck
import { compileSpecStream, validateSpec, autoFixSpec, isNonEmptySpec } from '@json-render/core';

export function parseAssistantContent(content) {
    try {
        const rawSpec = compileSpecStream(content);
        if (!isNonEmptySpec(rawSpec)) {
            return null;
        }
        const { spec: fixedSpec } = autoFixSpec(rawSpec);
        const result = validateSpec(fixedSpec);
        if (!result.valid) {
            return null;
        }
        return fixedSpec;
    } catch {
        return null;
    }
}
```

- [ ] **Step 2: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 3: Manual fallback-path check**

Run this one-off script to confirm malformed input returns `null` (this exercises the exact function that will run in the app, without needing the UI):

```bash
cd /Users/anikrouth/projects/coding-agent/moon-agent
node -e "
const { compileSpecStream, validateSpec, autoFixSpec, isNonEmptySpec } = require('@json-render/core');
function parseAssistantContent(content) {
    try {
        const rawSpec = compileSpecStream(content);
        if (!isNonEmptySpec(rawSpec)) return null;
        const { spec: fixedSpec } = autoFixSpec(rawSpec);
        const result = validateSpec(fixedSpec);
        if (!result.valid) return null;
        return fixedSpec;
    } catch { return null; }
}
console.log('malformed ->', parseAssistantContent('not json at all'));
console.log('empty ->', parseAssistantContent(''));
const validJsonl = '{\"op\":\"add\",\"path\":\"/root\",\"value\":\"t1\"}\n{\"op\":\"add\",\"path\":\"/elements/t1\",\"value\":{\"type\":\"Text\",\"props\":{\"content\":\"hi\"},\"children\":[]}}';
console.log('valid ->', JSON.stringify(parseAssistantContent(validJsonl)));
"
```

Expected: `malformed -> null`, `empty -> null`, `valid -> {"root":"t1","elements":{"t1":{"type":"Text","props":{"content":"hi"},"children":[]}}}` (or equivalent non-null object — exact key order may vary, but it must not be `null`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/parseAssistantContent.ts
git commit -m "feat: add parseAssistantContent with safe fallback to null"
```

---

### Task 5: `App.tsx` — render structured specs with plain-text fallback

**Files:**
- Modify: `src/renderer/App.tsx` (imports, message-rendering block)

**Interfaces:**
- Consumes: `registry` from `src/renderer/uiRegistry.tsx` (Task 3), `parseAssistantContent` from `src/renderer/parseAssistantContent.ts` (Task 4), `StateProvider`/`Renderer` from `@json-render/react`.
- Produces: nothing new for later tasks (this is the last code task).

- [ ] **Step 1: Add imports**

Add these three imports to `src/renderer/App.tsx`, alongside the existing imports near the top of the file (after the `McpPanel` import):

```typescript
import { StateProvider, Renderer } from '@json-render/react';
import { registry } from './uiRegistry';
import { parseAssistantContent } from './parseAssistantContent';
```

- [ ] **Step 2: Replace the message-rendering block**

Find this exact block in `src/renderer/App.tsx` (inside the `{messages.length === 0 ? (...) : (...)}` ternary, the `messages.map` call):

```typescript
            messages.map((msg, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{ 
                        background: msg.role === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                        color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        maxWidth: '80%',
                        lineHeight: '1.5'
                    }}>
                        {msg.content}
                    </div>
                    
                    {/* Tool Calls */}
                    {msg.toolCalls && msg.toolCalls.map((tool: any, j: number) => (
                        <div key={j} style={{ 
                            marginTop: '8px', 
                            background: 'rgba(0,0,0,0.3)', 
                            border: '1px solid var(--border-color)',
                            borderRadius: '8px',
                            padding: '8px 12px',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            color: 'var(--text-secondary)'
                        }}>
                            {tool.name === 'run_command' ? <Terminal size={14} /> : <FileEdit size={14} />}
                            <span>{tool.result ? 'Ran' : 'Executing'} <strong>{tool.name}</strong>{tool.result ? '' : '...'}</span>
                        </div>
                    ))}
                </div>
            ))
```

Replace it with:

```typescript
            messages.map((msg, i) => {
                const spec = msg.role === 'assistant' ? parseAssistantContent(msg.content) : null;
                return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{ 
                        background: msg.role === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
                        color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        maxWidth: '80%',
                        lineHeight: '1.5'
                    }}>
                        {spec ? (
                            <StateProvider initialState={{}}>
                                <Renderer spec={spec} registry={registry} />
                            </StateProvider>
                        ) : msg.content}
                    </div>
                    
                    {/* Tool Calls */}
                    {msg.toolCalls && msg.toolCalls.map((tool: any, j: number) => (
                        <div key={j} style={{ 
                            marginTop: '8px', 
                            background: 'rgba(0,0,0,0.3)', 
                            border: '1px solid var(--border-color)',
                            borderRadius: '8px',
                            padding: '8px 12px',
                            fontSize: '12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            color: 'var(--text-secondary)'
                        }}>
                            {tool.name === 'run_command' ? <Terminal size={14} /> : <FileEdit size={14} />}
                            <span>{tool.result ? 'Ran' : 'Executing'} <strong>{tool.name}</strong>{tool.result ? '' : '...'}</span>
                        </div>
                    ))}
                </div>
                );
            })
```

Note the two structural changes: the arrow function body changed from implicit-return `(...)` to a block body `{ ... return (...); }` (to fit the `const spec = ...` line), and the JSX itself only changed in one spot — `{msg.content}` became the `{spec ? (...) : msg.content}` ternary. Everything else (the tool-calls block, the outer `<div>` structure) is byte-for-byte identical to before.

- [ ] **Step 3: Syntax sanity check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0). This file has `// @ts-nocheck` — this check mainly confirms the JSX braces/parens balance after converting to a block-body arrow function.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: render assistant messages as structured UI with plain-text fallback"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: the fully wired feature from Tasks 1-5.
- Produces: nothing (terminal task).

- [ ] **Step 1: Restart the dev app clean**

```bash
pkill -9 -f "moon-agent/node_modules/electron/dist/Electron.app" 2>/dev/null
pkill -9 -f "moon-agent/node_modules/.bin/vite" 2>/dev/null
pkill -9 -f "concurrently.*dev:vite.*dev:electron" 2>/dev/null
sleep 1
cd /Users/anikrouth/projects/coding-agent/moon-agent
nohup npm run dev > /tmp/moon-agent-dev.log 2>&1 &
disown
sleep 8
tail -n 25 /tmp/moon-agent-dev.log
```

Expected: `VITE ... ready`, no errors, one Electron window opens.

- [ ] **Step 2: Verify table rendering**

In the app: select a workspace, configure valid model settings, send a message that produces tabular/file-listing data (e.g. "list the files here").

Expected: a real `<table>` renders with a header row and cell borders — not raw `| Type | Name |` pipe text. (If the small model doesn't follow the new instructions and produces plain prose instead, the plain-text fallback should still show something readable, not a blank bubble — that's an acceptable outcome for this step, but the table itself not rendering means the model didn't produce valid JSONL, which is the accepted risk noted in the spec.)

- [ ] **Step 3: Verify plain conversational replies still work**

Send a simple message (e.g. "hi").

Expected: some reply renders — either as a single `Text` block (if the model produced valid JSONL) or as plain text (fallback) — never a blank assistant bubble.

- [ ] **Step 4: Verify code block rendering**

Send something likely to produce code or command output (e.g. "show me the package.json scripts").

Expected: if the model produces a `CodeBlock`, it renders with a distinct dark background and syntax coloring, not plain inline text.

- [ ] **Step 5: Confirm tool-call cards are unaffected**

During any of the above, trigger a tool call (e.g. "list the files here" should call `list_dir`).

Expected: the "Executing list_dir..." / "Ran list_dir" card still renders exactly as it did before this feature — this part of the UI was not touched.
