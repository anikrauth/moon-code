# Model Profiles + Persistent Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple named model profiles (provider+model+key) switchable from the input bar, skills/MCP selections that survive restarts, API keys encrypted via Electron safeStorage and never sent to the renderer.

**Architecture:** New main-process `configStore` module owns `config.json` in `userData` (keys stored encrypted). Renderer receives only a redacted view over `ipcRenderer.invoke` channels and sends `profileId` with prompts; main decrypts at call time and hands `handlePrompt` the same `settings` object it takes today (agent.ts untouched).

**Tech Stack:** Electron main (CommonJS TS via `tsc -p tsconfig.main.json`), `safeStorage`, React 19 renderer (Vite), node:test with injected fake safeStorage.

## Global Constraints

- All source files start with `// @ts-nocheck`; keep the convention.
- Redacted config crossing IPC must NEVER contain `apiKeyEnc` or `enc` — profiles carry `hasKey: boolean` instead.
- `upsertProfile(profile, rawApiKey)`: empty/undefined `rawApiKey` on an EXISTING profile keeps the stored key; on a new profile yields `hasKey: false`.
- `agent:prompt` renderer→main payload becomes `(prompt, workspace, profileId, history)`; `handlePrompt`'s own signature is unchanged.
- Config file: `config.json` under the injected `dir`; atomic write = write `config.json.tmp` then rename.
- Corrupt/missing config file → empty config `{ version: 1, profiles: [], activeProfileId: null, activeSkillIds: [], connectedMcpIds: [] }`, never a throw.
- `safeStorage.isEncryptionAvailable() === false` → base64-plain storage with `enc: false` and one `console.warn`.
- Tests must not require Electron: `createConfigStore({ dir, safeStorage })` takes safeStorage injected; tests pass a fake.
- `npm test` = `tsc -p tsconfig.main.json && node --test test/*.test.js`; fake-server tests use `t.after(() => server.close())`.

---

### Task 1: `configStore` module with unit tests (TDD)

**Files:**
- Create: `src/main/configStore.ts`
- Test: `test/config-store.test.js`

**Interfaces:**
- Produces: `createConfigStore({ dir, safeStorage })` returning `{ getConfig(), getRedacted(), upsertProfile(profile, rawApiKey?) -> id, deleteProfile(id), setActiveProfile(id), setSkillIds(ids), setMcpIds(ids), resolveSettings(profileId) -> { apiKey, model, baseUrl } | null }`. Task 2 consumes exactly these names.

- [ ] **Step 1: Write the failing tests**

```js
// test/config-store.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createConfigStore } = require('../dist/main/configStore.js');

// Reversible fake: "ENC(" + base64 + ")"
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC(${s})`, 'utf-8'),
  decryptString: (buf) => {
    const m = buf.toString('utf-8').match(/^ENC\((.*)\)$/s);
    if (!m) throw new Error('bad ciphertext');
    return m[1];
  },
};

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'moon-cfg-'));
const mkStore = (dir) => createConfigStore({ dir, safeStorage: fakeSafeStorage });

test('round-trip: two profiles survive reload; switching active mutates nothing else', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s1 = mkStore(dir);
  const idA = s1.upsertProfile({ name: 'GPT', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '' }, 'key-a');
  const idB = s1.upsertProfile({ name: 'GLM', provider: 'Zhipu AI (GLM)', model: 'glm-4', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, 'key-b');
  s1.setActiveProfile(idB);
  const s2 = mkStore(dir); // fresh load from disk
  const cfg = s2.getConfig();
  assert.strictEqual(cfg.profiles.length, 2);
  assert.strictEqual(cfg.activeProfileId, idB);
  assert.deepStrictEqual(s2.resolveSettings(idA), { apiKey: 'key-a', model: 'gpt-4o', baseUrl: '' });
  assert.deepStrictEqual(s2.resolveSettings(idB), { apiKey: 'key-b', model: 'glm-4', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' });
});

test('first upsert auto-activates; redaction strips key material everywhere', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile({ name: 'GPT', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '' }, 'sekrit');
  const red = s.getRedacted();
  assert.strictEqual(red.activeProfileId, id);
  assert.strictEqual(red.profiles[0].hasKey, true);
  const json = JSON.stringify(red);
  assert.ok(!json.includes('apiKeyEnc') && !json.includes('sekrit') && !json.includes('ENC('));
});

test('update with empty rawApiKey keeps existing key; other fields update', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile({ name: 'GPT', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '' }, 'orig-key');
  s.upsertProfile({ id, name: 'GPT renamed', provider: 'OpenAI', model: 'gpt-4o-mini', baseUrl: '' });
  assert.deepStrictEqual(s.resolveSettings(id), { apiKey: 'orig-key', model: 'gpt-4o-mini', baseUrl: '' });
  assert.strictEqual(s.getRedacted().profiles[0].name, 'GPT renamed');
});

