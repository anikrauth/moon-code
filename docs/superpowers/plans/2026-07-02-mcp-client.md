# Real MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-defined MCP servers (stdio + HTTP), really connected, tools bridged to the agent permission-gated, live statuses, auto-reconnect on launch.

**Architecture:** configStore grows `mcpServers` (secrets safeStorage-encrypted); new `mcpManager` (SDK loaded via dynamic `import()` — works regardless of the package's ESM/CJS packaging); `handlePrompt` gains trailing `extraTools`; `makeTools` bridges them with `jsonSchema()` + permission gate; IPC + `mcp:event` push channel; `McpPanel` rewritten around real servers.

**Tech Stack:** `@modelcontextprotocol/sdk` (new dependency), AI SDK `jsonSchema`, node:test. Suite currently 55 passing.

## Global Constraints

- Server id `m-<randomUUID>`; MCP tool names `mcp__<slug(serverName)>__<toolName>` where slug = non-alphanumerics → `_`.
- `secretsEnc` = safeStorage-encrypted `JSON.stringify({env?, headers?})`; same fallback rules as API keys; NEVER crosses IPC — redacted defs carry `hasSecrets: boolean`.
- `resolveMcpSecrets(id)` → `{env?, headers?}` when stored, `{}` when the server has no secrets, `null` on decrypt failure (this refines the spec's §1 wording; the spec's Error-handling section governs: decrypt failure + `hasSecrets` → connect fails with a re-enter message).
- Bridged MCP tools ARE permission-gated (`requestPermission(name, args, agentId)`) and results run through `truncateOutput`.
- All MCP SDK imports via `await import('@modelcontextprotocol/sdk/...')` inside functions.
- Old configs without `mcpServers` load as `[]`. `deleteMcpServer` prunes the id from `connectedMcpIds`.
- `// @ts-nocheck` kept everywhere; existing 55 tests keep passing.

---

### Task 1: configStore MCP servers + secrets (TDD)

**Files:**
- Modify: `src/main/configStore.ts`
- Create: `test/config-mcp.test.js`

**Interfaces:**
- Produces: `upsertMcpServer(def, rawSecrets?) -> id`, `deleteMcpServer(id)`, `resolveMcpSecrets(id) -> {env?,headers?} | {} | null`; `getRedacted().mcpServers` entries `{id,name,transport,command,args,url,hasSecrets}`. Tasks 2-4 consume these.

- [ ] **Step 1: Write failing tests**

```js
// test/config-mcp.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createConfigStore } = require('../dist/main/configStore.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC(${s})`, 'utf-8'),
  decryptString: (buf) => {
    const m = buf.toString('utf-8').match(/^ENC\((.*)\)$/s);
    if (!m) throw new Error('bad ciphertext');
    return m[1];
  },
};
const mkStore = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-mcpcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createConfigStore({ dir, safeStorage: fakeSafeStorage });
};
const def = (over = {}) => ({ name: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], ...over });

test('upsert creates m- id; redacted hides secrets; resolve round-trips', (t) => {
  const s = mkStore(t);
  const id = s.upsertMcpServer(def(), { env: { TOKEN: 'tok-123' } });
  assert.match(id, /^m-/);
  const red = s.getRedacted().mcpServers[0];
  assert.strictEqual(red.hasSecrets, true);
  assert.strictEqual(red.command, 'npx');
  assert.ok(!JSON.stringify(s.getRedacted()).includes('tok-123'));
  assert.deepStrictEqual(s.resolveMcpSecrets(id), { env: { TOKEN: 'tok-123' } });
});

test('update with blank secrets keeps stored ones; fields update', (t) => {
  const s = mkStore(t);
  const id = s.upsertMcpServer(def(), { headers: { Authorization: 'Bearer x' } });
  s.upsertMcpServer({ id, ...def({ name: 'GitHub 2' }) });
  assert.strictEqual(s.getRedacted().mcpServers[0].name, 'GitHub 2');
  assert.deepStrictEqual(s.resolveMcpSecrets(id), { headers: { Authorization: 'Bearer x' } });
});

test('server without secrets: hasSecrets false, resolve gives {}', (t) => {
  const s = mkStore(t);
  const id = s.upsertMcpServer(def({ transport: 'http', url: 'https://x.test/mcp', command: undefined, args: undefined }));
  assert.strictEqual(s.getRedacted().mcpServers[0].hasSecrets, false);
  assert.deepStrictEqual(s.resolveMcpSecrets(id), {});
});

