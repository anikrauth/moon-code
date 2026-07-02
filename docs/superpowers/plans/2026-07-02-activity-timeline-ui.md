# Activity Timeline UI + Header Clip Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Header never scrolls under the titlebar; assistant tool activity renders as chronological Claude Code-style lines (spinner while running, collapsed result summary, click-to-expand) ABOVE the response bubble.

**Architecture:** Renderer-only. CSS fix (`html` overflow + border-box on the App container) kills the page scroll. A new `ToolActivity` component in `App.tsx` replaces the old "Ran tool" pills and moves above the bubble; the bubble renders only when there is content (or streaming).

**Tech Stack:** React 19, plain CSS in `src/renderer/index.css`. Verification: `npx tsc --noEmit && npx vite build && npm test` (no renderer unit tests by project convention).

## Global Constraints

- All source files start `// @ts-nocheck`; keep.
- Event/tool-call object shape (unchanged, produced by main): `{ type:'tool_call', name, agent, arguments: <JSON string>, result?: string }`; denial string `'User denied permission for this action.'`; abort marker `'aborted'`.
- Activity order = arrival order of `msg.toolCalls` (already chronological).
- Bubble renders for: user messages always; assistant messages when `msg.content !== ''` OR (`isTyping &&` last message).
- Arg preview precedence: `command` → `filePath` → `dirPath` → `task`; truncate 60 chars + `…`. Result summary: first non-empty line, truncate 80 chars.

---

### Task 1: Layout fix — header can never scroll away

**Files:**
- Modify: `src/renderer/index.css`
- Modify: `src/renderer/App.tsx` (one style prop)

**Interfaces:** none produced; standalone fix.

- [ ] **Step 1: index.css — pin the html element**

After the existing `body { ... }` rule add:

```css
html {
  height: 100%;
  overflow: hidden;
}
```

- [ ] **Step 2: App.tsx — border-box on the root container**

The outermost App `<div>` (currently `style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px', paddingTop: '40px', position: 'relative' }}`) gets `boxSizing: 'border-box'` added to that style object.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vite build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.css src/renderer/App.tsx
git commit -m "fix: prevent page scroll from clipping header under titlebar"
```

---

### Task 2: ToolActivity component + chronological ordering

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/index.css`

**Interfaces:**
- Consumes: `msg.toolCalls` event objects (shape in Global Constraints); existing `AssistantContent`, `isTyping`.
- Produces: `ToolActivity({ tool })` component (module-level in App.tsx); CSS classes `activity-*`, `agent-badge`.

- [ ] **Step 1: CSS — activity styles**

Append to `src/renderer/index.css`:

```css
/* ---- Tool activity timeline ---- */
.activity-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
  max-width: 80%;
}
.activity-item {
  font-size: 13px;
  color: var(--text-secondary);
}
.activity-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.activity-clickable {
  cursor: pointer;
}
.activity-marker {
  color: var(--accent-color);
  font-size: 11px;
  line-height: 1;
}
.activity-pending {
  animation: activity-pulse 1.2s ease-in-out infinite;
}
@keyframes activity-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.activity-label strong {
  color: var(--text-primary);
  font-weight: 500;
}
.activity-result-summary {
  padding-left: 21px;
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.activity-error {
  color: var(--warning-color);
}
.activity-result-full {
  margin: 4px 0 4px 21px;
  background: rgba(0, 0, 0, 0.4);
  padding: 10px;
  border-radius: 8px;
  max-height: 200px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.agent-badge {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10px;
}
```

- [ ] **Step 2: App.tsx — ToolActivity component**

Add at module level (below `AssistantContent`):

```tsx
function ToolActivity({ tool }: { tool: any }) {
  const [expanded, setExpanded] = useState(false);
  let preview = '';
  try {
    const args = JSON.parse(tool.arguments ?? '{}');
    preview = args.command ?? args.filePath ?? args.dirPath ?? args.task ?? '';
  } catch {
    // unparseable arguments — show no preview
  }
  if (preview.length > 60) preview = `${preview.slice(0, 60)}…`;
  const result = tool.result;
  const isError = !!result && (result.startsWith('Error:') || result === 'User denied permission for this action.' || result === 'aborted');
  const summary = result ? (result.split('\n').find((l: string) => l.trim()) ?? '').slice(0, 80) : null;
  return (
    <div className="activity-item">
      <div
        className={`activity-line ${result ? 'activity-clickable' : ''}`}
        onClick={() => result && setExpanded((e) => !e)}
        title={result ? (expanded ? 'Collapse output' : 'Expand output') : undefined}
      >
        <span className={`activity-marker ${result ? '' : 'activity-pending'}`}>⏺</span>
        {tool.agent && tool.agent !== 'main' && <span className="agent-badge">{tool.agent}</span>}
        <span className="activity-label"><strong>{tool.name}</strong>{preview ? `(${preview})` : ''}</span>
      </div>
      {summary != null && !expanded && (
        <div className={`activity-result-summary ${isError ? 'activity-error' : ''}`}>⎿ {summary}</div>
      )}
      {expanded && result && <pre className="activity-result-full">{result}</pre>}
    </div>
  );
}
```

- [ ] **Step 3: App.tsx — reorder the assistant message layout**

In the `messages.map(...)` body, the per-message JSX currently renders the bubble `<div style={{ background: ... }}>` first, then a `{msg.toolCalls && msg.toolCalls.map(...)}` block of pill rows (the one with `<Terminal size={14}/>` / `<FileEdit size={14}/>` and the agent badge span). Replace both with:

```tsx
<div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
    {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="activity-block">
            {msg.toolCalls.map((tool: any, j: number) => <ToolActivity key={j} tool={tool} />)}
        </div>
    )}
    {(msg.role === 'user' || msg.content !== '' || (isTyping && i === messages.length - 1)) && (
        <div style={{
            background: msg.role === 'user' ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)',
            color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
            padding: '12px 16px',
            borderRadius: '12px',
            maxWidth: '80%',
            lineHeight: '1.5'
        }}>
            {msg.role === 'assistant' ? (
                <AssistantContent content={msg.content} streaming={isTyping && i === messages.length - 1} />
            ) : msg.content}
        </div>
    )}
</div>
```

The old tool-pill JSX (the entire `{msg.toolCalls && msg.toolCalls.map((tool: any, j: number) => (...))}` block after the bubble) is DELETED. If `Terminal`/`FileEdit` icons become unused in App.tsx after this, remove them from the lucide-react import.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vite build && npm test`
Expected: clean build, 15/15 pass.

- [ ] **Step 5: Manual drive (dev app)**

Restart dev app; send a tool-using prompt. Confirm: activity lines appear above (and before) the response; pending line pulses; finished lines show `⎿` summary; click expands full output; error/denied results amber; long chat keeps the header fixed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/index.css
git commit -m "feat: Claude Code-style tool activity timeline above responses"
```
