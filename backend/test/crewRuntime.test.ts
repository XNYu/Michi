import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import { RUNTIME_FACTORIES } from '../src/agents/runtimeFactories';
import { KIRO_DESCRIPTOR, CREW_DESCRIPTOR, describeRuntimeCapabilities } from '../src/agents/capabilityDescriptors';
import {
  crewAppSecretPath,
  crewAvailability,
  crewIntegrationStatus,
  resolveCrewAcpLaunch,
  resolveCrewAcpLaunchDetailed,
} from '../src/agents/crew/crewLaunch';
import { CREW_APP_VERSION, crewAppNeedsSync } from '../src/agents/crew/crewAppVersion';
import { AcpClient } from '../src/services/acpClient';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import type { AgentToolBridge } from '../src/agents/toolBridge';

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
  return factory.create({ bridge, mcpPort: 0, defaultCwd: '/tmp/crew-default' }) as KiroRuntime;
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
  test('crew factory exists with id and label', () => {
    const factory = RUNTIME_FACTORIES.find((f) => f.id === 'crew');
    assert.equal(factory?.label, 'Kiro Crew');
    const runtime = createCrew();
    assert.equal(runtime.id, 'crew');
    assert.equal(runtime.label, 'Kiro Crew');
    assert.equal(runtime.engine, 'v2');
    assert.equal((runtime as any).runtimeOptions.launch.cancelTimeoutMs, 15_000);
  });

  test('default KiroRuntime keeps id, label, descriptor and capabilities', () => {
    delete process.env.MICHI_KIRO_ENGINE;
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
    assert.equal(runtime.id, 'kiro');
    assert.equal(runtime.label, 'Kiro');
    assert.deepEqual(runtime.capabilities, ORIGINAL_KIRO_CAPABILITIES);
    assert.deepEqual(runtime.capabilityDescriptor, KIRO_DESCRIPTOR);
  });

  test('crew descriptor hides unsupported steer and compact and labels Gateway fork as projected', () => {
    const runtime = createCrew();
    const d = runtime.capabilityDescriptor;
    assert.equal(d.steer.availability, 'invisible');
    assert.equal(d.compact.availability, 'invisible');
    assert.equal(d.sessionFork.availability, 'native');
    assert.equal(d.sessionFork.confidence, 'projected');
    assert.deepEqual(d, CREW_DESCRIPTOR);
    assert.deepEqual(describeRuntimeCapabilities('crew'), CREW_DESCRIPTOR);
  });

  test('crew exposes templates, approvals and MCP tools without a warm pool', () => {
    const c = createCrew().capabilities;
    assert.equal(c.modes, true);
    assert.equal(c.warmSessions, false);
    assert.equal(c.saveContext, true);
    assert.equal(c.spawnBranches, true);
    assert.equal(c.nativeResume, true);
    assert.equal(c.models, true);
    assert.equal(c.permissions, true);
    assert.equal(c.reasoning, true);
  });

  test('engine stays v2 under MICHI_KIRO_ENGINE=v3', () => {
    process.env.MICHI_KIRO_ENGINE = 'v3';
    assert.equal(new KiroRuntime(bridge, undefined, 0, '/tmp/default').engine, 'v3');
    assert.equal(createCrew().engine, 'v2');
  });

  test('crew runtime has no sidecar title generator', async () => {
    assert.equal(await createCrew().generateTitle({ userText: 'hello' } as any), null);
  });
});

describe('resolveCrewAcpLaunch', () => {
  test('env bin wins over bundle and source', () => {
    const dir = tempDir();
    const bin = executable(dir);
    const bundledScript = path.join(dir, 'crewAcp.js');
    const sourceMain = path.join(dir, 'main.ts');
    fs.writeFileSync(bundledScript, '');
    fs.writeFileSync(sourceMain, '');
    const launch = resolveCrewAcpLaunch({ env: { MICHI_CREW_ACP_BIN: bin }, bundledScript, sourceMain });
    assert.equal(launch?.bin, bin);
    assert.deepEqual(launch?.args(), ['acp', '--agent-engine', 'v2']);
    assert.deepEqual(launch?.args('m1'), ['acp', '--agent-engine', 'v2', '--model', 'm1']);
  });

  test('a non-executable env bin is reported, not skipped', () => {
    const dir = tempDir();
    const bundledScript = path.join(dir, 'crewAcp.js');
    fs.writeFileSync(bundledScript, '');
    const missing = path.join(dir, 'nope');
    const resolved = resolveCrewAcpLaunchDetailed({ env: { MICHI_CREW_ACP_BIN: missing }, bundledScript });
    assert.equal(resolved.launch, null);
    assert.match(resolved.detail ?? '', /MICHI_CREW_ACP_BIN=.*not an executable/);
  });

  test('bundle is used before source and runs under this node', () => {
    const dir = tempDir();
    const bundledScript = path.join(dir, 'crewAcp.js');
    const sourceMain = path.join(dir, 'main.ts');
    fs.writeFileSync(bundledScript, '');
    fs.writeFileSync(sourceMain, '');
    const launch = resolveCrewAcpLaunch({ env: {}, bundledScript, sourceMain });
    assert.equal(launch?.bin, process.execPath);
    assert.deepEqual(launch?.args('m1'), [bundledScript, 'acp', '--agent-engine', 'v2', '--model', 'm1']);
  });

  test('source main runs under ts-node when no bundle exists', () => {
    const dir = tempDir();
    const sourceMain = path.join(dir, 'main.ts');
    fs.writeFileSync(sourceMain, '');
    const launch = resolveCrewAcpLaunch({ env: {}, bundledScript: path.join(dir, 'crewAcp.js'), sourceMain });
    assert.equal(launch?.bin, process.execPath);
    assert.deepEqual(launch?.args(), ['--require', require.resolve('ts-node/register'), sourceMain, 'acp', '--agent-engine', 'v2']);
  });

  test('nothing resolves without env, bundle or source', () => {
    const dir = tempDir();
    const resolved = resolveCrewAcpLaunchDetailed({
      env: {}, bundledScript: path.join(dir, 'crewAcp.js'), sourceMain: path.join(dir, 'main.ts'),
    });
    assert.equal(resolved.launch, null);
    assert.match(resolved.detail ?? '', /adapter not found/);
  });
});

