# Model Profiles + Persistent Skills/MCP Config — Design

Date: 2026-07-02
Status: Approved

## Problem

- Switching provider in Settings overwrites the previous provider's baseUrl/model/key — configuration is lost.
- Only one model can be configured at a time; no way to keep several and switch.
- Active skills and connected MCP servers reset on every app launch.
- API keys sit in plaintext `localStorage`.

## Goal

Multiple named model profiles across providers, switchable from the input bar; skills/MCP selections that survive restarts; API keys encrypted with Electron `safeStorage` and never exposed to the renderer.

## Architecture

Main process owns all configuration. Renderer sees a **redacted** view (no key material) and mutates config through IPC. `agent:prompt` sends a `profileId`; the main process resolves the profile and decrypts the key at call time. `src/main/agent.ts` is unchanged — it keeps receiving the same `settings` object shape.

### 1. Config schema — `config.json` in `app.getPath('userData')`

```json
{
  "version": 1,
  "profiles": [
    { "id": "p-<uuid>", "name": "GPT-4o (work)", "provider": "OpenAI",
      "model": "gpt-4o", "baseUrl": "", "apiKeyEnc": "<base64>", "enc": true }
  ],
  "activeProfileId": "p-…",
  "activeSkillIds": ["web-search"],
  "connectedMcpIds": ["github"]
}
```

- One profile = one model entry (name, provider, model, baseUrl, key). Two models on the same provider are two profiles; the key is entered twice (no shared-credential indirection — YAGNI).
- `apiKeyEnc`: `safeStorage.encryptString(key)` as base64 when `safeStorage.isEncryptionAvailable()`; otherwise plain base64 with `enc: false` (fallback for Linux CI; a one-time console warning in main).
- Missing/corrupt file → empty config `{ version: 1, profiles: [], activeProfileId: null, activeSkillIds: [], connectedMcpIds: [] }`.

### 2. Main process — `src/main/configStore.ts`

Factory `createConfigStore({ dir, safeStorage })` (dependencies injected for testability) exposing:

- `getConfig()` → full config (internal use).
- `getRedacted()` → config with each profile's `apiKeyEnc`/`enc` replaced by `hasKey: boolean`. This is the ONLY shape that crosses IPC to the renderer.
- `upsertProfile(profile, rawApiKey?)` → insert or update by `id`; when `rawApiKey` is undefined/empty on update, the existing encrypted key is KEPT (edit without re-entering key); a new profile without a key gets `hasKey: false`.
- `deleteProfile(id)` → removes; if it was active, `activeProfileId` becomes the first remaining profile's id or null.
- `setActiveProfile(id)` → no-op if id unknown.
- `setSkillIds(ids: string[])`, `setMcpIds(ids: string[])`.
- `resolveSettings(profileId)` → `{ apiKey, model, baseUrl }` with the key decrypted — consumed only by the `agent:prompt` handler; returns null if profile missing or key absent.
- Every mutator persists synchronously to `config.json` (atomic write: temp file + rename).

### 3. IPC surface (main.ts + preload)

| Channel | Direction | Payload → Result |
|---|---|---|
| `config:get` | invoke | → redacted config |
| `config:upsertProfile` | invoke | `(profile, rawApiKey?)` → redacted config |
| `config:deleteProfile` | invoke | `(id)` → redacted config |
| `config:setActiveProfile` | invoke | `(id)` → redacted config |
| `config:setSkillIds` | invoke | `(ids)` → redacted config |
| `config:setMcpIds` | invoke | `(ids)` → redacted config |

All mutators return the fresh redacted config so the renderer state is always the store's echo.

`agent:prompt` changes: `(prompt, workspace, profileId, history)` — main calls `resolveSettings(profileId)`; if null, replies with an `error` event ("Profile has no API key configured") + `done`.

### 4. Renderer

- **App state**: `config` (redacted) replaces the old `settings` state; loaded once at startup via `config:get`.
- **Settings modal → profile manager**: list of profiles (name, provider · model, active indicator, Edit, Delete) + "Add profile" form (name, provider select, model, baseUrl, API key). Provider select only pre-fills defaults in the form for NEW profiles — editing never auto-overwrites saved values. Key input shows placeholder `••••••••` when `hasKey`; leaving it blank on edit keeps the stored key.
- **Model switcher in input bar**: dropdown chip in `RichInput` toolbar (left of Skills button) listing profile names, active one checked; selection calls `config:setActiveProfile`. RichInput receives `profiles`, `activeProfileId`, `onSelectProfile` props.
- **Send gating**: input disabled when no active profile or active profile `hasKey === false`; placeholder text guides ("Add a model profile in Settings…").
- **Skills/MCP**: toggle handlers additionally call `config:setSkillIds`/`config:setMcpIds` with the new id list; startup effect restores `activeSkills` (ids mapped through `SKILL_CATALOG`) and `mcpServers`/`mcpStatuses` (ids mapped through `MCP_CATALOG`, status `connected` immediately — no fake connecting delay on restore). Persisted ids not present in a catalog are silently dropped (and pruned on next save).

### 5. Migration

On startup, after `config:get`: if config has zero profiles AND `localStorage['moon-agent-settings']` parses with a non-empty `apiKey`, the renderer creates a "Default" profile from it (`config:upsertProfile` with the raw key), sets it active, and deletes the localStorage entry. One-way, one-time.

## Error handling

- Corrupt `config.json` → replaced by empty config on next write; app starts clean rather than crashing.
- `safeStorage.decryptString` throw (e.g. keychain changed) → `resolveSettings` returns null → user-visible error event, profile edit re-entering the key repairs it.
- IPC handlers wrap store calls in try/catch and return the current redacted config on failure.

## Testing

`test/config-store.test.js` (node:test, real compiled `dist/main/configStore.js`, temp dir per test, fake safeStorage = reversible base64 with prefix):

1. Round-trip: upsert two profiles (different providers) → reload from disk → both intact; switching active never mutates profile fields.
2. Redaction: `getRedacted()` output contains no `apiKeyEnc` anywhere; `hasKey` correct.
3. Key-keep: update profile with empty rawApiKey → `resolveSettings` still returns original key.
4. Delete active profile → activeProfileId falls back to first remaining / null.
5. Corrupt file on disk → `getConfig()` returns empty config, no throw.
6. `resolveSettings` on unknown id / keyless profile → null.
7. Skill/MCP id lists persist across reload.

Renderer/IPC layer: `npx tsc --noEmit && npx vite build` + existing agent suite still passing (agent:prompt path covered indirectly: `handlePrompt` signature unchanged; the harness keeps calling it directly).

## Out of scope

- Real MCP connections / skills affecting the agent (selections persist; behavior unchanged).
- Shared credentials between profiles.
- Config sync/export, multiple workspaces with different configs.
- Editable skill/MCP catalogs.
