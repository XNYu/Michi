import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import { CREW_KIRO_FLAVOR } from 'michi-runtime/internal/adapters/crew/crewFlavor';
import { RUNTIME_FACTORIES } from '../src/agents/runtimeFactories';
import { CREW_DESCRIPTOR, describeRuntimeCapabilities } from '../src/agents/capabilityDescriptors';
import { crewAvailability, crewIntegrationStatus, resolveCrewAcpLaunch, resolveCrewAcpLaunchDetailed } from 'michi-runtime/internal/adapters/crew/crewLaunch';
import { CREW_APP_VERSION, crewAppNeedsSync } from 'michi-runtime/internal/adapters/crew/crewAppVersion';
import { AcpClient, ACPError } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

const ENV_KEYS = ['MICHI_CREW_ACP_BIN', 'KIROCREW_HOME', 'MICHI_CREW_APP', 'MICHI_KIRO_ENGINE'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const tempDirs: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-'));
  tempDirs.push(dir);
  return dir;
}

function executable(dir: string, name = 'kirocrew-acp'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

function crewHomeWithSecret(app = 'michi-crew-runtime', enabled = true): string {
  const home = tempDir();
  fs.mkdirSync(path.join(home, 'apps', app), { recursive: true });
  fs.writeFileSync(path.join(home, 'apps', app, '.app_secret'), '');
  fs.writeFileSync(path.join(home, 'apps', app, 'installed.json'), JSON.stringify({ name: app, enabled }));
  fs.writeFileSync(path.join(home, 'apps', app, 'app.json'), JSON.stringify({ version: CREW_APP_VERSION, permissions: { sessionApproval: true }, mcpServers: { michi: {} } }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: { stub_servers: [`${app}:michi`] } }));
  return home;
}

function createCrew(): KiroRuntime {
  const factory = RUNTIME_FACTORIES.find((f) => f.id === 'crew');
  assert.ok(factory, 'crew factory registered');
  return factory.create({ bridge, mcpPort: 0, defaultCwd: '/tmp/crew-default', host: michiTestHost() }) as KiroRuntime;
}