test('new profile without key -> hasKey false, resolveSettings null', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile({ name: 'Keyless', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '' });
  assert.strictEqual(s.getRedacted().profiles[0].hasKey, false);
  assert.strictEqual(s.resolveSettings(id), null);
});

test('deleting active profile falls back to first remaining, then null', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const idA = s.upsertProfile({ name: 'A', provider: 'OpenAI', model: 'a', baseUrl: '' }, 'k');
  const idB = s.upsertProfile({ name: 'B', provider: 'OpenAI', model: 'b', baseUrl: '' }, 'k');
  s.setActiveProfile(idB);
  s.deleteProfile(idB);
  assert.strictEqual(s.getConfig().activeProfileId, idA);
  s.deleteProfile(idA);
  assert.strictEqual(s.getConfig().activeProfileId, null);
});

test('corrupt config file -> empty config, no throw', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), '{not json!!!', 'utf-8');
  const s = mkStore(dir);
  assert.deepStrictEqual(s.getConfig(), { version: 1, profiles: [], activeProfileId: null, activeSkillIds: [], connectedMcpIds: [] });
});

test('setActiveProfile with unknown id is a no-op; resolveSettings unknown id null', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile({ name: 'A', provider: 'OpenAI', model: 'a', baseUrl: '' }, 'k');
  s.setActiveProfile('p-nope');
  assert.strictEqual(s.getConfig().activeProfileId, id);
  assert.strictEqual(s.resolveSettings('p-nope'), null);
});

test('skill and mcp id lists persist across reload', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s1 = mkStore(dir);
  s1.setSkillIds(['web-search', 'git-ops']);
  s1.setMcpIds(['github']);
  const s2 = mkStore(dir);
  assert.deepStrictEqual(s2.getConfig().activeSkillIds, ['web-search', 'git-ops']);
  assert.deepStrictEqual(s2.getConfig().connectedMcpIds, ['github']);
});

