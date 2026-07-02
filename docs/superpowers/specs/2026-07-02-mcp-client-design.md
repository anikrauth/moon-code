# Real MCP Client — Design

Date: 2026-07-02
Status: Approved

## Problem

The MCP panel is a mock: hardcoded catalog, fake 800ms "connect", persisted selections that do nothing. The agent cannot use any MCP server.

## Goal

User-defined MCP servers (stdio and HTTP transports), really connected from the panel, their tools exposed to the agent (and subagents) as permission-gated tools, statuses live in the UI, connections restored on launch.

## Dependency

`@modelcontextprotocol/sdk` (official): `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`. Tool bridging uses AI SDK's `dynamicTool`/`jsonSchema` (already exported by `ai`) so raw JSON Schema from MCP flows through without zod conversion.

## Design

### 1. Config schema extension (`configStore`)

`config.json` gains:

```json
"mcpServers": [
  { "id": "m-<uuid>", "name": "GitHub", "transport": "stdio",
    "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
    "secretsEnc": "<base64>", "enc": true },
  { "id": "m-<uuid>", "name": "Remote", "transport": "http",
    "url": "https://example.com/mcp", "secretsEnc": null, "enc": false }
]
```

- `secretsEnc` = safeStorage-encrypted JSON string `{ "env": {..}, "headers": {..} }` (either key optional). Same encrypt/decrypt/fallback rules as profile API keys.
- Store methods: `upsertMcpServer(def, rawSecrets?)` → id (`m-<uuid>`; blank `rawSecrets` on update keeps stored secrets), `deleteMcpServer(id)` (also removes id from `connectedMcpIds`), `resolveMcpSecrets(id)` → `{env, headers}` or `{}` (decrypt failure → `{}`).
- `getRedacted()` maps each server to `{id, name, transport, command, args, url, hasSecrets}` — `secretsEnc`/`enc` never cross IPC.
- `connectedMcpIds` (existing field) becomes the auto-reconnect list: panel connect adds, disconnect removes (reusing `setMcpIds`).
- Migration: configs without `mcpServers` load as `[]` (spread over the empty default).

### 2. `src/main/mcpManager.ts`

`createMcpManager({ getServer, resolveSecrets, onStatus })` — dependencies injected (no Electron imports; `getServer(id)` returns the full def incl. nothing secret, `resolveSecrets(id)` the decrypted blob):

- `connect(id)`: emit `connecting`; build transport — stdio: `new StdioClientTransport({ command, args, env: {...process.env, ...secrets.env} })`; http: `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: secrets.headers } })` — `new Client(...)`, `client.connect(transport)`, `client.listTools()`; cache `{client, tools}`; emit `connected` with `toolCount`. Failure → emit `error` with message, no cached entry. Transport close/error callback → drop cache, emit `disconnected`/`error`.
- `disconnect(id)`: `client.close()` (kills stdio child), drop cache, emit `disconnected`.
- `disconnectAll()`: for app quit.
- `getAgentTools()` → `{ [safeName]: { description, inputSchema, execute } }` where `safeName = mcp__<slug(serverName)>__<toolName>` (slug: non-alphanumerics → `_`); `inputSchema` is the raw MCP JSON Schema; `execute(args)` → `client.callTool({name, arguments: args})`, result content flattened to text (join text parts; non-text parts JSON-stringified), errors → `Error: <message>` string. Name collisions: later-connected server wins, collision logged.
- `statuses()` → `{ [id]: { status, toolCount? } }`.

### 3. Agent integration

- `handlePrompt(..., requestPermission, abortSignal, extraTools?)` — new trailing param: map of MCP tool descriptors.
- `makeTools` gains `extraTools`; after built-ins (and spawn_agent) it merges each as:

```ts
tools[name] = tool({
    description,
    inputSchema: jsonSchema(schema),
    execute: async (args) => {
        emit({ type: 'tool_call', name, arguments: JSON.stringify(args) });
        if (!await requestPermission(name, args, agentId)) return denied(name);
        const res = await execute(args);   // manager-provided proxy
        const out = truncateOutput(typeof res === 'string' ? res : JSON.stringify(res));
        emit({ type: 'tool_result', name, result: out });
        return out;
    }
});
```

