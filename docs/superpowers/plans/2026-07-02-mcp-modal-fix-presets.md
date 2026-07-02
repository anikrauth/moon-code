# MCP Form Stacking Fix + Suggested Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add/Edit MCP form stacks above the panel; one-click suggested servers.

**Architecture:** Renderer + CSS only. One task.

**Tech Stack:** React 19, CSS. Verify: `npx tsc --noEmit && npx vite build && npm test` (70/70 unaffected).

## Global Constraints

- `.modal-overlay-elevated { z-index: 110; }` — generic nested-dialog layer.
- Presets exactly as the spec's `MCP_PRESETS` table; suggestions hide when a server with the same name (case-insensitive) exists; `{workspace}` substituted at add time with current workspace or `~`; added servers are stdio, secret-less, NOT auto-connected.
- `// @ts-nocheck` kept.

---

### Task 1: stacking fix + presets

**Files:**
- Modify: `src/renderer/index.css`
- Modify: `src/renderer/McpPanel.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: CSS**

Append to `index.css`:

```css
/* Nested dialogs (e.g. a form opened from a panel) stack above base modals. */
.modal-overlay-elevated {
  z-index: 110;
}
.mcp-preset-hint {
  color: var(--warning-color);
  font-size: 11px;
}
```

- [ ] **Step 2: App.tsx — elevate the form overlay**

The `mcpForm` modal's outer div `className="modal-overlay"` → `className="modal-overlay modal-overlay-elevated"`.

- [ ] **Step 3: McpPanel.tsx — presets section**

Add below the imports:

```tsx
const MCP_PRESETS = [
  { name: 'Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'], hint: null },
  { name: 'GitHub', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], hint: 'needs GITHUB_PERSONAL_ACCESS_TOKEN' },
  { name: 'Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], hint: null },
  { name: 'Fetch', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], hint: null },
  { name: 'Puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], hint: null },
  { name: 'Sequential Thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], hint: null },
];
```

Props gain `onAddPreset`. Inside the `sp-catalog` div, AFTER the existing `{servers.map(...)}` block and the empty-state line, add:

```tsx
{(() => {
  const taken = new Set(servers.map((s) => s.name.toLowerCase()));
  const suggestions = MCP_PRESETS.filter((p) => !taken.has(p.name.toLowerCase()));
  if (suggestions.length === 0 || busy) return null;
  return (
    <>
      <span className="sp-category-label" style={{ marginTop: '10px' }}>Suggested</span>
      {suggestions.map((p) => (
        <div key={p.name} className="mcp-server-row">
          <div className="mcp-server-info">
            <div className="mcp-server-icon-wrap"><Plug size={16} /></div>
            <div className="mcp-server-text">
              <span className="mcp-server-name">{p.name}</span>
              <span className="sp-skill-desc">{p.command} {p.args.join(' ')}</span>
              {p.hint && <span className="mcp-preset-hint">{p.hint}</span>}
            </div>
          </div>
          <button className="mcp-toggle-btn" onClick={() => onAddPreset(p)}>Add</button>
        </div>
      ))}
    </>
  );
})()}
```

(`sp-category-label` already exists in CSS from SkillsPanel.)

- [ ] **Step 4: App.tsx — preset handler**

Next to the other MCP handlers:

```tsx
const handleAddMcpPreset = (preset: any) => {
  const args = preset.args.map((a: string) => (a === '{workspace}' ? (workspace ?? '~') : a));
  window.electron?.upsertMcpServer({ name: preset.name, transport: 'stdio', command: preset.command, args })
    .then((d: any) => d && setMcpData(d));
};
```

`<McpPanel ... onAddPreset={handleAddMcpPreset} />`.

- [ ] **Step 5: Verify** — `npx tsc --noEmit && npx vite build && npm test` → clean, 70/70. Manual (HMR live): open MCPs → Add Server → form ABOVE panel; Suggested section lists presets; Add GitHub → appears in server list with hint gone from suggestions.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.css src/renderer/McpPanel.tsx src/renderer/App.tsx
git commit -m "fix: stack MCP form above panel; add suggested server presets"
```
