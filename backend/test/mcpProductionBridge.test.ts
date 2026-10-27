import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpClientManager } from '../src/services/mcpClientManager';
import { buildMcpToolsForPi } from '../src/agents/pi/mcpToolBridge';
import { loadPiAi } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';

const fixture = path.resolve(__dirname, 'fixtures/mcpConsistencyServer.cjs');
const config = (serverName: string, mode = 'pagination', args: string[] = []) => ({ serverName, command: process.execPath, args: [fixture, mode, ...args] });

test('real stdio manager preserves full MCP result and production Pi bridge projects supported multimodal content', async t => {
  const manager = new McpClientManager(); t.after(() => manager.dispose());
  const { tools } = await manager.connect(config('fixture'));
  assert.deepEqual(tools.map(tool => tool.name), ['echo', 'rich', 'environment']);
  const raw = await manager.callTool('fixture', 'rich', {});
  assert.equal(raw.content.length, 6);
  assert.equal(raw.content[1].type, 'image');
  assert.equal((raw.content[1] as any).mimeType, 'image/png');
  assert.deepEqual(raw.structuredContent, { answer: 42, nested: { ok: true } });
  assert.deepEqual(raw._meta, { trace: 'fixture-trace' });
  assert.deepEqual(raw.content[0].annotations, { audience: ['assistant'], priority: 0.7 });
  assert.deepEqual(raw.content[0]._meta, { text: true });
  assert.equal((raw.content[5] as any).size, 6);
  const pi = await loadPiAi();
  const wrapped = buildMcpToolsForPi({ mcpManager: manager, Type: pi.Type }).find(tool => tool.label === 'rich');
  const result = await wrapped.execute('call-1', {});
  assert.deepEqual(result.details.mcpResult, raw);
  assert.deepEqual(result.content[1], { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
  const text = result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  for (const expected of ['visible', 'resource body', 'fixture://link', 'Structured result', 'answer', 'audio', 'application/pdf']) assert.match(text, new RegExp(expected));
  assert.doesNotMatch(text, /YXVkaW8=|YmluYXJ5/);
});

test('real image-only, resource-only and structured-only results stay useful through the production bridge', async t => {
  const manager = new McpClientManager(); t.after(() => manager.dispose());
  await manager.connect(config('content', 'complete'));
  const pi = await loadPiAi();
  const tool = buildMcpToolsForPi({ mcpManager: manager, Type: pi.Type }).find(tool => tool.label === 'rich');
  for (const mode of ['image-only', 'resource-only', 'structured-only']) {
    const result = await tool.execute(mode, { result: mode });
    assert.doesNotMatch(JSON.stringify(result.content), /no text content/);
    if (mode === 'image-only') assert.equal(result.content[0].type, 'image');
    if (mode === 'resource-only') assert.match(result.content[0].text, /resource body/);
    if (mode === 'structured-only') assert.match(result.content[0].text, /answer.*42/);
  }
});

test('production bridge preserves JSON Schema constraints and actual Pi validation including refs, unions and conditionals', async t => {
  const manager = new McpClientManager(); t.after(() => manager.dispose());
  await manager.connect(config('schema'));
  const pi: any = await loadPiAi();
  const tool = buildMcpToolsForPi({ mcpManager: manager, Type: pi.Type }).find(tool => tool.label === 'rich');
  assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), manager.listTools('schema').find(tool => tool.name === 'rich')!.inputSchema);
  const valid = { count: 2, query: 'abc', tags: ['a'], choice: 'auto', __tool_use_purpose: 'server-owned' };
  const validate = (args: unknown) => pi.validateToolArguments(tool, { name: tool.name, arguments: args });
  assert.deepEqual(validate(valid), valid);
  for (const args of [
    { ...valid, count: 1.5 }, { ...valid, count: 0 }, { ...valid, count: 5 },
    { ...valid, query: 'A' }, { ...valid, query: 'abcde' }, { ...valid, tags: [] },
    { ...valid, tags: ['a', 'b', 'c'] }, { ...valid, choice: false },
    { ...valid, unrelated: true }, { ...valid, mode: 'strict' },
  ]) assert.throws(() => validate(args), /Validation failed/);
  assert.doesNotThrow(() => validate({ ...valid, mode: 'strict', extra: 'required' }));
  const echo = buildMcpToolsForPi({ mcpManager: manager, Type: pi.Type }).find(tool => tool.label === 'echo');
  const echoResult = await echo.execute('echo', valid);
  assert.deepEqual(JSON.parse(echoResult.content[0].text), valid, 'server-owned purpose property must not be stripped');
  assert.deepEqual(JSON.parse(JSON.stringify(echo.parameters)), { type: 'object', additionalProperties: true });
});