- Permission-gated (unknown side effects) — session always-allow per tool name applies. Subagents inherit (same `makeTools` args).
- `import { jsonSchema } from 'ai'` added.

### 4. IPC + lifecycle (`main.ts`, `preload.ts`)

| Channel | Kind | Payload → Result |
|---|---|---|
| `mcp:list` | invoke | → `{ servers: redacted defs, statuses }` |
| `mcp:upsertServer` | invoke | `(def, rawSecrets?)` → fresh `mcp:list` shape |
| `mcp:deleteServer` | invoke | `(id)` (disconnect first) → fresh list shape |
| `mcp:connect` / `mcp:disconnect` | invoke | `(id)` → fresh list shape (statuses reflect result) |
| `mcp:event` | push (main→renderer) | `{ id, status, toolCount?, message? }` on every status change |

- Manager constructed in `whenReady` with configStore accessors; `onStatus` broadcasts `mcp:event` to the window.
- Launch: after window load, auto-connect every id in `connectedMcpIds` (fire-and-forget, failures surface as `error` statuses).
- `agent:prompt`: passes `mcpManager.getAgentTools()` as `extraTools`.
- `before-quit`: `disconnectAll()`.
- Connect/disconnect also update `connectedMcpIds` via the config store (auto-reconnect list).

### 5. Renderer (`McpPanel.tsx` rewrite, `App.tsx` wiring)

- Mock `MCP_CATALOG` deleted. Panel lists user-defined servers from `mcp:list`: name, transport tag, status icon (connecting spinner / connected check / error cross with message tooltip), tool count when connected, Connect/Disconnect button, Edit, Delete.
- Add/Edit form: name, transport toggle (stdio ↔ http), stdio: command + args (single text input, space-split) / http: url; secrets textarea (KEY=value lines for env, or Header: value lines for headers — parsed per transport), masked placeholder when `hasSecrets`, blank keeps stored secrets.
- `App.tsx`: `mcpServers`/`mcpStatuses` state now fed from `mcp:list` + `mcp:event` subscription (new preload `onMcpEvent`); fake-connect `setTimeout` logic deleted; `applyConfig`'s MCP restore replaced by the real status flow (auto-reconnect happens in main). RichInput chips unchanged (they read `mcpServers` with `status === 'connected'`).

### 6. System prompt

No change — MCP tool descriptions carry their own guidance.

## Error handling

- Connect failures (bad command, unreachable URL, handshake timeout) → `error` status with message; no partial cache.
- Tool call failures → `Error: <message>` string result to the model (existing convention, ambered in UI).
- Server dies mid-session → transport close handler drops tools, emits `disconnected`; in-flight `callTool` rejects → error string result.
- Decrypt failure on secrets → connect proceeds without secrets ONLY if the def has `hasSecrets === false`; otherwise connect fails with a "re-enter secrets" error status.

## Testing

- `test/config-mcp.test.js`: upsert/update-keeping-secrets/delete (also prunes `connectedMcpIds`), redaction (no `secretsEnc` in redacted output), `resolveMcpSecrets` round-trip + decrypt-failure → `{}` (fake safeStorage, as existing config tests).
- `test/fixtures/echo-mcp-server.js`: minimal stdio MCP server built with the SDK's server classes exposing one `echo` tool (returns its input text) and one `fail` tool (throws).
- `test/mcp-manager.test.js`: spawn fixture via manager → status sequence `connecting→connected`, toolCount 2; `getAgentTools()` has `mcp__fixture__echo` with the JSON Schema; bridged execute round-trips; `fail` tool → `Error:` string; disconnect → child gone + `disconnected`; connect to nonexistent command → `error` status.
- `test/mcp-agent.test.js` (harness): `handlePrompt` with an `extraTools` entry → tool appears in request tool list, model call round-trips through it, and the call IS permission-gated (stub records the mcp tool name).
- HTTP transport: constructor/wiring typechecked; no automated end-to-end (documented — needs a live HTTP MCP endpoint; manual check).

## Out of scope

- OAuth device flows; MCP resources/prompts/sampling (tools only); tool-list change notifications mid-session; per-tool enable toggles; reconnect backoff.
