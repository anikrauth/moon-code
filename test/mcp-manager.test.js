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
