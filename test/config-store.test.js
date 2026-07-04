// test/config-store.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createConfigStore } = require('../dist/main/features/config/configStore.js');

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
  assert.deepStrictEqual(s.getConfig(), { version: 1, profiles: [], activeProfileId: null, connectedMcpIds: [], mcpServers: [] });
});

test('setActiveProfile with unknown id is a no-op; resolveSettings unknown id null', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile({ name: 'A', provider: 'OpenAI', model: 'a', baseUrl: '' }, 'k');
  s.setActiveProfile('p-nope');
  assert.strictEqual(s.getConfig().activeProfileId, id);
  assert.strictEqual(s.resolveSettings('p-nope'), null);
});

test('mcp id list persists across reload', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s1 = mkStore(dir);
  s1.setMcpIds(['github']);
  const s2 = mkStore(dir);
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

test('limit overrides round-trip through upsert, redaction, and resolveSettings', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s1 = mkStore(dir);
  const id = s1.upsertProfile(
    { name: 'GPT', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', contextWindow: 64000, maxOutputTokens: 2048 },
    'key-a'
  );
  const red = s1.getRedacted();
  assert.strictEqual(red.profiles[0].contextWindow, 64000);
  assert.strictEqual(red.profiles[0].maxOutputTokens, 2048);
  const s2 = mkStore(dir); // survives reload
  assert.deepStrictEqual(s2.resolveSettings(id), {
    apiKey: 'key-a', model: 'gpt-4o', baseUrl: '', contextWindow: 64000, maxOutputTokens: 2048,
  });
});

test('absent or garbage limit overrides stored as null and omitted from resolveSettings', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile(
    { name: 'GPT', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', contextWindow: 'lots', maxOutputTokens: -3 },
    'k'
  );
  assert.strictEqual(s.getRedacted().profiles[0].contextWindow, null);
  assert.strictEqual(s.getRedacted().profiles[0].maxOutputTokens, null);
  assert.deepStrictEqual(s.resolveSettings(id), { apiKey: 'k', model: 'gpt-4o', baseUrl: '' });
});

test('editing a profile without touching overrides re-sends and preserves them; string numbers coerce', (t) => {
  const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = mkStore(dir);
  const id = s.upsertProfile(
    { name: 'A', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', contextWindow: '32000' },
    'k'
  );
  assert.strictEqual(s.getRedacted().profiles[0].contextWindow, 32000); // string coerced
  s.upsertProfile({ id, name: 'A2', provider: 'OpenAI', model: 'gpt-4o', baseUrl: '', contextWindow: 32000 });
  assert.deepStrictEqual(s.resolveSettings(id), { apiKey: 'k', model: 'gpt-4o', baseUrl: '', contextWindow: 32000 });
});
