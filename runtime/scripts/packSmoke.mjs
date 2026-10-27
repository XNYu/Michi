// Loads an installed michi-runtime the way a host does: from the
// node_modules this file resolves packages from, by its public subpaths.
// scripts/pack.mjs copies it beside the unpacked tarball and runs it there; a
// scratch project that ran `npm install <tarball>` can run it the same way.
// Nothing here starts an agent CLI. The one port it opens is the MCP host's
// listen(): 127.0.0.1, a free port, closed before the next check. The Crew
// processes it starts get a scratch HOME.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const NAME = 'michi-runtime';
const pkgDir = join(dirname(require.resolve(NAME)), '..');
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const specifierOf = (subpath) => (subpath === '.' ? NAME : `${NAME}/${subpath.slice(2)}`);
const scratch = mkdtempSync(join(tmpdir(), 'michi-runtime-pack-smoke-'));
const ok = (message) => console.log(`ok - ${message}`);

try {
  // Every public subpath, by import and by require, is one module.
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = specifierOf(subpath);
    const esm = await import(specifier);
    const cjs = require(specifier);
    const names = Object.keys(cjs).filter((name) => name !== '__esModule').sort();
    assert.ok(names.length > 0, `${specifier} exports no value`);
    assert.deepEqual(Object.keys(esm).filter((name) => name !== 'default').sort(), names, `${specifier}: import and require see different names`);
    assert.equal(esm.default, cjs, `${specifier}: the ESM default is not the CommonJS module`);
    for (const name of names) assert.equal(esm[name], cjs[name], `${specifier}: ${name} differs between import and require`);
    ok(`${specifier}: ${names.length} values, the same by import and by require`);
  }

  // The contract version a host reads is the package's major version.
  const { RUNTIME_CONTRACT_VERSION } = require(NAME);
  assert.equal(Number(manifest.version.split('.')[0]), RUNTIME_CONTRACT_VERSION,
    `RUNTIME_CONTRACT_VERSION ${RUNTIME_CONTRACT_VERSION} is not the major version of ${manifest.version}`);
  ok(`contract version ${RUNTIME_CONTRACT_VERSION} is the major version of ${NAME}@${manifest.version}`);

  // One session directory: a manager from require's createRuntimeManager sees
  // what an adapter registers through a host from import's createDefaultHost.
  const { createDefaultHost } = await import(NAME);
  const { createRuntimeManager } = require(NAME);
  const host = createDefaultHost();
  const manager = createRuntimeManager({ host });
  const session = {
    id: 'pack-smoke', runtimeId: 'codex', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel() {}, getSessionState: () => ({ runtimeId: 'codex' }), onSessionState: () => () => {},
  };
  host.sessions.registerSession(session, 'pack-smoke-user');
  assert.equal(manager.sessions.get('pack-smoke'), session);
  ok('createRuntimeManager({ host }) sees a session registered through createDefaultHost().sessions, across import and require');

  // A Codex and a Kiro runtime build from the public entries and register.
  // Nothing starts until a session needs the CLI; the Codex home is a scratch one.
  const { CodexRuntime } = await import(`${NAME}/adapters/codex`);
  const codex = new CodexRuntime({ host, bridge: {}, mcpSlots: {}, codexHome: join(scratch, 'codex'), spawnEnv: () => ({}) });
  manager.register(codex);
  assert.equal(manager.get('codex'), codex);
  ok('a CodexRuntime constructs and registers with the manager');
  const { KiroRuntime } = await import(`${NAME}/adapters/kiro`);
  const kiro = new KiroRuntime({ host, bridge: {}, defaultCwd: scratch });
  manager.register(kiro);
  assert.equal(manager.get('kiro'), kiro);
  ok('a KiroRuntime constructs and registers with the manager');

  // The reference slot provider on a loopback MCP host: a host tool reached
  // through a slot's URL, its report through the session's sink, and the URL
  // answering 404 once the slot is disposed.
  const { createMcpHost, createMcpSlotProvider } = await import(`${NAME}/mcp-host`);
  const { Client: HttpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const mcpHost = createMcpHost({ basePath: '/api/mcp', serverName: 'pack-smoke' });
  try {
    mcpHost.registerTool({
      name: 'pack_smoke_echo', description: 'Echoes the slot it ran on.', inputSchema: { type: 'object', properties: {} },
      async handler(_args, ctx) {
        ctx.sink.emit({ type: 'echoed', payload: ctx.slot.binding.parentChatId });
        return { content: [{ type: 'text', text: `${ctx.slot.binding.parentChatId}:${'sink' in ctx.slot.binding}` }] };
      },
    });
    const listener = await mcpHost.listen();
    assert.match(listener.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const mcpSlots = createMcpSlotProvider(mcpHost);
    const reports = [];
    const slot = mcpSlots.create('pack-smoke-chat', scratch, null, { sink: { emit: (event) => { reports.push(event); } } });
    const endpoint = mcpSlots.endpoint(slot.slotId);
    assert.equal(endpoint.url, `${listener.baseUrl}/api/mcp/${slot.slotId}`);
    assert.deepEqual(endpoint.headers, []);
    const mcpClient = new HttpClient({ name: 'pack-smoke', version: '0.0.0' });
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
    try {
      assert.deepEqual((await mcpClient.listTools()).tools.map((tool) => tool.name), ['pack_smoke_echo']);
      const result = await mcpClient.callTool({ name: 'pack_smoke_echo', arguments: {} });
      assert.equal(result.content[0].text, 'pack-smoke-chat:false');
    } finally {
      await mcpClient.close();
    }
    assert.deepEqual(reports, [{ type: 'echoed', payload: 'pack-smoke-chat' }]);
    await mcpSlots.dispose(slot.slotId);
    const status = await fetch(endpoint.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }).then((response) => response.status);
    assert.equal(status, 404);
    ok('createMcpSlotProvider on a loopback createMcpHost: a slot serves its tool at /api/mcp/<id>, reports reach its sink, and it answers 404 once disposed');
  } finally {
    await mcpHost.close();
  }

  // The Crew preset and the Claude adapter's defaults build runtimes from the
  // public entries. Nothing starts; the Crew home and Claude config are scratch ones.
  const { createCrewRuntime } = await import(`${NAME}/adapters/crew`);
  const crew = createCrewRuntime({ host, bridge: {}, mcpSlots: {}, defaultCwd: scratch, crew: { kirocrewHome: join(scratch, 'kirocrew') } });
  manager.register(crew);
  assert.equal(manager.get('crew'), crew);
  assert.deepEqual([crew.id, crew.engine], ['crew', 'v2']);
  assert.equal(crew.checkAvailability().available, false, 'Crew is available without a Kiro Crew home');
  ok('createCrewRuntime builds a v2 KiroRuntime with id crew, unavailable without a Kiro Crew home');
  const { ClaudeRuntime, DEFAULT_CLAUDE_LIMITS, DEFAULT_CLAUDE_CLI_FLAGS, claudeAdapterOptions } = await import(`${NAME}/adapters/claude`);
  assert.ok(Object.isFrozen(DEFAULT_CLAUDE_LIMITS) && Object.isFrozen(DEFAULT_CLAUDE_LIMITS.pool) && Object.isFrozen(DEFAULT_CLAUDE_CLI_FLAGS));
  const claudeOptions = claudeAdapterOptions({ host, spawnEnv: () => ({}), configDir: () => join(scratch, 'claude') });
  assert.deepEqual(claudeOptions.limits, DEFAULT_CLAUDE_LIMITS);
  assert.deepEqual(claudeOptions.cli(), DEFAULT_CLAUDE_CLI_FLAGS);
  const claude = new ClaudeRuntime({ ...claudeOptions, bridge: {}, mcpSlots: {} });
  manager.register(claude);
  assert.equal(manager.get('claude'), claude);
  await claude.shutdown();
  ok('claudeAdapterOptions fills in the frozen defaults, and a ClaudeRuntime constructs from them and registers');

  // Files the adapters look for beside their own modules.
  const crewDir = join(pkgDir, 'dist/adapters/crew');
  const { resolveCrewAcpLaunch } = await import(`${NAME}/adapters/crew`);
  const launch = resolveCrewAcpLaunch({});
  assert.equal(launch?.bin, process.execPath, 'Crew: no default launch');
  assert.equal(launch.args()[0], join(crewDir, 'crewAcp.js'));
  ok('Crew launches its bundled dist/adapters/crew/crewAcp.js by default');
  for (const file of ['dist/adapters/crew/crewMcp.js', 'dist/adapters/crew/crewMcpHost.js', 'dist/adapters/codex/assets/codexStopHookRunner.cjs']) {
    assert.ok(existsSync(join(pkgDir, file)), `${file} is missing`);
  }
  ok('the Crew relay bundles and the Codex Stop hook runner are in place');

  const childEnv = {
    PATH: process.env.PATH, HOME: scratch, KIROCREW_HOME: join(scratch, 'crew'),
    MICHI_CREW_MCP_DIR: join(scratch, 'crew-mcp'), CREW_GATEWAY_URL: 'http://127.0.0.1:9',
  };

  // The bundled Crew ACP adapter starts as its own process and answers initialize.
  const acp = spawn(process.execPath, [join(crewDir, 'crewAcp.js'), 'acp', '--agent-engine', 'v2'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let acpOut = '';
  let acpErr = '';
  acp.stdout.on('data', (chunk) => { acpOut += chunk; });
  acp.stderr.on('data', (chunk) => { acpErr += chunk; });
  acp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
  const answered = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    acp.stdout.on('data', () => { if (acpOut.includes('\n')) { clearTimeout(timer); resolve(true); } });
  });
  acp.stdin.end();
  if (acp.exitCode === null) await Promise.race([once(acp, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (acp.exitCode === null) acp.kill('SIGKILL');
  assert.ok(answered, `Crew ACP adapter did not answer initialize:\n${acpErr}`);
  const reply = JSON.parse(acpOut.split('\n')[0]);
  assert.equal(reply.id, 1);
  assert.equal(reply.result?.protocolVersion, 1);
  ok(`crewAcp.js answers initialize as ${reply.result.agentInfo?.name}`);

  // The bundled MCP host loads crewMcp.js through vm and lists the relay's tools.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'pack-smoke', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(crewDir, 'crewMcpHost.js')], env: childEnv, stderr: 'pipe' }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['michi_call_tool', 'michi_list_tools']);
  } finally {
    await client.close();
  }
  ok('crewMcpHost.js loads crewMcp.js and lists its tools over stdio');

  // The Claude adapter's optional peer: loaded when installed, a clear error,
  // the class the public entry exports, when not.
  const { ClaudeSdkMissingError } = await import(`${NAME}/adapters/claude`);
  const transport = require(join(pkgDir, 'dist/adapters/claude/claudeSdkTransport.js'));
  let sdkInstalled = true;
  try { createRequire(join(pkgDir, 'dist/adapters/claude/claudeSdkTransport.js')).resolve('@anthropic-ai/claude-agent-sdk'); } catch { sdkInstalled = false; }
  if (sdkInstalled) {
    assert.equal(typeof (await transport.loadClaudeSdk()).query, 'function');
    ok('the Claude Agent SDK peer is installed and loads');
  } else {
    const peer = `@anthropic-ai/claude-agent-sdk@${manifest.peerDependencies['@anthropic-ai/claude-agent-sdk']}`;
    assert.throws(() => transport.loadClaudeSdk(), (error) => error instanceof ClaudeSdkMissingError
      && error.message.includes(`needs ${peer}, an optional peer dependency of michi-runtime`));
    ok('without the Claude Agent SDK peer, loading it throws the ClaudeSdkMissingError ./adapters/claude exports');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