describe('crewAvailability', () => {
  test('secret path honours KIROCREW_HOME and MICHI_CREW_APP', () => {
    assert.equal(crewAppSecretPath({ KIROCREW_HOME: '/h' }), path.join('/h', 'apps', 'michi-crew-runtime', '.app_secret'));
    assert.equal(crewAppSecretPath({ KIROCREW_HOME: '/h', MICHI_CREW_APP: 'other' }), path.join('/h', 'apps', 'other', '.app_secret'));
    assert.equal(crewAppSecretPath({}), path.join(os.homedir(), '.kiro', 'crew', 'apps', 'michi-crew-runtime', '.app_secret'));
  });

  test('unavailable without the app secret', () => {
    const bin = executable(tempDir());
    const result = crewAvailability({ env: { MICHI_CREW_ACP_BIN: bin, KIROCREW_HOME: tempDir() } });
    assert.equal(result.available, false);
    assert.match(result.detail ?? '', /Install and enable the Kiro Crew app michi-crew-runtime/);
  });

  test('available with complete MCP and approval setup without reading the secret', () => {
    const bin = executable(tempDir());
    assert.deepEqual(crewAvailability({ env: { MICHI_CREW_ACP_BIN: bin, KIROCREW_HOME: crewHomeWithSecret() } }), { available: true });
  });

  test('missing or pending sessionApproval consent is incomplete setup', () => {
    const bin = executable(tempDir());
    for (const pending of [false, true]) {
      const home = crewHomeWithSecret();
      const dir = path.join(home, 'apps/michi-crew-runtime');
      if (pending) fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ enabled: true, sessionApprovalConsentPending: true }));
      else fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ version: CREW_APP_VERSION, mcpServers: { michi: {} } }));
      const result = crewAvailability({ env: { MICHI_CREW_ACP_BIN: bin, KIROCREW_HOME: home } });
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
      const result = crewAvailability({ env: { MICHI_CREW_ACP_BIN: bin, KIROCREW_HOME: home } });
      assert.equal(result.available, false);
      assert.match(result.detail ?? '', /setup incomplete.*Stub \/ Routed/);
    }
  });

  test('unavailable while the app is installed but disabled', () => {
    const bin = executable(tempDir());
    const result = crewAvailability({
      env: { MICHI_CREW_ACP_BIN: bin, KIROCREW_HOME: crewHomeWithSecret('michi-crew-runtime', false) },
    });
    assert.equal(result.available, false);
    assert.match(result.detail ?? '', /Enable the Kiro Crew app michi-crew-runtime/);
  });

  test('outdated App is explained without reading credentials and current App recovers', () => {
    const home = crewHomeWithSecret();
    const manifestFile = path.join(home, 'apps/michi-crew-runtime/app.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: '0.5.0' }));
    const status = crewIntegrationStatus({ KIROCREW_HOME: home });
    assert.equal(status.updateRequired, true);
    assert.equal(status.expectedVersion, CREW_APP_VERSION);
    assert.match(crewAvailability({ env: { KIROCREW_HOME: home } }).detail ?? '', /App update required.*Sync/);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal(crewIntegrationStatus({ KIROCREW_HOME: home }).updateRequired, false);
    assert.equal(crewAppNeedsSync('0.10.0', '0.6.0'), false);
    assert.equal(crewAppNeedsSync('0.5.9', '0.6.0'), true);
    assert.equal(crewAppNeedsSync('malformed'), true);
  });

  test('unavailable when no adapter resolves, even with a secret', () => {
    const dir = tempDir();
    const result = crewAvailability({
      env: { KIROCREW_HOME: crewHomeWithSecret() },
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
  test('forkSession refuses non-chat owners', async () => {
    const runtime = createCrew();
    await assert.rejects(
      runtime.forkSession({ cwd: '/tmp/a', sessionId: 'child', parentChatId: 'parent', sourceNativeSessionId: 'sid', owner: { kind: 'agent_run' } } as any),
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

  test('KiroSession runtimeId defaults to kiro and accepts crew', () => {
    const fake = {} as KiroRuntime;
    assert.equal(new KiroSession('n1', 's1', fake, '/tmp').runtimeId, 'kiro');
    assert.equal(new KiroSession('n2', 's2', fake, '/tmp', { runtimeId: 'crew' }).runtimeId, 'crew');
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
      const runtime = { id, ensureClient: async () => client, getCurrentMode: () => null, getCurrentModel: () => null } as unknown as KiroRuntime;
      const session = new KiroSession('node', 'sid', runtime, '/tmp', { runtimeId: id });
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

  test('launch override can extend only its own cancel watchdog', () => {
    const defaultClient = new AcpClient('/bin/false', '/tmp');
    const crewClient = new AcpClient(undefined, '/tmp', undefined, 'v2', {
      bin: process.execPath,
      args: () => [],
      cancelTimeoutMs: 15_000,
    });
    assert.equal((defaultClient as any).cancelTimeoutMs, 5_000);
    assert.equal((crewClient as any).cancelTimeoutMs, 15_000);
  });
});