const ORIGINAL_KIRO_CAPABILITIES = {
  modes: true,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  apiKeys: false,
  warmSessions: true,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

describe('crew runtime registration', () => {
  test('crew descriptor hides App-refused steer, offers Gateway compaction, stop record, roster and credits', () => {
    const runtime = createCrew();
    const d = runtime.descriptor.harness;
    // Official Gateway 0.11.0.1: App sends with steer:true are queued, not steered.
    assert.equal(d.steer.availability, 'invisible');
    assert.equal(d.compact.availability, 'native');
    assert.equal(d.interruptAck.availability, 'native');
    assert.equal(d.subagents.availability, 'native');
    assert.match(d.subagents.notes ?? '', /Crew dashboard/);
    assert.equal(d.usage.availability, 'native');
    assert.equal(runtime.descriptor.topology.cancel, 'native-ack');
    assert.equal(d.sessionFork.availability, 'native');
    assert.equal(d.sessionFork.confidence, 'projected');
    assert.deepEqual(d, CREW_DESCRIPTOR);
    assert.deepEqual(describeRuntimeCapabilities('crew'), CREW_DESCRIPTOR);
  });

  test('engine stays v2 under MICHI_KIRO_ENGINE=v3', () => {
    process.env.MICHI_KIRO_ENGINE = 'v3';
    const kiro = RUNTIME_FACTORIES.find((f) => f.id === 'kiro')!;
    assert.equal((kiro.create({ bridge, mcpPort: 0, defaultCwd: '/tmp/default', host: michiTestHost() }) as KiroRuntime).engine, 'v3');
    assert.equal(createCrew().engine, 'v2');
  });

  test('crew runtime has no sidecar title generator', async () => {
    assert.equal(await createCrew().generateTitle({ userText: 'hello' } as any), null);
  });
});

describe('resolveCrewAcpLaunch', () => {
  test('a non-executable env bin is reported, not skipped', () => {
    const dir = tempDir();
    const bundledScript = path.join(dir, 'crewAcp.js');
    fs.writeFileSync(bundledScript, '');
    const missing = path.join(dir, 'nope');
    const resolved = resolveCrewAcpLaunchDetailed({ acpBinOverride: missing, bundledScript });
    assert.equal(resolved.launch, null);
    assert.match(resolved.detail ?? '', /MICHI_CREW_ACP_BIN=.*not an executable/);
  });

  test('bundle is used before source and runs under this node', () => {
    const dir = tempDir();
    const bundledScript = path.join(dir, 'crewAcp.js');
    const sourceMain = path.join(dir, 'main.ts');
    fs.writeFileSync(bundledScript, '');
    fs.writeFileSync(sourceMain, '');
    const launch = resolveCrewAcpLaunch({ bundledScript, sourceMain });
    assert.equal(launch?.bin, process.execPath);
    assert.deepEqual(launch?.args('m1'), [bundledScript, 'acp', '--agent-engine', 'v2', '--model', 'm1']);
  });

  test('source main runs under ts-node when no bundle exists', () => {
    const dir = tempDir();
    const sourceMain = path.join(dir, 'main.ts');
    fs.writeFileSync(sourceMain, '');
    const launch = resolveCrewAcpLaunch({ bundledScript: path.join(dir, 'crewAcp.js'), sourceMain });
    assert.equal(launch?.bin, process.execPath);
    assert.deepEqual(launch?.args(), ['--require', require.resolve('ts-node/register'), sourceMain, 'acp', '--agent-engine', 'v2']);
  });
});

describe('crewAvailability', () => {
  test('missing or pending sessionApproval consent is incomplete setup', () => {
    const bin = executable(tempDir());
    for (const pending of [false, true]) {
      const home = crewHomeWithSecret();
      const dir = path.join(home, 'apps/michi-crew-runtime');
      if (pending) fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ enabled: true, sessionApprovalConsentPending: true }));
      else fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ version: CREW_APP_VERSION, mcpServers: { michi: {} } }));
      const result = crewAvailability({ acpBinOverride: bin, kirocrewHome: home });
      assert.equal(result.available, false);
      assert.match(result.detail ?? '', /setup incomplete.*sessionApproval consent/);
    }
  });

  test('missing MCP or a disabled Stub override is incomplete setup', () => {
    const bin = executable(tempDir());
    for (const missing of ['declaration', 'route', 'override']) {
      const home = crewHomeWithSecret();
      if (missing === 'declaration') fs.writeFileSync(path.join(home, 'apps/michi-crew-runtime/app.json'), JSON.stringify({ version: CREW_APP_VERSION, permissions: { sessionApproval: true } }));
      else fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: missing === 'route' ? {} : {
        stub_servers: ['michi-crew-runtime:michi'], stub_overrides: { 'michi-crew-runtime:michi': false },
      } }));
      const result = crewAvailability({ acpBinOverride: bin, kirocrewHome: home });
      assert.equal(result.available, false);
      assert.match(result.detail ?? '', /setup incomplete.*Stub \/ Routed/);
    }
  });

  test('unavailable while the app is installed but disabled', () => {
    const bin = executable(tempDir());
    const result = crewAvailability({
      acpBinOverride: bin, kirocrewHome: crewHomeWithSecret('michi-crew-runtime', false),
    });
    assert.equal(result.available, false);
    assert.match(result.detail ?? '', /Enable the Kiro Crew app michi-crew-runtime/);
  });

  test('outdated App is explained without reading credentials and current App recovers', () => {
    const home = crewHomeWithSecret();
    const manifestFile = path.join(home, 'apps/michi-crew-runtime/app.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: '0.5.0' }));
    const status = crewIntegrationStatus({ kirocrewHome: home });
    assert.equal(status.updateRequired, true);
    assert.equal(status.expectedVersion, CREW_APP_VERSION);
    assert.match(crewAvailability({ kirocrewHome: home }).detail ?? '', /App update required.*Sync/);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal(crewIntegrationStatus({ kirocrewHome: home }).updateRequired, false);
    assert.equal(crewAppNeedsSync('0.10.0', '0.6.0'), false);
    assert.equal(crewAppNeedsSync('0.5.9', '0.6.0'), true);
    assert.equal(crewAppNeedsSync('malformed'), true);
  });

  test('unavailable when no adapter resolves, even with a secret', () => {
    const dir = tempDir();
    const result = crewAvailability({
      kirocrewHome: crewHomeWithSecret(),
      bundledScript: path.join(dir, 'crewAcp.js'),
      sourceMain: path.join(dir, 'main.ts'),
    });
    assert.equal(result.available, false);
    assert.match(result.detail ?? '', /adapter not found/);
  });

  test('crew runtime reports availability from env and refuses to spawn when unavailable', async () => {
    process.env.MICHI_CREW_ACP_BIN = executable(tempDir());
    process.env.KIROCREW_HOME = tempDir();
    const runtime = createCrew();
    const availability = runtime.checkAvailability();
    assert.equal(availability.available, false);
    await assert.rejects(runtime.ensureClient('/tmp/crew-a'), /Install and enable the Kiro Crew app/);
    assert.equal((runtime as any).pool.size, 0);
    // Boot-time model refresh must not spawn the adapter either.
    assert.deepEqual(await runtime.refreshModels(), []);
    assert.equal((runtime as any).pool.size, 0);

    process.env.KIROCREW_HOME = crewHomeWithSecret();
    assert.deepEqual(runtime.checkAvailability(), { available: true });
  });
});