test('decrypt failure yields null', (t) => {
  const s = mkStore(t);
  const broken = { ...fakeSafeStorage, decryptString: () => { throw new Error('keychain changed'); } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-mcpcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s1 = createConfigStore({ dir, safeStorage: fakeSafeStorage });
  const id = s1.upsertMcpServer(def(), { env: { A: 'b' } });
  const s2 = createConfigStore({ dir, safeStorage: broken });
  assert.strictEqual(s2.resolveMcpSecrets(id), null);
});

test('delete removes server and prunes connectedMcpIds; old configs load mcpServers []', (t) => {
  const s = mkStore(t);
  const id = s.upsertMcpServer(def());
  s.setMcpIds([id, 'other']);
  s.deleteMcpServer(id);
  assert.deepStrictEqual(s.getRedacted().mcpServers, []);
  assert.deepStrictEqual(s.getConfig().connectedMcpIds, ['other']);
  assert.deepStrictEqual(mkStore(t).getConfig().mcpServers, []); // fresh/legacy default
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`: `upsertMcpServer is not a function`.

- [ ] **Step 3: Implement in `configStore.ts`**

- `emptyConfig()` gains `mcpServers: []` (spread-merge in `load()` already defaults it for legacy files).
- Generalize the key helpers (keep profile behavior identical):

```ts
function encryptSecret(raw) {
    if (safeStorage.isEncryptionAvailable()) {
        return { data: safeStorage.encryptString(raw).toString('base64'), enc: true };
    }
    console.warn('[moon-agent] OS encryption unavailable; storing secret base64-encoded only.');
    return { data: Buffer.from(raw, 'utf-8').toString('base64'), enc: false };
}
function decryptSecret(data, enc) {
    const buf = Buffer.from(data, 'base64');
    return enc ? safeStorage.decryptString(buf) : buf.toString('utf-8');
}
```

(`encryptKey`/`decryptKey` become thin wrappers or are replaced by direct calls — profile fields keep their existing names `apiKeyEnc`/`enc`.)

- New methods:

```ts
upsertMcpServer(def, rawSecrets) {
    const existing = def.id ? config.mcpServers.find((s) => s.id === def.id) : null;
    const id = existing ? existing.id : `m-${randomUUID()}`;
    const base = {
        id, name: def.name, transport: def.transport,
        command: def.command ?? null, args: def.args ?? null, url: def.url ?? null,
    };
    let secretFields;
    if (rawSecrets && Object.keys(rawSecrets).length > 0) {
        const { data, enc } = encryptSecret(JSON.stringify(rawSecrets));
        secretFields = { secretsEnc: data, enc };
    } else if (existing) {
        secretFields = { secretsEnc: existing.secretsEnc, enc: existing.enc };
    } else {
        secretFields = { secretsEnc: null, enc: false };
    }
    const next = { ...base, ...secretFields };
    if (existing) config.mcpServers = config.mcpServers.map((s) => (s.id === id ? next : s));
    else config.mcpServers.push(next);
    persist();
    return id;
},

deleteMcpServer(id) {
    config.mcpServers = config.mcpServers.filter((s) => s.id !== id);
    config.connectedMcpIds = config.connectedMcpIds.filter((x) => x !== id);
    persist();
},

resolveMcpSecrets(id) {
    const s = config.mcpServers.find((x) => x.id === id);
    if (!s) return null;
    if (!s.secretsEnc) return {};
    try {
        return JSON.parse(decryptSecret(s.secretsEnc, s.enc));
    } catch {
        return null;
    }
},
```

- `getRedacted()` gains:

```ts
mcpServers: config.mcpServers.map(({ secretsEnc, enc, ...rest }) => ({ ...rest, hasSecrets: !!secretsEnc })),
```

- [ ] **Step 4: Run to verify pass** — `npm test`: 60/60 (55 + 5).

- [ ] **Step 5: Commit**

```bash
git add src/main/configStore.ts test/config-mcp.test.js
git commit -m "feat: MCP server definitions with encrypted secrets in config store"
```

---

### Task 2: dependency + fixture server + `mcpManager` (TDD)

**Files:**
- Modify: `package.json` (+ lockfile) — `npm install @modelcontextprotocol/sdk`
- Create: `test/fixtures/echo-mcp-server.mjs`
- Create: `src/main/mcpManager.ts`
- Test: `test/mcp-manager.test.js`

**Interfaces:**
- Produces: `createMcpManager({ getServer, resolveSecrets, onStatus })` → `{ connect(id) -> Promise<boolean>, disconnect(id), disconnectAll(), forget(id), getAgentTools() -> { [name]: {description, inputSchema, execute} }, statuses() }`. Task 3 consumes exactly these.

- [ ] **Step 1: Install the SDK and probe its API surface**

```bash
npm install @modelcontextprotocol/sdk
node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log('client:', Object.keys(m).slice(0,5)))"
node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log('server:', Object.keys(m).slice(0,5)))"
```

Expected: both imports resolve (`Client`, `McpServer` present). If the high-level server export lives elsewhere in the installed version, adapt the fixture's import path to the installed SDK (check `node_modules/@modelcontextprotocol/sdk/package.json` exports map) — the fixture's BEHAVIOR (echo + fail tools over stdio) is the contract, its import path is not.

- [ ] **Step 2: Write the fixture server**

```js
// test/fixtures/echo-mcp-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.tool('echo', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}));
server.tool('fail', {}, async () => {
  throw new Error('fixture failure');
});
await server.connect(new StdioServerTransport());
```

(Adapt to the installed SDK's registration API if `server.tool` has been renamed — e.g. `registerTool` — keeping the two tools' names/behavior identical.)

- [ ] **Step 3: Write failing manager tests**

```js
// test/mcp-manager.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMcpManager } = require('../dist/main/mcpManager.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'echo-mcp-server.mjs');

function mkManager(defs, statuses) {
  return createMcpManager({
    getServer: (id) => defs[id],
    resolveSecrets: () => ({}),
    onStatus: (evt) => statuses.push(evt),
  });
}

test('connect fixture: status sequence, tool bridging, echo round-trip, fail tool, disconnect', { timeout: 30000 }, async (t) => {
  const statuses = [];
  const mgr = mkManager({
    fx: { id: 'fx', name: 'Fixture Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: false },
  }, statuses);
  t.after(() => mgr.disconnectAll());

  const ok = await mgr.connect('fx');
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(statuses.map((s) => s.status), ['connecting', 'connected']);
  assert.strictEqual(statuses[1].toolCount, 2);
  assert.deepStrictEqual(mgr.statuses().fx, { status: 'connected', toolCount: 2 });

  const tools = mgr.getAgentTools();
  const names = Object.keys(tools).sort();
  assert.deepStrictEqual(names, ['mcp__Fixture_Srv__echo', 'mcp__Fixture_Srv__fail']);
  assert.strictEqual(tools['mcp__Fixture_Srv__echo'].inputSchema.type, 'object');
  assert.ok(tools['mcp__Fixture_Srv__echo'].inputSchema.properties.text);

  const echoed = await tools['mcp__Fixture_Srv__echo'].execute({ text: 'hi' });
  assert.strictEqual(echoed, 'echo: hi');

  const failed = await tools['mcp__Fixture_Srv__fail'].execute({});
  assert.match(failed, /^Error: /);

  await mgr.disconnect('fx');
  assert.strictEqual(mgr.statuses().fx.status, 'disconnected');
  assert.deepStrictEqual(mgr.getAgentTools(), {});
});

test('connect failure: bad command -> error status, no tools', { timeout: 15000 }, async (t) => {
  const statuses = [];
  const mgr = mkManager({
    bad: { id: 'bad', name: 'Bad', transport: 'stdio', command: '/nonexistent-cmd-xyz', args: [], hasSecrets: false },
  }, statuses);
  const ok = await mgr.connect('bad');
  assert.strictEqual(ok, false);
  assert.strictEqual(statuses[statuses.length - 1].status, 'error');
  assert.ok(statuses[statuses.length - 1].message);
  assert.deepStrictEqual(mgr.getAgentTools(), {});
});

test('decrypt failure with hasSecrets blocks connect', { timeout: 15000 }, async () => {
  const statuses = [];
  const mgr = createMcpManager({
    getServer: () => ({ id: 'x', name: 'X', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: true }),
    resolveSecrets: () => null,
    onStatus: (e) => statuses.push(e),
  });
  const ok = await mgr.connect('x');
  assert.strictEqual(ok, false);
  assert.match(statuses[statuses.length - 1].message, /re-enter/i);
});

test('unknown server id -> error, forget clears status', { timeout: 15000 }, async () => {
  const statuses = [];
  const mgr = mkManager({}, statuses);
  assert.strictEqual(await mgr.connect('nope'), false);
  assert.strictEqual(mgr.statuses().nope.status, 'error');
  mgr.forget('nope');
  assert.strictEqual(mgr.statuses().nope, undefined);
});
```

- [ ] **Step 4: Run to verify failure** — manager module missing.

- [ ] **Step 5: Implement `src/main/mcpManager.ts`**

```ts
// @ts-nocheck

export function createMcpManager({ getServer, resolveSecrets, onStatus }) {
    const connections = new Map(); // id -> { client, tools, serverName }
    const statusMap = {};

    const emit = (id, status, extra = {}) => {
        statusMap[id] = { status, ...extra };
        try { onStatus({ id, status, ...extra }); } catch { /* renderer gone */ }
    };

    const slug = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, '_');

    async function connect(id) {
        const def = getServer(id);
        if (!def) { emit(id, 'error', { message: 'Unknown server' }); return false; }
        if (connections.has(id)) return true;
        emit(id, 'connecting');
        try {
            let secrets = {};
            if (def.hasSecrets) {
                secrets = resolveSecrets(id);
                if (secrets === null) throw new Error('Stored secrets could not be decrypted — re-enter them in the server settings.');
            }
            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
            let transport;
            if (def.transport === 'http') {
                const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
                transport = new StreamableHTTPClientTransport(new URL(def.url), {
                    requestInit: { headers: secrets.headers ?? {} },
                });
            } else {
                const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
                transport = new StdioClientTransport({
                    command: def.command,
                    args: def.args ?? [],
                    env: { ...process.env, ...(secrets.env ?? {}) },
                });
            }
            const client = new Client({ name: 'moon-agent', version: '1.0.0' }, { capabilities: {} });
            transport.onclose = () => {
                if (connections.delete(id)) emit(id, 'disconnected');
            };
            await client.connect(transport);
            const { tools } = await client.listTools();
            connections.set(id, { client, tools, serverName: def.name });
            emit(id, 'connected', { toolCount: tools.length });
            return true;
        } catch (e) {
            connections.delete(id);
            emit(id, 'error', { message: e.message });
            return false;
        }
    }

    async function disconnect(id) {
        const conn = connections.get(id);
        if (!conn) return;
        connections.delete(id);
        try { await conn.client.close(); } catch { /* already dead */ }
        emit(id, 'disconnected');
    }

    return {
        connect,
        disconnect,
        async disconnectAll() {
            for (const id of [...connections.keys()]) await disconnect(id);
        },
        forget(id) {
            delete statusMap[id];
        },
        statuses: () => ({ ...statusMap }),
        getAgentTools() {
            const out = {};
            for (const conn of connections.values()) {
                for (const t of conn.tools) {
                    const name = `mcp__${slug(conn.serverName)}__${t.name}`;
                    if (out[name]) console.warn(`[mcp] tool name collision: ${name}`);
                    out[name] = {
                        description: t.description ?? `${t.name} (from ${conn.serverName})`,
                        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
                        execute: async (args) => {
                            const result = await conn.client.callTool({ name: t.name, arguments: args ?? {} });
                            const parts = result?.content ?? [];
                            const text = parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n');
                            if (result?.isError) return `Error: ${text || 'tool call failed'}`;
                            return text || '(no content)';
                        },
                    };
                }
            }
            return out;
        },
    };
}
```

- [ ] **Step 6: Run to verify pass** — `npm test`: 64/64 (60 + 4). If the fixture hangs, check the SDK server import path per Step 1.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main/mcpManager.ts test/fixtures/echo-mcp-server.mjs test/mcp-manager.test.js
git commit -m "feat: MCP client manager with stdio/http transports and tool bridging"
```

---

### Task 3: agent bridge + IPC + lifecycle (TDD)

**Files:**
- Modify: `src/main/agent.ts`
- Modify: `src/main/main.ts`
- Modify: `src/preload/preload.ts`
- Test: `test/mcp-agent.test.js`

**Interfaces:**
- Consumes: manager from Task 2.
- Produces: `handlePrompt(..., abortSignal?, extraTools?)`; IPC `mcp:list/upsertServer/deleteServer/connect/disconnect` + `mcp:event` push; preload `mcpList/upsertMcpServer/deleteMcpServer/connectMcp/disconnectMcp/onMcpEvent`.

- [ ] **Step 1: Write failing harness test**

```js
// test/mcp-agent.test.js
const test = require('node:test');
const assert = require('node:assert');
const { startServer, textChunks, toolCallChunk, chunk, baseUrlOf } = require('./helpers/fake-openai');
const { handlePrompt } = require('../dist/main/agent.js');

test('extraTools: listed, permission-gated, round-trips', { timeout: 15000 }, async (t) => {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('mcp__fx__echo', { text: 'hi' }), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const extraTools = {
    mcp__fx__echo: {
      description: 'Echo text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (args) => `echo: ${args.text}`,
    },
  };
  const permCalls = [];
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); },
      async (name) => { permCalls.push(name); return true; },
      undefined, extraTools);
  });
  const sentTools = server.requests[0].tools.map((x) => x.function.name);
  assert.ok(sentTools.includes('mcp__fx__echo'));
  const sent = server.requests[0].tools.find((x) => x.function.name === 'mcp__fx__echo');
  assert.ok(sent.function.parameters.properties.text);
  assert.deepStrictEqual(permCalls, ['mcp__fx__echo']);
  const result = events.find((e) => e.type === 'tool_result' && e.name === 'mcp__fx__echo');
  assert.strictEqual(result.result, 'echo: hi');
});

test('extraTools execute throw becomes Error string result', { timeout: 15000 }, async (t) => {
  const server = await startServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? textChunks('done')
      : [toolCallChunk('mcp__fx__boom', {}), chunk({}, 'tool_calls')]);
  t.after(() => server.close());
  const extraTools = {
    mcp__fx__boom: {
      description: 'Always throws', inputSchema: { type: 'object', properties: {} },
      execute: async () => { throw new Error('server exploded'); },
    },
  };
  const events = [];
  await new Promise((resolve) => {
    handlePrompt('go', process.cwd(), { apiKey: 'k', baseUrl: baseUrlOf(server), model: 'mock' }, undefined,
      (e) => { events.push(e); if (e.type === 'done') resolve(); }, async () => true, undefined, extraTools);
  });
  const result = events.find((e) => e.type === 'tool_result' && e.name === 'mcp__fx__boom');
  assert.strictEqual(result.result, 'Error: server exploded');
  assert.strictEqual(events.filter((e) => e.type === 'error').length, 0);
});
```

- [ ] **Step 2: Run to verify failure** — unknown tool.

- [ ] **Step 3: agent.ts**

- Import: extend the `ai` import with `jsonSchema`.
- `makeTools({ ..., abortSignal, extraTools })`; at the END of the function (after the `includeSpawn` block, before `return tools`):

```ts
    if (extraTools) {
        for (const [name, def] of Object.entries(extraTools)) {
            tools[name] = tool({
                description: def.description,
                inputSchema: jsonSchema(def.inputSchema),
                execute: async (args) => {
                    emit({ type: 'tool_call', name, arguments: JSON.stringify(args ?? {}) });
                    if (!await requestPermission(name, args, agentId)) return denied(name);
                    let res;
                    try {
                        res = await def.execute(args);
                    } catch (e) {
                        res = `Error: ${e.message}`;
                    }
                    const out = truncateOutput(typeof res === 'string' ? res : JSON.stringify(res));
                    emit({ type: 'tool_result', name, result: out });
                    return out;
                }
            });
        }
    }
```

- `spawn_agent`'s inner `makeTools` call passes `extraTools` through (subagents inherit MCP tools).
- `handlePrompt(prompt, workspace, settings, history, onEvent, requestPermission, abortSignal, extraTools)` — passes `extraTools` into `makeTools`.

- [ ] **Step 4: main.ts**

Manager creation (inside `whenReady`, after sessionStore):

```ts
const mcpManager = createMcpManager({
    getServer: (id) => configStore.getRedacted().mcpServers.find((s) => s.id === id),
    resolveSecrets: (id) => configStore.resolveMcpSecrets(id),
    onStatus: (evt) => { mainWindow?.webContents.send('mcp:event', evt); },
});
const mcpListShape = () => ({ servers: configStore.getRedacted().mcpServers, statuses: mcpManager.statuses() });

ipcMain.handle('mcp:list', () => mcpListShape());
ipcMain.handle('mcp:upsertServer', (_e, def, rawSecrets) => {
    try { configStore.upsertMcpServer(def, rawSecrets); } catch (e) { console.error('[mcp]', e); }
    return mcpListShape();
});
ipcMain.handle('mcp:deleteServer', async (_e, id) => {
    try { await mcpManager.disconnect(id); mcpManager.forget(id); configStore.deleteMcpServer(id); } catch (e) { console.error('[mcp]', e); }
    return mcpListShape();
});
ipcMain.handle('mcp:connect', async (_e, id) => {
    const ok = await mcpManager.connect(id);
    if (ok) {
        const ids = new Set(configStore.getConfig().connectedMcpIds); ids.add(id);
        configStore.setMcpIds([...ids]);
    }
    return mcpListShape();
});
ipcMain.handle('mcp:disconnect', async (_e, id) => {
    await mcpManager.disconnect(id);
    configStore.setMcpIds(configStore.getConfig().connectedMcpIds.filter((x) => x !== id));
    return mcpListShape();
});
```

- Auto-reconnect after `createWindow()`: `for (const id of configStore.getConfig().connectedMcpIds) mcpManager.connect(id);`
- `app.on('before-quit', () => { mcpManager.disconnectAll(); });`
- `agent:prompt`'s `handlePrompt` call gains the final arg: `mcpManager.getAgentTools()` (after `activeTurn.signal`).
- Import `createMcpManager`.

- [ ] **Step 5: preload.ts**

```ts
mcpList: () => ipcRenderer.invoke('mcp:list'),
upsertMcpServer: (def: any, rawSecrets?: any) => ipcRenderer.invoke('mcp:upsertServer', def, rawSecrets),
deleteMcpServer: (id: string) => ipcRenderer.invoke('mcp:deleteServer', id),
connectMcp: (id: string) => ipcRenderer.invoke('mcp:connect', id),
disconnectMcp: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
onMcpEvent: (callback: (event: any) => void) => {
  ipcRenderer.removeAllListeners('mcp:event');
  ipcRenderer.on('mcp:event', (_event, value) => callback(value));
},
```

- [ ] **Step 6: Verify** — `npm test && npx tsc --noEmit` → 66/66, clean. (Renderer still uses the old mock flow until Task 4 — expected transient state on the feature branch.)

- [ ] **Step 7: Commit**

```bash
git add src/main/agent.ts src/main/main.ts src/preload/preload.ts test/mcp-agent.test.js
git commit -m "feat: bridge MCP tools into the agent with permission gating and IPC lifecycle"
```

---

### Task 4: Renderer — real MCP panel

**Files:**
- Rewrite: `src/renderer/McpPanel.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: preload MCP API (Task 3).
- Produces: UI only. `McpPanel` props: `{open, onClose, servers, statuses, busy, onConnect(id), onDisconnect(id), onEdit(server), onDelete(id), onAdd()}` plus a form modal managed in App (`mcpForm` state) mirroring the profile-form pattern.

- [ ] **Step 1: Rewrite `McpPanel.tsx`**

```tsx
// @ts-nocheck
import React from 'react';
import { X, Globe, Plug, Plus, Loader2, CheckCircle2, XCircle, Pencil, Trash2 } from 'lucide-react';

export default function McpPanel({ open, onClose, servers, statuses, busy, onConnect, onDisconnect, onEdit, onDelete, onAdd }) {
  if (!open) return null;
  const statusIcon = (id) => {
    const st = statuses[id]?.status ?? 'disconnected';
    if (st === 'connected') return <CheckCircle2 size={14} className="mcp-status-connected" />;
    if (st === 'connecting') return <Loader2 size={14} className="mcp-status-connecting" />;
    if (st === 'error') return <XCircle size={14} className="mcp-status-error" title={statuses[id]?.message} />;
    return <XCircle size={14} className="mcp-status-disconnected" />;
  };
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mcp-panel glass-panel">
        <div className="sp-header">
          <div className="sp-header-title"><Globe size={18} /><h3>MCP Servers</h3></div>
          <button className="sp-close" onClick={onClose} aria-label="Close MCP panel"><X size={16} /></button>
        </div>
        <div className="sp-catalog">
          {servers.map((server) => {
            const st = statuses[server.id]?.status ?? 'disconnected';
            const connected = st === 'connected';
            return (
              <div key={server.id} className="mcp-server-row">
                <div className="mcp-server-info">
                  <div className="mcp-server-icon-wrap"><Plug size={16} /></div>
                  <div className="mcp-server-text">
                    <div className="mcp-server-name-row">
                      <span className="mcp-server-name">{server.name}</span>
                      {statusIcon(server.id)}
                    </div>
                    <span className="sp-skill-desc">
                      {server.transport === 'http' ? server.url : `${server.command ?? ''} ${(server.args ?? []).join(' ')}`}
                    </span>
                    <div className="mcp-server-meta">
                      <span className="mcp-meta-tag">{server.transport}</span>
                      {connected && <span className="mcp-meta-tag">{statuses[server.id]?.toolCount ?? 0} tools</span>}
                      {st === 'error' && <span className="mcp-meta-tag mcp-meta-error">{statuses[server.id]?.message?.slice(0, 60)}</span>}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button className="sp-close" aria-label={`Edit ${server.name}`} onClick={() => !busy && onEdit(server)}><Pencil size={14} /></button>
                  <button className="sp-close" aria-label={`Delete ${server.name}`} onClick={() => !busy && onDelete(server.id)}><Trash2 size={14} /></button>
                  <button
                    className={`mcp-toggle-btn ${connected ? 'mcp-toggle-disconnect' : ''}`}
                    onClick={() => !busy && (connected ? onDisconnect(server.id) : onConnect(server.id))}
                    disabled={st === 'connecting'}
                  >
                    {st === 'connecting' ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
                  </button>
                </div>
              </div>
            );
          })}
          {servers.length === 0 && <div className="sp-empty">No MCP servers configured yet.</div>}
        </div>
        <button
          onClick={() => !busy && onAdd()}
          style={{ margin: '12px', background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
        >
          <Plus size={14} /> Add Server
        </button>
      </div>
    </div>
  );
}
```

(Existing CSS classes `mcp-panel`, `mcp-server-row`, `mcp-server-info`, `mcp-server-icon-wrap`, `mcp-server-text`, `mcp-server-name-row`, `mcp-server-name`, `mcp-server-meta`, `mcp-meta-tag`, `mcp-toggle-btn`, `mcp-toggle-disconnect`, `mcp-status-*` already exist from the mock panel. Add to index.css: `.mcp-meta-error { color: var(--warning-color); }`.)

- [ ] **Step 2: App.tsx — state rewiring**

Remove: `MCP_CATALOG` import remnants (McpPanel no longer exports it — delete the catalog from the panel file entirely), the fake-connect `handleToggleMcp` `setTimeout` block, and `applyConfig`'s MCP-restore mapping (main now owns reconnect; `applyConfig` keeps ONLY the skills restore — delete the `servers`/`setMcpServers`/`setMcpStatuses` lines from it).

Add state:

```tsx
const [mcpData, setMcpData] = useState<any>({ servers: [], statuses: {} });
const [mcpForm, setMcpForm] = useState<any>(null); // null closed; {} new; {id,...} edit
```

`mcpServers`/`mcpStatuses` states are DELETED; derive the chip list instead:

```tsx
const connectedMcpServers = mcpData.servers
    .filter((s: any) => mcpData.statuses[s.id]?.status === 'connected')
    .map((s: any) => ({ id: s.id, name: s.name, status: 'connected', tools: mcpData.statuses[s.id]?.toolCount }));
```

`<RichInput mcpServers={connectedMcpServers} ... />`; `handleDisconnectMcp = (id) => window.electron?.disconnectMcp(id).then(setMcpData);`

Startup effect additions (inside the existing guarded startup effect, after `applyConfig(c)`):

```tsx
window.electron?.mcpList?.().then((d: any) => d && setMcpData(d));
window.electron?.onMcpEvent?.((evt: any) => {
    setMcpData((prev: any) => ({ ...prev, statuses: { ...prev.statuses, [evt.id]: { status: evt.status, toolCount: evt.toolCount, message: evt.message } } }));
});
```

Panel wiring (replacing the old McpPanel props):

```tsx
<McpPanel
    open={showMcpPanel}
    onClose={() => setShowMcpPanel(false)}
    servers={mcpData.servers}
    statuses={mcpData.statuses}
    busy={isTyping}
    onConnect={(id) => window.electron?.connectMcp(id).then(setMcpData)}
    onDisconnect={(id) => window.electron?.disconnectMcp(id).then(setMcpData)}
    onEdit={(server) => setMcpForm({ id: server.id, name: server.name, transport: server.transport, command: server.command ?? '', argsText: (server.args ?? []).join(' '), url: server.url ?? '', secretsText: '', hasSecrets: server.hasSecrets })}
    onDelete={(id) => window.electron?.deleteMcpServer(id).then(setMcpData)}
    onAdd={() => setMcpForm({ name: '', transport: 'stdio', command: '', argsText: '', url: '', secretsText: '' })}
/>
```

The MCP panel open button (`onConnectMcp` prop on RichInput / wherever `setShowMcpPanel(true)` fires) additionally refreshes: `window.electron?.mcpList?.().then((d) => d && setMcpData(d));`

- [ ] **Step 3: App.tsx — server form modal**

Rendered when `mcpForm != null` (same modal-overlay/modal-content pattern as the profile form):

```tsx
{mcpForm && (
    <div className="modal-overlay">
        <div className="glass-panel modal-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{mcpForm.id ? 'Edit MCP Server' : 'Add MCP Server'}</h3>
                <X size={18} style={{ cursor: 'pointer' }} onClick={() => setMcpForm(null)} />
            </div>
            <div>
                <label>Name</label>
                <input type="text" value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} placeholder="e.g. GitHub" />
            </div>
            <div>
                <label>Transport</label>
                <select value={mcpForm.transport} onChange={(e) => setMcpForm({ ...mcpForm, transport: e.target.value })}>
                    <option value="stdio">stdio (local command)</option>
                    <option value="http">http (remote URL)</option>
                </select>
            </div>
            {mcpForm.transport === 'stdio' ? (
                <>
                    <div>
                        <label>Command</label>
                        <input type="text" value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} placeholder="npx" />
                    </div>
                    <div>
                        <label>Arguments (space-separated)</label>
                        <input type="text" value={mcpForm.argsText} onChange={(e) => setMcpForm({ ...mcpForm, argsText: e.target.value })} placeholder="-y @modelcontextprotocol/server-github" />
                    </div>
                </>
            ) : (
                <div>
                    <label>URL</label>
                    <input type="text" value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} placeholder="https://example.com/mcp" />
                </div>
            )}
            <div>
                <label>{mcpForm.transport === 'stdio' ? 'Environment (KEY=value per line)' : 'Headers (Name: value per line)'}</label>
                <textarea
                    className="mcp-secrets-input"
                    rows={3}
                    value={mcpForm.secretsText}
                    onChange={(e) => setMcpForm({ ...mcpForm, secretsText: e.target.value })}
                    placeholder={mcpForm.hasSecrets ? '•••••••• (leave blank to keep)' : mcpForm.transport === 'stdio' ? 'GITHUB_TOKEN=ghp_…' : 'Authorization: Bearer …'}
                />
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                <button className="glass-panel" style={{ padding: '10px', cursor: 'pointer', color: 'var(--text-primary)', flexGrow: 1 }} onClick={() => setMcpForm(null)}>Cancel</button>
                <button
                    style={{ background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, flexGrow: 1 }}
                    disabled={!mcpForm.name.trim() || (mcpForm.transport === 'stdio' ? !mcpForm.command.trim() : !mcpForm.url.trim())}
                    onClick={() => {
                        const def = {
                            id: mcpForm.id, name: mcpForm.name.trim(), transport: mcpForm.transport,
                            command: mcpForm.transport === 'stdio' ? mcpForm.command.trim() : undefined,
                            args: mcpForm.transport === 'stdio' ? mcpForm.argsText.trim().split(/\s+/).filter(Boolean) : undefined,
                            url: mcpForm.transport === 'http' ? mcpForm.url.trim() : undefined,
                        };
                        let rawSecrets;
                        const lines = mcpForm.secretsText.split('\n').map((l: string) => l.trim()).filter(Boolean);
                        if (lines.length > 0) {
                            if (mcpForm.transport === 'stdio') {
                                const env = {};
                                for (const l of lines) { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1); }
                                rawSecrets = { env };
                            } else {
                                const headers = {};
                                for (const l of lines) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
                                rawSecrets = { headers };
                            }
                        }
                        window.electron?.upsertMcpServer(def, rawSecrets).then((d: any) => { setMcpData(d); setMcpForm(null); });
                    }}
                >
                    Save Server
                </button>
            </div>
        </div>
    </div>
)}
```

index.css additions:

```css
.mcp-secrets-input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: rgba(0, 0, 0, 0.4);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  resize: vertical;
}
.mcp-meta-error {
  color: var(--warning-color);
}
```

Also delete `handleToggleMcp` and the `McpServerEntry` import if now unused; `SkillsPanel` flow untouched.

- [ ] **Step 4: Verify** — `npx tsc --noEmit && npx vite build && npm test` → clean, 66/66.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/McpPanel.tsx src/renderer/App.tsx src/renderer/index.css
git commit -m "feat: real MCP server management panel with live statuses"
```
