import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpSlotProvider } from '../src/contract/mcp';
import type { AgentToolBridge } from '../src/contract/tools';
import { createDefaultHost } from '../src/core/defaultHost';
import { AcpAgentRuntime } from '../src/adapters/kiro/AcpAgentRuntime';
import { KIRO_FLAVOR, joinSessionMetadata } from '../src/adapters/kiro/acpAgentFlavor';
import type { AcpLaunch } from '../src/adapters/kiro/acpClient';
import { CREW_APP_VERSION } from '../src/adapters/crew/crewAppVersion';
import {
  CREW_KIRO_FLAVOR, CREW_STATIC_DESCRIPTOR, createCrewRuntime, type CrewAdapterOptions, type CrewRuntimeOptions,
} from '../src/adapters/crew/index';
import { CREW_ACP_MAIN } from './helpers/adapterPaths';

const bridge: AgentToolBridge = {};
// Only stored at construction; the descriptor reads whether it is there.
const mcpSlots = {} as McpSlotProvider;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-crew-preset-'));
  tempDirs.push(dir);
  return dir;
}

function executable(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

/** A Kiro Crew home whose App is installed, enabled and set up. */
function crewHome(app = 'michi-crew-runtime'): string {
  const home = tempDir();
  const dir = path.join(home, 'apps', app);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.app_secret'), '');
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ version: CREW_APP_VERSION, permissions: { sessionApproval: true }, mcpServers: { michi: {} } }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mcp_gateway: { stub_servers: [`${app}:michi`] } }));
  return home;
}

/** Locations where no adapter resolves and no App is installed. */
function nowhere(): CrewAdapterOptions {
  const dir = tempDir();
  return { bundledScript: path.join(dir, 'crewAcp.js'), sourceMain: path.join(dir, 'main.ts'), kirocrewHome: dir };
}

function crew(options: Partial<CrewRuntimeOptions> = {}): AcpAgentRuntime {
  return createCrewRuntime({ host: createDefaultHost({ logLevel: 'silent' }), bridge, mcpSlots, ...options });
}

/** The options the preset passed AcpAgentRuntime. */
function kiroOptions(runtime: AcpAgentRuntime): Record<string, unknown> & { launch: AcpLaunch } {
  return (runtime as any).runtimeOptions;
}

const CREW_CAPABILITIES = {
  modes: true,
  permissions: true,
  models: true,
  providerModels: false,
  reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  apiKeys: false,
  warmSessions: false,
  saveContext: true,
  spawnBranches: true,
  nativeResume: true,
  nativeResumeSettings: ['model', 'reasoning'],
};