describe('crew native fork and sessions', () => {
  test('a session built without a flavor follows its runtime\'s', async () => {
    let prompt = '';
    const client = { async *prompt(_sid: string, text: string) {
      prompt = text;
      yield { sessionUpdate: 'session_info_update', title: 'Gateway title' };
      yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
    } };
    const runtime = createCrew();
    (runtime as any).ensureClient = async () => client;
    try {
      const session = new KiroSession('node', 'sid', runtime, '/tmp', { runtimeId: 'crew' });
      const events: any[] = [];
      for await (const event of session.send('go')) events.push(event);
      assert.deepEqual(events.filter((e) => e.kind === 'title').map((e) => e.title), ['Gateway title']);
      assert.match(prompt, /No tools are needed for this metadata/);
      assert.doesNotMatch(prompt, /call the MCP tool set_branch_overview/);
    } finally {
      await runtime.shutdown();
    }
  });

  test('a missing Crew session keeps the agent\'s error; a missing Kiro session asks for a rebuild', async () => {
    const missing = () => new ACPError('Internal error', { method: 'session/load', sessionId: 'gone', rpcCode: -32603,
      rpcData: 'Failed to start session: Session not found: gone' });
    const kiro = RUNTIME_FACTORIES.find((f) => f.id === 'kiro')!
      .create({ bridge, mcpPort: 0, defaultCwd: '/tmp/crew-default', host: michiTestHost() }) as KiroRuntime;
    for (const runtime of [createCrew(), kiro]) {
      (runtime as any).ensureClient = async () => ({ loadSession: async () => { throw missing(); } });
      await assert.rejects(runtime.loadAcpSession({ sessionId: 'gone', cwd: '/tmp/a' }),
        (err: unknown) => (err instanceof NativeResumeUnavailableError) === (runtime.id === 'kiro')
          && (runtime.id === 'kiro' || err instanceof ACPError), runtime.id);
      await runtime.shutdown();
    }
  });

  test('forkSession refuses non-chat owners', async () => {
    const runtime = createCrew();
    await assert.rejects(
      runtime.forkSession({ cwd: '/tmp/a', sessionId: 'child', parentChatId: 'parent', sourceNativeSessionId: 'sid', owner: runOwner('run', 'child') }),
      (err: unknown) => err instanceof NativeResumeUnavailableError,
    );
  });

  test('recordForkAnchor skips unbound sessions', async () => {
    const runtime = createCrew();
    let rewinds = 0;
    (runtime as any).sessionCwd.set('sid', '/tmp/a');
    (runtime as any).pool.set('/tmp/a', { executeCommand: async () => { rewinds += 1; return { success: false }; } });
    await runtime.recordForkAnchor('node', 'sid', { assistantMessageId: 'm' } as any);
    assert.equal(rewinds, 0);
  });

  test('Crew title and tool output reach the shared event stream without generating Kiro titles', async () => {
    let prompt = '';
    const client = { async *prompt(_sid: string, text: string) {
      prompt = text;
      yield { sessionUpdate: 'session_info_update', title: 'Gateway title' };
      yield { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', status: 'in_progress' };
      yield { sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'Read', rawOutput: 'file contents', status: 'completed' };
      yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
    } };
    for (const id of ['crew', 'kiro']) {
      const runtime = { host: michiTestHost(), id, ensureClient: async () => client, getCurrentMode: () => null, getCurrentModel: () => null } as unknown as KiroRuntime;
      const session = new KiroSession('node', 'sid', runtime, '/tmp', { runtimeId: id, ...(id === 'crew' ? { flavor: CREW_KIRO_FLAVOR } : {}) });
      const events: any[] = [];
      for await (const event of session.send('go')) events.push(event);
      assert.equal(events.filter((e) => e.kind === 'title').length, id === 'crew' ? 1 : 0);
      assert.equal(events.find((e) => e.kind === 'tool_call_update')?.output, 'file contents');
      assert.equal(prompt.includes('call the MCP tool set_branch_overview'), id !== 'crew');
      if (id === 'crew') {
        assert.doesNotMatch(prompt, /michi_call_tool|michi_list_tools/);
        assert.match(prompt, /No tools are needed for this metadata/);
        assert.ok(prompt.length < 600);
      }
      assert.match(prompt, /\[BRANCH-OVERVIEW:/);
    }
  });

  test('a Crew cancel reports the Gateway stop record as a native ack; without one it stays inferred', async () => {
    const calls: string[] = [];
    let report: unknown = { confirmed: true, state: 'stopped', outcome: 'soft' };
    const client = {
      cancel: async () => { calls.push('session/cancel'); return true; },
      executeCommand: async (_sid: string, command: string) => { calls.push(command); return { success: true, data: report }; },
    };
    const runtime = { host: michiTestHost(), id: 'crew', getClient: () => client, endMcpSessionTurn: () => {} } as unknown as KiroRuntime;
    const crew = new KiroSession('node', 'sid', runtime, '/tmp', { runtimeId: 'crew', flavor: CREW_KIRO_FLAVOR });
    assert.deepEqual(await crew.cancel(), { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: 'Crew stop_event stopped' });
    assert.deepEqual(calls, ['session/cancel', 'cancel_status']);

    report = { confirmed: false, state: 'stop_declined_compacting' };
    assert.deepEqual(await crew.cancel(), { acknowledged: true, source: 'inferred', confidence: 'unknown', nativeMethod: 'session/cancel' });
    client.executeCommand = async () => { throw new Error('adapter gone'); };
    assert.equal((await crew.cancel()).source, 'inferred');

    // kiro-cli's ack is the prompt's settlement: it never asks for a stop record.
    calls.length = 0;
    const settling = { ...client, cancelAndSettle: async () => { calls.push('session/cancel'); return { dispatched: true }; } };
    const kiro = new KiroSession('node', 'sid', { ...runtime, id: 'kiro', getClient: () => settling } as unknown as KiroRuntime, '/tmp', { runtimeId: 'kiro' });
    assert.equal((await kiro.cancel()).source, 'inferred');
    assert.deepEqual(calls, ['session/cancel']);
  });

  test('crew newSession returns a session with the crew runtime id', async () => {
    const runtime = createCrew();
    const rt = runtime as any;
    rt.ensureClient = async () => ({});
    rt.warmNextSession = () => {};
    rt.openSession = async () => ({ sid: 'crew-sid' });
    const session = await runtime.newSession({ cwd: '/tmp/a', sessionId: 'node-crew' });
    assert.equal(session.runtimeId, 'crew');
    assert.equal(session.nativeSessionId, 'crew-sid');
    const preamble = (session as any).firstMessagePreamble;
    assert.equal(preamble, '', 'stable instructions belong to the Crew template');
  });
});

describe('crew session state', () => {
  test('mode, model and commands are reported under the crew runtime id', async (t) => {
    process.env.MICHI_CREW_ACP_BIN = executable(tempDir());
    process.env.KIROCREW_HOME = crewHomeWithSecret();
    // The pooled client is the real one the factory builds; only its process stays out.
    t.mock.method(AcpClient.prototype, 'start', () => {});
    t.mock.method(AcpClient.prototype, 'initialize', async () => ({}));
    const runtime = createCrew();
    try {
      const session = new KiroSession('node-crew', 'crew-sid', runtime, '/tmp/crew-state', { runtimeId: 'crew' });
      assert.equal(session.getSessionState().runtimeId, 'crew', 'before the adapter starts');
      const client = await runtime.ensureClient('/tmp/crew-state');
      const update = (value: unknown) => (client as any).dispatch({ method: 'session/update', params: { sessionId: 'crew-sid', update: value } });
      update({ sessionUpdate: 'config_option_update', configOptions: [
        { id: 'mode', type: 'select', currentValue: 'template:reviewer', options: [{ value: 'template:reviewer' }] },
        { id: 'model', type: 'select', currentValue: 'm2', options: [{ value: 'm1' }, { value: 'm2' }] },
      ] });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'crew-help' }] });
      const state = session.getSessionState();
      assert.equal(state.runtimeId, 'crew');
      assert.equal(state.nativeEngine, 'v2');
      assert.equal(state.currentModeId, 'template:reviewer');
      assert.equal(state.modelId, 'm2');
      assert.deepEqual(state.commands?.map((command) => command.name), ['crew-help']);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe('AcpClient launch override', () => {
  test('spawns the override bin with override args', async () => {
    const out = path.join(tempDir(), 'argv.json');
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`;
    const client = new AcpClient(undefined, os.tmpdir(), 'm9', 'v2', {
      bin: process.execPath,
      args: (model) => ['-e', script, 'acp', ...(model ? ['--model', model] : [])],
    });
    const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
    client.start();
    await exited;
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['acp', '--model', 'm9']);
    await client.shutdown();
  });
});
