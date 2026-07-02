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
