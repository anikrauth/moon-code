const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createMcpManager } = require('../dist/main/features/mcp/mcpManager.js');

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
  assert.strictEqual(statuses[1].toolCount, 3);
  assert.deepStrictEqual(mgr.statuses().fx, { status: 'connected', toolCount: 3 });

  const tools = mgr.getAgentTools();
  const names = Object.keys(tools).sort();
  assert.deepStrictEqual(names, ['mcp__Fixture_Srv__echo', 'mcp__Fixture_Srv__fail', 'mcp__Fixture_Srv__getenv']);
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

test('parent env is not leaked; explicit secrets env is passed', { timeout: 30000 }, async (t) => {
  process.env.MOON_LEAK_TEST = 'leaked';
  t.after(() => { delete process.env.MOON_LEAK_TEST; });
  const statuses = [];
  const mgr = createMcpManager({
    getServer: () => ({ id: 'fx', name: 'Fixture Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: true }),
    resolveSecrets: () => ({ env: { MOON_EXPLICIT: 'yes' } }),
    onStatus: (e) => statuses.push(e),
  });
  t.after(() => mgr.disconnectAll());

  const ok = await mgr.connect('fx');
  assert.strictEqual(ok, true);
  const tools = mgr.getAgentTools();
  const getenv = tools['mcp__Fixture_Srv__getenv'];
  assert.ok(getenv);

  assert.strictEqual(await getenv.execute({ name: 'MOON_LEAK_TEST' }), '(unset)');
  assert.strictEqual(await getenv.execute({ name: 'MOON_EXPLICIT' }), 'yes');
  assert.notStrictEqual(await getenv.execute({ name: 'PATH' }), '(unset)');
});

test('concurrent connect spawns once', { timeout: 30000 }, async (t) => {
  const statuses = [];
  const mgr = mkManager({
    fx: { id: 'fx', name: 'Fixture Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: false },
  }, statuses);
  t.after(() => mgr.disconnectAll());

  const [a, b] = await Promise.all([mgr.connect('fx'), mgr.connect('fx')]);
  assert.strictEqual(a, true);
  assert.strictEqual(b, true);
  assert.strictEqual(statuses.filter((s) => s.status === 'connecting').length, 1);
  assert.strictEqual(statuses.filter((s) => s.status === 'connected').length, 1);
});

test('unknown server id -> error, forget clears status', { timeout: 15000 }, async () => {
  const statuses = [];
  const mgr = mkManager({}, statuses);
  assert.strictEqual(await mgr.connect('nope'), false);
  assert.strictEqual(mgr.statuses().nope.status, 'error');
  mgr.forget('nope');
  assert.strictEqual(mgr.statuses().nope, undefined);
});

test('disconnect during in-flight connect cancels: no ghost connection', { timeout: 30000 }, async (t) => {
  const statuses = [];
  const mgr = mkManager({
    fx: { id: 'fx', name: 'Fixture Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: false },
  }, statuses);
  t.after(() => mgr.disconnectAll());

  const connectPromise = mgr.connect('fx');
  await mgr.disconnect('fx');
  const ok = await connectPromise;

  assert.strictEqual(ok, false);
  assert.strictEqual(mgr.statuses().fx.status, 'disconnected');
  assert.deepStrictEqual(mgr.getAgentTools(), {});
});

test('slug collision disambiguates later server instead of overwriting tool names', { timeout: 30000 }, async (t) => {
  const statuses = [];
  const mgr = mkManager({
    fx1: { id: 'fx1', name: 'Fixture Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: false },
    fx2: { id: 'fx2', name: 'Fixture-Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE], hasSecrets: false },
  }, statuses);
  t.after(() => mgr.disconnectAll());

  assert.strictEqual(await mgr.connect('fx1'), true);
  assert.strictEqual(await mgr.connect('fx2'), true);

  const tools = mgr.getAgentTools();
  const names = Object.keys(tools);
  assert.strictEqual(names.length, 6);
  assert.strictEqual(new Set(names).size, 6, 'no name appears twice');
  assert.ok(names.some((n) => n.startsWith('mcp__Fixture_Srv__')));
  assert.ok(names.some((n) => n.startsWith('mcp__Fixture_Srv_') && !n.startsWith('mcp__Fixture_Srv__')));
});