for (const mode of ['fail-once', 'page-fail', 'repeat-cursor']) {
  test(`real stdio discovery ${mode} fails closed and reconnect can retry`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-retry-'));
    const manager = new McpClientManager();
    t.after(async () => { await manager.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
    const first = config('retry', mode, [path.join(dir, 'attempt')]);
    await assert.rejects(manager.connect(first), /discovery|cursor|second page/);
    assert.equal(manager.isConnected('retry'), false);
    assert.deepEqual(manager.listTools('retry'), []);
    await manager.connect(mode === 'fail-once' ? first : config('retry', 'complete'));
    assert.equal(manager.isConnected('retry'), true);
    assert.equal(manager.listTools('retry').length, 3);
  });
}

test('real subprocess keeps desktop inheritance; cloud is fail closed or uses explicit owner environment allowlist', async t => {
  configureRuntimeDeps({ dataDir: path.join(os.tmpdir(), 'mcp-cloud-fixture') } as any);
  t.after(() => __resetRuntimeDeps());
  const before = { cloud: process.env.MICHI_CLOUD, secret: process.env.MCP_HOST_SECRET, user: process.env.USER, logname: process.env.LOGNAME, profile: process.env.USERPROFILE };
  process.env.USER = 'fixture-host-user'; process.env.LOGNAME = 'fixture-host-logname'; process.env.USERPROFILE = 'fixture-host-profile';
  process.env.MCP_HOST_SECRET = 'fixture-host-only'; delete process.env.MICHI_CLOUD;
  t.after(() => { for (const [key, value] of Object.entries({ MICHI_CLOUD: before.cloud, MCP_HOST_SECRET: before.secret, USER: before.user, LOGNAME: before.logname, USERPROFILE: before.profile })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const desktop = new McpClientManager(); t.after(() => desktop.dispose());
  await desktop.connect({ ...config('desktop', 'complete'), env: { MCP_EXPLICIT: 'desktop' } });
  const env = async (manager: McpClientManager, name: string) => JSON.parse((await manager.callTool(name, 'environment', {})).content.map((block: any) => block.text).join(''));
  assert.equal((await env(desktop, 'desktop')).secret, 'fixture-host-only');
  process.env.MICHI_CLOUD = '1';
  const denied = new McpClientManager({ ownerUserId: 'fixture-owner' }); t.after(() => denied.dispose());
  await assert.rejects(denied.connect(config('denied')), { code: 'MCP_CLOUD_POLICY_REQUIRED' });
  const cloud = new McpClientManager({ ownerUserId: 'fixture-owner', cloudEnvironment: { ownerUserId: 'fixture-owner', env: { MCP_EXPLICIT: 'owner-only' } } }); t.after(() => cloud.dispose());
  await cloud.connect(config('cloud', 'complete'));
  const result = await env(cloud, 'cloud');
  assert.equal(result.secret, undefined); assert.equal(result.explicit, 'owner-only');
  assert.notEqual(result.inheritedUser, 'fixture-host-user'); assert.notEqual(result.inheritedLogname, 'fixture-host-logname'); assert.notEqual(result.inheritedProfile, 'fixture-host-profile');
  assert.match(result.home, /fixture-owner/); assert.notEqual(result.home, os.homedir());
  await assert.rejects(cloud.connect({ ...config('global'), env: { MCP_EXPLICIT: 'global' } }), /Process-global/);
  const wrong = new McpClientManager({ ownerUserId: 'other', cloudEnvironment: { ownerUserId: 'fixture-owner' } }); t.after(() => wrong.dispose());
  await assert.rejects(wrong.connect(config('wrong')), { code: 'MCP_CLOUD_POLICY_REQUIRED' });
});

test('repeated real discovery failures release closed catalogs while preserving and finally disposing the healthy connection', async t => {
  const manager = new McpClientManager(); t.after(() => manager.dispose());
  await manager.connect(config('healthy', 'complete'));
  const healthy = (manager as any).connections.get('healthy');
  const healthyPid = healthy.transport.pid;
  assert.equal(typeof healthyPid, 'number');
  for (let attempt = 0; attempt < 4; attempt++) {
    await assert.rejects(manager.connect(config('retry', 'page-fail')), /second page/);
    assert.equal((manager as any).pendingConnections.size, 0);
    assert.equal((manager as any).closingConnections.size, 0, 'settled closes must release their strong resource ownership');
    assert.ok((manager as any).closing instanceof WeakMap, 'idempotence must not strongly retain every old client/catalog');
    assert.equal((manager as any).connections.get('healthy'), healthy);
    assert.deepEqual(manager.connectedServers(), ['healthy']);
  }
  const result = await manager.callTool('healthy', 'echo', { survived: true });
  assert.equal((result.content[0] as any).text, '{"survived":true}');
  const disposing = manager.dispose(); assert.equal(manager.dispose(), disposing); await disposing;
  assert.deepEqual(manager.connectedServers(), []);
  assert.equal((manager as any).closingConnections.size, 0);
  assert.throws(() => process.kill(healthyPid, 0), { code: 'ESRCH' });
});


test('real paginated first-page output schema and required-task metadata remain enforced after later discovery pages', async t => {
  const manager = new McpClientManager(); t.after(() => manager.dispose());
  await manager.connect(config('metadata', 'metadata-pages'));
  assert.deepEqual(manager.listTools('metadata').map(tool => tool.name), ['output-first', 'task-first', 'call-log', 'last']);
  assert.equal(manager.listTools('metadata')[0].outputSchema?.type, 'object');
  assert.equal(manager.listTools('metadata')[1].execution?.taskSupport, 'required');
  for (const args of [{}, { missing: true }]) {
    const invalid = await manager.callTool('metadata', 'output-first', args);
    assert.equal(invalid.isError, true);
    assert.match((invalid.content[0] as any).text, /output schema/);
  }
  const valid = await manager.callTool('metadata', 'output-first', { valid: true });
  assert.notEqual(valid.isError, true); assert.deepEqual(valid.structuredContent, { answer: 42 });
  const toolError = await manager.callTool('metadata', 'output-first', { error: true });
  assert.equal(toolError.isError, true); assert.equal((toolError.content[0] as any).text, 'tool-level error');
  const pi = await loadPiAi();
  assert.equal(buildMcpToolsForPi({ mcpManager: manager, Type: pi.Type }).some(tool => tool.label === 'task-first'), false, 'unsupported task-only tools must not be advertised to Pi');
  const task = await manager.callTool('metadata', 'task-first', {});
  assert.equal(task.isError, true); assert.match((task.content[0] as any).text, /task-based execution/);
  const log = await manager.callTool('metadata', 'call-log', {});
  assert.equal(JSON.parse((log.content[0] as any).text).includes('task-first'), false, 'required task must be refused before network invocation');
});