test('encryption-unavailable fallback stores base64 with enc:false and still resolves', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const noEnc = { ...fakeSafeStorage, isEncryptionAvailable: () => false };
  const s = createConfigStore({ dir, safeStorage: noEnc });
  const id = s.upsertProfile({ name: 'A', provider: 'OpenAI', model: 'a', baseUrl: '' }, 'plain-key');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
  assert.strictEqual(raw.profiles[0].enc, false);
  assert.strictEqual(Buffer.from(raw.profiles[0].apiKeyEnc, 'base64').toString('utf-8'), 'plain-key');
  assert.deepStrictEqual(s.resolveSettings(id), { apiKey: 'plain-key', model: 'a', baseUrl: '' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: config-store tests FAIL with `Cannot find module '../dist/main/configStore.js'`.

- [ ] **Step 3: Implement `src/main/configStore.ts`**

```ts
// @ts-nocheck
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const emptyConfig = () => ({
    version: 1,
    profiles: [],
    activeProfileId: null,
    activeSkillIds: [],
    connectedMcpIds: [],
});

export function createConfigStore({ dir, safeStorage }) {
    const file = path.join(dir, 'config.json');
    let config = load();

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.profiles)) return emptyConfig();
            return { ...emptyConfig(), ...parsed };
        } catch {
            return emptyConfig();
        }
    }

    function persist() {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }

    function encryptKey(raw) {
        if (safeStorage.isEncryptionAvailable()) {
            return { apiKeyEnc: safeStorage.encryptString(raw).toString('base64'), enc: true };
        }
        console.warn('[moon-agent] OS encryption unavailable; storing API key base64-encoded only.');
        return { apiKeyEnc: Buffer.from(raw, 'utf-8').toString('base64'), enc: false };
    }

    function decryptKey(profile) {
        const buf = Buffer.from(profile.apiKeyEnc, 'base64');
        return profile.enc ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    }

    return {
        getConfig: () => config,

        getRedacted() {
            return {
                version: config.version,
                activeProfileId: config.activeProfileId,
                activeSkillIds: [...config.activeSkillIds],
                connectedMcpIds: [...config.connectedMcpIds],
                profiles: config.profiles.map(({ apiKeyEnc, enc, ...rest }) => ({ ...rest, hasKey: !!apiKeyEnc })),
            };
        },

        upsertProfile(profile, rawApiKey) {
            const existing = profile.id ? config.profiles.find(p => p.id === profile.id) : null;
            const id = existing ? existing.id : `p-${randomUUID()}`;
            const base = {
                id,
                name: profile.name,
                provider: profile.provider,
                model: profile.model,
                baseUrl: profile.baseUrl ?? '',
            };
            let keyFields;
            if (rawApiKey) keyFields = encryptKey(rawApiKey);
            else if (existing) keyFields = { apiKeyEnc: existing.apiKeyEnc, enc: existing.enc };
            else keyFields = { apiKeyEnc: null, enc: false };
            const next = { ...base, ...keyFields };
            if (existing) config.profiles = config.profiles.map(p => (p.id === id ? next : p));
            else config.profiles.push(next);
            if (!config.activeProfileId) config.activeProfileId = id;
            persist();
            return id;
        },

        deleteProfile(id) {
            config.profiles = config.profiles.filter(p => p.id !== id);
            if (config.activeProfileId === id) {
                config.activeProfileId = config.profiles[0]?.id ?? null;
            }
            persist();
        },

        setActiveProfile(id) {
            if (!config.profiles.some(p => p.id === id)) return;
            config.activeProfileId = id;
            persist();
        },

        setSkillIds(ids) {
            config.activeSkillIds = [...ids];
            persist();
        },

        setMcpIds(ids) {
            config.connectedMcpIds = [...ids];
            persist();
        },

        resolveSettings(profileId) {
            const p = config.profiles.find(x => x.id === profileId);
            if (!p || !p.apiKeyEnc) return null;
            try {
                const apiKey = decryptKey(p);
                if (!apiKey) return null;
                return { apiKey, model: p.model, baseUrl: p.baseUrl };
            } catch {
                return null;
            }
        },
    };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all config-store tests PASS; existing 6 agent tests still pass (15 total).

- [ ] **Step 5: Commit**

```bash
git add src/main/configStore.ts test/config-store.test.js
git commit -m "feat: main-process config store with safeStorage-encrypted profiles"
```

---

### Task 2: IPC wiring — main.ts handlers, preload API, profileId prompts

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/preload/preload.ts`

**Interfaces:**
- Consumes: `createConfigStore` from Task 1.
- Produces: `window.electron.getConfig/upsertProfile/deleteProfile/setActiveProfile/setSkillIds/setMcpIds` (all invoke, all returning the fresh redacted config) and `sendPrompt(prompt, workspace, profileId, history)`. Tasks 3-4 consume these exact names.

- [ ] **Step 1: main.ts — create store and register handlers**

Inside `app.whenReady().then(() => { ... })`, before the `agent:prompt` handler, add:

```ts
const configStore = createConfigStore({ dir: app.getPath('userData'), safeStorage });

const configHandler = (fn) => (_event, ...args) => {
    try { fn(...args); } catch (e) { console.error('[config]', e); }
    return configStore.getRedacted();
};
ipcMain.handle('config:get', () => configStore.getRedacted());
ipcMain.handle('config:upsertProfile', configHandler((profile, rawApiKey) => configStore.upsertProfile(profile, rawApiKey)));
ipcMain.handle('config:deleteProfile', configHandler((id) => configStore.deleteProfile(id)));
ipcMain.handle('config:setActiveProfile', configHandler((id) => configStore.setActiveProfile(id)));
ipcMain.handle('config:setSkillIds', configHandler((ids) => configStore.setSkillIds(ids)));
ipcMain.handle('config:setMcpIds', configHandler((ids) => configStore.setMcpIds(ids)));
```

Imports: add `safeStorage` to the electron import; add `import { createConfigStore } from './configStore';`.

- [ ] **Step 2: main.ts — agent:prompt takes profileId**

Replace the `agent:prompt` listener's signature and settings resolution (the `requestPermission` closure and `handlePrompt` call stay identical):

```ts
ipcMain.on('agent:prompt', (event, prompt: string, workspace: string, profileId: string, history: any) => {
    const settings = configStore.resolveSettings(profileId);
    if (!settings) {
        event.reply('agent:event', { type: 'error', agent: 'main', content: 'Selected model profile has no API key. Open Settings and configure one.' });
        event.reply('agent:event', { type: 'done' });
        return;
    }
    // ...existing requestPermission definition and handlePrompt(prompt, workspace, settings, history, ..., requestPermission) unchanged...
});
```

- [ ] **Step 3: preload.ts — expose the API**

Replace `sendPrompt` line and append config methods:

```ts
sendPrompt: (prompt: string, workspace: string, profileId: string, history: any) => ipcRenderer.send('agent:prompt', prompt, workspace, profileId, history),
getConfig: () => ipcRenderer.invoke('config:get'),
upsertProfile: (profile: any, rawApiKey?: string) => ipcRenderer.invoke('config:upsertProfile', profile, rawApiKey),
deleteProfile: (id: string) => ipcRenderer.invoke('config:deleteProfile', id),
setActiveProfile: (id: string) => ipcRenderer.invoke('config:setActiveProfile', id),
setSkillIds: (ids: string[]) => ipcRenderer.invoke('config:setSkillIds', ids),
setMcpIds: (ids: string[]) => ipcRenderer.invoke('config:setMcpIds', ids),
```

- [ ] **Step 4: Verify**

Run: `npm test && npx tsc --noEmit`
Expected: 15/15 tests pass (agent suite calls `handlePrompt` directly — unaffected); typecheck clean. Note: the renderer still calls the OLD `sendPrompt(prompt, workspace, settings, history)` until Task 3 — that renders the app transiently broken at runtime between Tasks 2 and 3; acceptable on a feature branch, do NOT try to shim it.

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts src/preload/preload.ts
git commit -m "feat: config IPC surface and profileId-based prompts"
```

---

### Task 3: Renderer — config state, profile manager, migration, skills/MCP persistence

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/SkillsPanel.tsx` (export `SKILL_CATALOG`)
- Modify: `src/renderer/McpPanel.tsx` (export `MCP_CATALOG`)

**Interfaces:**
- Consumes: `window.electron.*` config API from Task 2; `SKILL_CATALOG`/`MCP_CATALOG` exports added here.
- Produces: App state `config` (redacted shape), `activeProfile` derivation, `applyConfig(c)` helper. Task 4 consumes `config.profiles`, `config.activeProfileId`, and a `handleSelectProfile(id)` callback passed to RichInput.

- [ ] **Step 1: Export the catalogs**

In `SkillsPanel.tsx`: `const SKILL_CATALOG` → `export const SKILL_CATALOG`. In `McpPanel.tsx`: `const MCP_CATALOG` → `export const MCP_CATALOG`.

- [ ] **Step 2: Replace settings state with config state**

In `App.tsx` remove the `settings` useState (and its localStorage initializer) and `AppSettings` interface usage; add:

```tsx
const [config, setConfig] = useState<any>(null);
const [profileForm, setProfileForm] = useState<any>(null); // null = closed; {} = new; {id,...} = edit

const applyConfig = (c: any) => {
    setConfig(c);
    setActiveSkills(
        c.activeSkillIds
            .map((id: string) => SKILL_CATALOG.find((s) => s.id === id))
            .filter(Boolean)
            .map((s: any) => ({ id: s.id, name: s.name, description: s.description }))
    );
    const servers = c.connectedMcpIds
        .map((id: string) => MCP_CATALOG.find((m) => m.id === id))
        .filter(Boolean)
        .map((m: any) => ({ id: m.id, name: m.name, status: 'connected', tools: m.tools }));
    setMcpServers(servers);
    setMcpStatuses(Object.fromEntries(servers.map((s: any) => [s.id, 'connected'])));
};
```

Imports: add `import { SKILL_CATALOG } from './SkillsPanel';` (merge with existing SkillsPanel import) and `MCP_CATALOG` likewise.

- [ ] **Step 3: Startup load + one-time migration**

```tsx
useEffect(() => {
    (async () => {
        if (!window.electron?.getConfig) return;
        let c = await window.electron.getConfig();
        if (c.profiles.length === 0) {
            try {
                const saved = localStorage.getItem('moon-agent-settings');
                if (saved) {
                    const old = JSON.parse(saved);
                    if (old.apiKey) {
                        c = await window.electron.upsertProfile(
                            { name: 'Default', provider: old.provider || 'OpenAI', model: old.model || 'gpt-4o', baseUrl: old.baseUrl || '' },
                            old.apiKey
                        );
                    }
                    localStorage.removeItem('moon-agent-settings');
                }
            } catch {
                // unparseable legacy settings — drop them
                localStorage.removeItem('moon-agent-settings');
            }
        }
        applyConfig(c);
    })();
}, []);
```

- [ ] **Step 4: Send path + gating**

```tsx
const activeProfile = config?.profiles.find((p: any) => p.id === config.activeProfileId) ?? null;
```

`handleSend`: guard becomes `if (!input.trim() || !workspace || !activeProfile?.hasKey) return;` and the send call becomes `window.electron?.sendPrompt(input, workspace, config.activeProfileId, history);`.

`inputDisabled` = `!workspace || isTyping || !activeProfile?.hasKey`. `inputPlaceholder` chain: no workspace → existing text; else no `activeProfile?.hasKey` → `'Add a model profile in Settings…'`; else existing text.

- [ ] **Step 5: Skills/MCP handlers persist**

Each existing toggle/remove/disconnect handler additionally pushes the new id list. Fire-and-forget persistence (avoids feedback loops) — apply to all four sites (`handleToggleSkill`, `handleRemoveSkill`, `handleToggleMcp` both branches, `handleDisconnectMcp`): call `window.electron?.setSkillIds(next.map(s => s.id))` / `setMcpIds(...)` right after computing the `next` array inside each handler, keep the local `setActiveSkills(next)` / `setMcpServers(next)` state updates as the source of UI truth, and do NOT re-apply the returned config (applyConfig runs only at startup). Concretely, e.g.:

```tsx
const handleToggleSkill = (skill: SkillEntry) => {
    setActiveSkills((prev) => {
        const exists = prev.find((s) => s.id === skill.id);
        const next = exists
            ? prev.filter((s) => s.id !== skill.id)
            : [...prev, { id: skill.id, name: skill.name, description: skill.description }];
        window.electron?.setSkillIds(next.map((s) => s.id));
        return next;
    });
};
```

Same shape for MCP: in `handleToggleMcp`'s disconnect branch and `handleDisconnectMcp`, call `window.electron?.setMcpIds(next.map(s => s.id))` with the filtered list; in the connect `setTimeout`, after adding the server, call `window.electron?.setMcpIds([...prev.map(s => s.id), server.id])` using the updater's computed array (compute `next` first, persist, return it).

- [ ] **Step 6: Settings modal → profile manager**

Replace the modal's body (between the header row and nothing — the whole form) with:

```tsx
{!profileForm ? (
    <>
        {config?.profiles.length === 0 && (
            <p style={{ color: 'var(--text-secondary)' }}>No model profiles yet. Add one to start chatting.</p>
        )}
        {config?.profiles.map((p: any) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                <input type="radio" name="active-profile" checked={p.id === config.activeProfileId}
                    onChange={() => window.electron?.setActiveProfile(p.id).then(setConfig)} />
                <div style={{ flexGrow: 1 }}>
                    <div style={{ fontWeight: 600 }}>{p.name}{!p.hasKey && <span style={{ color: 'salmon', fontSize: '11px', marginLeft: '6px' }}>no key</span>}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{p.provider} · {p.model}</div>
                </div>
                <button className="glass-panel" style={{ padding: '4px 10px', cursor: 'pointer', color: 'var(--text-primary)' }}
                    onClick={() => setProfileForm({ id: p.id, name: p.name, provider: p.provider, model: p.model, baseUrl: p.baseUrl, apiKey: '', hasKey: p.hasKey })}>
                    Edit
                </button>
                <button className="glass-panel" style={{ padding: '4px 10px', cursor: 'pointer', color: 'salmon' }}
                    onClick={() => window.electron?.deleteProfile(p.id).then(setConfig)}>
                    Delete
                </button>
            </div>
        ))}
        <button onClick={() => setProfileForm({ name: '', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', apiKey: '' })}
            style={{ background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, marginTop: '10px' }}>
            Add Profile
        </button>
    </>
) : (
    <>
        <div>
            <label>Profile Name</label>
            <input type="text" value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} placeholder="e.g. GPT-4o (work)" />
        </div>
        <div>
            <label>Provider</label>
            <select value={profileForm.provider}
                onChange={(e) => {
                    const opt = providerOptions.find((p) => p.label === e.target.value);
                    setProfileForm(profileForm.id
                        ? { ...profileForm, provider: e.target.value } // editing: never clobber saved fields
                        : { ...profileForm, provider: e.target.value, baseUrl: opt?.defaultBase || '', model: opt?.defaultModel || '' });
                }}>
                {providerOptions.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
        </div>
        <div>
            <label>Model Name</label>
            <input type="text" value={profileForm.model} onChange={(e) => setProfileForm({ ...profileForm, model: e.target.value })} placeholder="e.g. gpt-4o" />
        </div>
        <div>
            <label>Base URL (Optional)</label>
            <input type="text" value={profileForm.baseUrl} onChange={(e) => setProfileForm({ ...profileForm, baseUrl: e.target.value })} placeholder="Override endpoint URL..." />
        </div>
        <div>
            <label>API Key</label>
            <input type="password" value={profileForm.apiKey} onChange={(e) => setProfileForm({ ...profileForm, apiKey: e.target.value })}
                placeholder={profileForm.hasKey ? '•••••••• (leave blank to keep)' : 'Enter your API Key...'} />
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
            <button className="glass-panel" style={{ padding: '10px', cursor: 'pointer', color: 'var(--text-primary)', flexGrow: 1 }} onClick={() => setProfileForm(null)}>Cancel</button>
            <button
                style={{ background: 'var(--accent-color)', color: '#000', border: 'none', borderRadius: '8px', padding: '10px', cursor: 'pointer', fontWeight: 600, flexGrow: 1 }}
                disabled={!profileForm.name.trim() || !profileForm.model.trim()}
                onClick={() => {
                    const { apiKey, hasKey, ...profile } = profileForm;
                    window.electron?.upsertProfile(profile, apiKey || undefined).then((c) => { setConfig(c); setProfileForm(null); });
                }}>
                Save Profile
            </button>
        </div>
    </>
)}
```

`handleSaveSettings` is deleted (no longer referenced). `providerOptions` array stays as-is.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vite build && npm test`
Expected: clean build, 15/15 pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.tsx src/renderer/SkillsPanel.tsx src/renderer/McpPanel.tsx
git commit -m "feat: profile manager UI, config-backed skills/MCP persistence, settings migration"
```

---

### Task 4: Model switcher in the input bar

**Files:**
- Modify: `src/renderer/RichInput.tsx`
- Modify: `src/renderer/App.tsx` (pass 3 new props)

**Interfaces:**
- Consumes: `config.profiles` (redacted: `{id, name, provider, model, hasKey}`), `config.activeProfileId` from Task 3.
- Produces: `RichInput` props `profiles: {id,name}[]`, `activeProfileId: string | null`, `onSelectProfile: (id: string) => void`.

- [ ] **Step 1: RichInput — add props and dropdown**

Add to `RichInputProps` and the destructured params: `profiles`, `activeProfileId`, `onSelectProfile`. In the toolbar's `ri-toolbar-left` div, FIRST child (before the Skills button):

```tsx
{profiles.length > 0 && (
    <select
        className="ri-toolbar-btn"
        style={{ maxWidth: '160px', cursor: 'pointer' }}
        value={activeProfileId ?? ''}
        onChange={(e) => onSelectProfile(e.target.value)}
        disabled={disabled && profiles.length < 2}
        title="Switch model"
    >
        {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
        ))}
    </select>
)}
```

Note: the select stays enabled while typing is disabled-for-missing-key so the user can switch TO a working profile; it only disables when there is nothing to switch between.

- [ ] **Step 2: App.tsx — wire the props**

In the `<RichInput ... />` element add:

```tsx
profiles={config?.profiles ?? []}
activeProfileId={config?.activeProfileId ?? null}
onSelectProfile={(id) => window.electron?.setActiveProfile(id).then(setConfig)}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vite build && npm test`
Expected: clean, 15/15 pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/RichInput.tsx src/renderer/App.tsx
git commit -m "feat: model profile switcher in input bar"
```
