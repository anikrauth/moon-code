# MCP Form Stacking Fix + Suggested Servers — Design

Date: 2026-07-02
Status: Approved

## Problems

1. The Add/Edit MCP server form renders UNDER the MCP Servers panel: both use `.modal-overlay` (z-index 100) and the form's JSX (App.tsx ~481) precedes `<McpPanel>` (~623) in the tree, so the later sibling paints on top.
2. Adding common servers requires hand-typing npx commands.

## Design

### 1. Elevated sub-dialog layer

`index.css`: `.modal-overlay-elevated { z-index: 110; }`. The `mcpForm` overlay div gets `className="modal-overlay modal-overlay-elevated"`. Panel remains visible beneath; form stacks above. Class is generic for future nested dialogs.

### 2. Suggested servers

`McpPanel.tsx` exports nothing new; internally:

```js
const MCP_PRESETS = [
  { name: 'Filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'], hint: null },
  { name: 'GitHub', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], hint: 'needs GITHUB_PERSONAL_ACCESS_TOKEN' },
  { name: 'Memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], hint: null },
  { name: 'Fetch', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], hint: null },
  { name: 'Puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], hint: null },
  { name: 'Sequential Thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], hint: null },
];
```

- Panel renders a "Suggested" section under the server list, listing presets whose `name` is not already among `servers[].name` (case-insensitive). Row: name, one-line command preview, hint in secondary text when present, an Add button.
- New panel prop `onAddPreset(preset)`. App handler substitutes `{workspace}` in args with the current workspace (fallback `os home` → literal `~` is fine for display; use `workspace ?? '~'`), builds `def = { name, transport: 'stdio', command, args }`, calls `upsertMcpServer(def)` (no secrets), `setMcpData` with the echo. Not auto-connected.
- All preset rows hidden while `busy`.

## Out of scope

Auto-connect on add; per-preset secret prompts; HTTP presets; dedupe beyond name match.

## Testing

Renderer-only: `npx tsc --noEmit && npx vite build && npm test` (70/70 unaffected) + manual eyeball via HMR (form above panel; preset add appears in list; GitHub hint visible).