describe('createCrewRuntime', () => {
  it("pins Crew's id, label, engine, flavor, descriptor and capabilities", () => {
    const runtime = crew({ crew: nowhere() });
    assert.ok(runtime instanceof AcpAgentRuntime);
    assert.equal(runtime.id, 'crew');
    assert.equal(runtime.label, 'Kiro Crew');
    assert.equal(runtime.engine, 'v2');
    assert.equal(runtime.flavor, CREW_KIRO_FLAVOR);
    assert.deepEqual(runtime.descriptor, CREW_STATIC_DESCRIPTOR);
    assert.deepEqual(runtime.capabilities, CREW_CAPABILITIES);
  });

  it('keeps its pins over the same members from an untyped caller', () => {
    const runtime = crew({
      crew: nowhere(),
      engine: 'v3', id: 'kiro', label: 'Kiro', flavor: KIRO_FLAVOR, sidecarTitles: true,
      launch: { bin: 'kiro-cli', args: () => [] }, descriptorOverride: {}, capabilitiesOverride: { warmSessions: true },
      checkAvailability: () => ({ available: true }),
    } as Partial<CrewRuntimeOptions>);
    assert.equal(runtime.id, 'crew');
    assert.equal(runtime.label, 'Kiro Crew');
    assert.equal(runtime.engine, 'v2');
    assert.equal(runtime.flavor, CREW_KIRO_FLAVOR);
    assert.deepEqual(runtime.descriptor, CREW_STATIC_DESCRIPTOR);
    assert.deepEqual(runtime.capabilities, CREW_CAPABILITIES);
    assert.equal(kiroOptions(runtime).launch.bin, process.execPath);
    assert.equal(runtime.checkAvailability().available, false);
  });

  it('passes the rest of its options to AcpAgentRuntime, and not its own', () => {
    const runtime = crew({ crew: nowhere(), processCap: 7, defaultCwd: '/tmp/crew-default' });
    const options = kiroOptions(runtime);
    assert.equal(options.processCap, 7);
    assert.equal(options.bridge, bridge);
    assert.equal(options.mcpSlots, mcpSlots);
    assert.equal((runtime as any).defaultCwd, '/tmp/crew-default');
    assert.equal('crew' in options, false);
  });

  it('opens no sidecar title session where a Kiro runtime would', async () => {
    const host = createDefaultHost({
      logLevel: 'silent',
      titleModels: { kiro: { model: 'title-model', timeoutMs: 1_000 }, crew: { model: 'title-model', timeoutMs: 1_000 } },
      ports: { title: { enabled: () => true, prompt: () => '' } },
    });
    assert.notEqual((new AcpAgentRuntime({ host, bridge }) as any).titleGenerator, null);
    const runtime = createCrewRuntime({ host, bridge, mcpSlots, crew: nowhere() });
    assert.equal((runtime as any).titleGenerator, null);
    assert.equal(await runtime.generateTitle({ userText: 'hello' }), null);
    assert.equal(runtime.descriptor.topology.titles, 'native-update');
  });

  it('checks availability at the locations given, read again at each check', async () => {
    const acpBinOverride = executable(tempDir(), 'crew-acp');
    let locations: CrewAdapterOptions = { acpBinOverride, kirocrewHome: tempDir() };
    const runtime = crew({ crew: () => locations });
    const unavailable = runtime.checkAvailability();
    assert.equal(unavailable.available, false);
    assert.match(unavailable.detail ?? '', /Install and enable the Kiro Crew app michi-crew-runtime/);
    await assert.rejects(runtime.ensureClient(tempDir()), /Install and enable the Kiro Crew app/);

    locations = { acpBinOverride, kirocrewHome: crewHome() };
    assert.deepEqual(runtime.checkAvailability(), { available: true });

    const named = crew({ crew: { acpBinOverride, kirocrewHome: crewHome('other-app'), appName: 'other-app' } });
    assert.deepEqual(named.checkAvailability(), { available: true });
  });

  it('resolves its launch at each spawn, following acpBinOverride', () => {
    const dir = tempDir();
    const first = executable(dir, 'crew-acp-1');
    const second = executable(dir, 'crew-acp-2');
    const bundledScript = path.join(dir, 'crewAcp.js');
    let locations: CrewAdapterOptions = { acpBinOverride: first, bundledScript };
    const { launch } = kiroOptions(crew({ crew: () => locations }));
    assert.equal(launch.standardFork, true);
    assert.equal(launch.cancelTimeoutMs, 15_000);
    assert.equal(launch.bin, first);
    assert.deepEqual(launch.args('m1'), ['acp', '--agent-engine', 'v2', '--model', 'm1']);

    locations = { acpBinOverride: second, bundledScript };
    assert.equal(launch.bin, second);

    fs.writeFileSync(bundledScript, '');
    locations = { bundledScript };
    assert.equal(launch.bin, process.execPath);
    assert.deepEqual(launch.args(), [bundledScript, 'acp', '--agent-engine', 'v2']);
  });

  it('looks for the adapter next to its own module by default', () => {
    // No bundle next to the source; the source entry runs under ts-node.
    const { launch } = kiroOptions(crew());
    assert.equal(launch.bin, process.execPath);
    assert.deepEqual(launch.args(), ['--require', require.resolve('ts-node/register'), CREW_ACP_MAIN, 'acp', '--agent-engine', 'v2']);
  });

  it('launches a child that exits at once with a readable line when no adapter resolves', () => {
    const runtime = crew({ crew: nowhere() });
    assert.match(runtime.checkAvailability().detail ?? '', /Kiro Crew ACP adapter not found/);
    const { launch } = kiroOptions(runtime);
    assert.equal(launch.bin, process.execPath);
    assert.deepEqual(launch.args('m1'), [
      '-e', "process.stderr.write('Kiro Crew ACP adapter not found; set MICHI_CREW_ACP_BIN\\n'); process.exit(1)",
    ]);
    const child = spawnSync(launch.bin, launch.args(), { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, 'Kiro Crew ACP adapter not found; set MICHI_CREW_ACP_BIN\n');
  });
});

describe('Crew flavor session metadata', () => {
  it("names the new session's workspace, and nothing without one", () => {
    const host = createDefaultHost({ logLevel: 'silent', workspaces: [
      { id: 'ws', name: '  Michi  ' }, { id: 'blank', name: '   ' }, { id: 'unnamed' },
    ] });
    const metadata = (workspaceId?: string) => CREW_KIRO_FLAVOR.sessionMetadata?.(host, { cwd: '/w', workspaceId });
    assert.deepEqual(metadata('ws'), { crew: { workspaceName: 'Michi' } });
    assert.equal(metadata('blank'), undefined);
    assert.equal(metadata('unnamed'), undefined);
    assert.equal(metadata('missing'), undefined);
    assert.equal(metadata(undefined), undefined);
  });

  it('joins with the memory metadata inside the shared crew namespace', () => {
    assert.deepEqual(
      joinSessionMetadata({ crew: { memoryMode: 'persistent' }, kiro: { a: 1 } }, { crew: { workspaceName: 'Michi' } }),
      { crew: { memoryMode: 'persistent', workspaceName: 'Michi' }, kiro: { a: 1 } },
    );
    assert.deepEqual(joinSessionMetadata(undefined, { crew: { workspaceName: 'Michi' } }), { crew: { workspaceName: 'Michi' } });
    assert.deepEqual(joinSessionMetadata({ crew: { memoryMode: 'temporary' } }, undefined), { crew: { memoryMode: 'temporary' } });
    assert.equal(joinSessionMetadata(undefined, undefined), undefined);
  });
});
