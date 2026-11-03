import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeDescriptor, RuntimeRunFacet, RuntimeTopology } from 'michi-runtime/internal/contract/descriptor';
import { descriptorOf, UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';
import { describeRuntimeCapabilities } from '../src/agents/capabilityDescriptors';
import { AcpAgentRuntime, type KiroAdapterOptions } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { RUNTIME_FACTORIES, type RuntimeFactoryDeps } from '../src/agents/runtimeFactories';
import { STATIC_RUNTIME_DESCRIPTORS, staticRuntimeDescriptor } from '../src/agents/runtimeStaticDescriptors';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { RuntimeRunAdapter } from '../src/agents/runs/runtimeRunAdapter';
import type { AgentRuntime } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import { michiTestHost } from './helpers/michiTestHost';
import { codexTestOptions } from './helpers/codexTestOptions';

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const mcpRegistry = { create: () => ({ slotId: 'slot' }), dispose: async () => {}, get: () => undefined } as unknown as McpSlotRegistry;
const codexClient = {
  onServerRequest: () => {}, onExit: () => {}, ensureStarted: async () => {}, shutdown: async () => {},
} as unknown as CodexAppServerClient;

const created: AgentRuntime[] = [];
after(async () => { await Promise.all(created.map((runtime) => runtime.shutdown())); });
function track<T extends AgentRuntime>(runtime: T): T {
  created.push(runtime);
  return runtime;
}

/** Env the descriptors read; unset means the default configuration. */
const DESCRIPTOR_ENV = ['MICHI_CLOUD', 'MICHI_KIRO_ENGINE', 'MICHI_TITLE_MODEL_KIRO'] as const;

function withEnv<T>(env: Partial<Record<(typeof DESCRIPTOR_ENV)[number], string>>, build: () => T): T {
  const saved = Object.fromEntries(DESCRIPTOR_ENV.map((key) => [key, process.env[key]]));
  for (const key of DESCRIPTOR_ENV) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return build(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function kiro(options: Omit<KiroAdapterOptions, 'host'>, env: { cloud?: boolean; mcp?: boolean; sidecarModel?: string } = {}): AcpAgentRuntime {
  return withEnv({ MICHI_CLOUD: env.cloud ? '1' : undefined, MICHI_TITLE_MODEL_KIRO: env.sidecarModel },
    () => track(new AcpAgentRuntime({ bridge, mcpSlots: env.mcp ? mcpRegistry : undefined, defaultCwd: '/tmp/michi-descriptors', ...options, host: michiTestHost() })));
}

function factory(id: string) {
  const found = RUNTIME_FACTORIES.find((candidate) => candidate.id === id);
  assert.ok(found, `${id} factory registered`);
  return found;
}

function create(id: string, deps: Partial<RuntimeFactoryDeps> = {}): AgentRuntime {
  return withEnv({}, () => track(factory(id).create({ bridge, mcpRegistry, mcpPort: 0, defaultCwd: '/tmp/michi-descriptors', host: michiTestHost(), ...deps })));
}

const KIRO_TOPOLOGY: RuntimeTopology = {
  identityTiming: 'on-open',
  // kiro-cli settles a cancelled prompt with stopReason "cancelled".
  cancel: 'native-ack',
  toolDelivery: ['mcp-http'],
  historyReplay: 'preamble',
  backgroundTurns: false,
  titles: 'sidecar',
  hostTitleRequiresOptIn: true,
  clearCreatesNewNativeSession: false,
};
const KIRO_V3_TOPOLOGY: RuntimeTopology = { ...KIRO_TOPOLOGY, backgroundTurns: true, workflowsRequireOptIn: true, clearCreatesNewNativeSession: true };

/**
 * Agent Run behavior as the Run adapters declared it before it moved into
 * the descriptors (bda6720a: backend/src/agents/runs/*RunAdapter.ts), with
 * the adapters' own fields in their original order.
 */
const PRE_DESCRIPTOR_RUN: Record<string, { run: RuntimeRunFacet; adapterKeys: string[] }> = {
  pi: {
    run: { toolMode: 'allowlist', steering: 'native', immediateSteering: 'next_turn', supportsNativeResume: false },
    adapterKeys: ['runtimeId', 'supportsNativeResume', 'nativeToolMode', 'steering', 'immediateSteering'],
  },
  claude: {
    run: { toolMode: 'allowlist', steering: 'next_turn', supportsNativeResume: true },
    adapterKeys: ['runtimeId', 'supportsNativeResume', 'nativeToolMode', 'steering'],
  },
  kiro: {
    run: { toolMode: 'runtime_default', steering: 'native', immediateSteering: 'next_turn', supportsNativeResume: true },
    adapterKeys: ['runtimeId', 'supportsNativeResume', 'nativeToolMode', 'steering', 'immediateSteering'],
  },
  codex: {
    run: { toolMode: 'runtime_default', steering: 'native', immediateSteering: 'next_turn', supportsNativeResume: true },
    adapterKeys: ['runtimeId', 'supportsNativeResume', 'nativeToolMode', 'steering', 'immediateSteering'],
  },
};

// Snapshot of topology and run. Run must keep matching PRE_DESCRIPTOR_RUN;
// topology has no pre-descriptor form and is pinned from this commit on.
// Regenerate (only for an intended change) with MICHI_WRITE_DESCRIPTOR_GOLDEN=1.
const SNAPSHOT = path.join(__dirname, 'fixtures', 'runtimeDescriptors', 'topologyAndRun.json');

function topologyAndRun(descriptor: RuntimeDescriptor | undefined) {
  assert.ok(descriptor);
  return { topology: descriptor.topology, run: descriptor.run };
}

describe('runtime descriptors', () => {
  test('each factory describes its runtime without an instance, as describeRuntimeCapabilities did', () => {
    for (const { id, staticDescriptor } of RUNTIME_FACTORIES) {
      assert.equal(staticRuntimeDescriptor(id), staticDescriptor, id);
      assert.equal(JSON.stringify(staticDescriptor.harness), JSON.stringify(describeRuntimeCapabilities(id)), id);
    }
    // One table: every factory id and nothing else.
    assert.deepEqual(Object.keys(STATIC_RUNTIME_DESCRIPTORS).sort(), RUNTIME_FACTORIES.map(({ id }) => id).sort());
    for (const id of ['unknown-runtime', 'constructor', '__proto__', 'toString', '']) {
      assert.equal(staticRuntimeDescriptor(id), UNKNOWN_RUNTIME_DESCRIPTOR, id);
    }
  });

  test('under default configuration an instance describes itself as its static descriptor', () => {
    for (const { id, staticDescriptor } of RUNTIME_FACTORIES) {
      // Kiro starts v3 by default; its static descriptor stays the v2 table.
      if (id === 'kiro') {
        assert.equal(create(id).nativeEngine, 'v3');
        assert.deepEqual(create(id).descriptor, kiro({ engine: 'v3' }, { mcp: true }).descriptor, id);
        continue;
      }
      assert.deepEqual(create(id).descriptor, staticDescriptor, id);
    }
  });

  test('instances carry their own descriptor', () => {
    const runtimes: AgentRuntime[] = [
      kiro({ engine: 'v2' }, { mcp: true }), kiro({ engine: 'v3' }, { mcp: true }),
      create('crew'),
      track(new CodexRuntime({ ...codexTestOptions(), bridge, mcpSlots: mcpRegistry }, { client: codexClient, followUpsHookPocEnabled: false })),
      track(new ClaudeRuntime({ ...claudeTestOptions(), bridge, mcpSlots: mcpRegistry })),
      track(new PiRuntime(bridge)),
    ];
    for (const runtime of runtimes) {
      assert.ok(runtime.descriptor, runtime.id);
      // Kiro computes it on each read from what its clients negotiated.
      assert.deepEqual(descriptorOf(runtime), runtime.descriptor, runtime.id);
      assert.equal(runtime.descriptor.spec, 1);
      // The harness is read from the descriptor; no runtime keeps the old field.
      assert.equal('capabilityDescriptor' in runtime, false, runtime.id);
    }
  });

  test('Kiro topology follows engine, MCP slots and sidecar titles', () => {
    assert.deepEqual(kiro({ engine: 'v2' }, { mcp: true }).descriptor.topology, KIRO_TOPOLOGY);
    assert.deepEqual(kiro({ engine: 'v2' }).descriptor.topology, { ...KIRO_TOPOLOGY, toolDelivery: [] });
    assert.deepEqual(kiro({ engine: 'v2' }, { mcp: true, sidecarModel: 'off' }).descriptor.topology, { ...KIRO_TOPOLOGY, titles: 'none' });
    // Local v3 chats share one MCP group per cwd; Agent Runs get their own slot on a worker.
    assert.deepEqual(kiro({ engine: 'v3' }, { mcp: true }).descriptor.topology,
      { ...KIRO_V3_TOPOLOGY, toolDelivery: ['mcp-http-grouped', 'mcp-http'] });
    assert.deepEqual(kiro({ engine: 'v3' }, { mcp: true, cloud: true }).descriptor.topology, KIRO_V3_TOPOLOGY);
    assert.deepEqual(kiro({ engine: 'v3' }).descriptor.topology, { ...KIRO_V3_TOPOLOGY, toolDelivery: [] });
    assert.deepEqual(kiro({ engine: 'v3', isolatedSession: true }, { mcp: true }).descriptor.topology, KIRO_V3_TOPOLOGY);
  });

  test('Crew is a Kiro v2 preset with its own tool path and titles, and no Agent Runs', () => {
    const crew = create('crew');
    // Crew titles its own sessions, so Kiro's opt-in for host titles does not apply.
    const { hostTitleRequiresOptIn: _kiroOnly, ...crewTopology } = KIRO_TOPOLOGY;
    // The Gateway's stop record acknowledges a cancel (probed on 0.11.0.1).
    assert.deepEqual(crew.descriptor?.topology, { ...crewTopology, cancel: 'native-ack', toolDelivery: ['mcp-relay'], titles: 'native-update' });
    assert.equal(crew.descriptor?.run, null);
    assert.deepEqual(create('crew', { mcpRegistry: undefined }).descriptor?.topology.toolDelivery, []);
    const underV3 = withEnv({ MICHI_KIRO_ENGINE: 'v3' }, () => track(factory('crew').create({ bridge, mcpRegistry, mcpPort: 0, host: michiTestHost() })));
    assert.equal(underV3.descriptor?.topology.backgroundTurns, false);
  });

  test('Codex, Claude and Pi topology', () => {
    assert.deepEqual(factory('codex').staticDescriptor.topology, {
      identityTiming: 'on-open', cancel: 'native-ack', toolDelivery: ['mcp-http'],
      historyReplay: 'preamble', backgroundTurns: false, titles: 'in-stream',
    });
    assert.deepEqual(factory('claude').staticDescriptor.topology, {
      identityTiming: 'on-first-turn', cancel: 'native-ack', toolDelivery: ['mcp-http'],
      historyReplay: 'preamble', backgroundTurns: true, titles: 'none',
    });
    assert.deepEqual(factory('pi').staticDescriptor.topology, {
      identityTiming: 'none', cancel: 'native-ack', toolDelivery: ['in-process'],
      historyReplay: 'messages', backgroundTurns: false, titles: 'none',
    });
  });

  test('run facets keep the Run adapters\' pre-descriptor values', () => {
    for (const [id, { run }] of Object.entries(PRE_DESCRIPTOR_RUN)) {
      assert.deepEqual(factory(id).staticDescriptor.run, run, id);
    }
    assert.equal(factory('crew').staticDescriptor.run, null);
    // The Kiro facet is the same on every engine.
    assert.deepEqual(kiro({ engine: 'v3' }, { mcp: true }).descriptor.run, PRE_DESCRIPTOR_RUN.kiro.run);
  });

  test('Run adapters expose the pre-descriptor fields, values and shape', () => {
    const adapters: RuntimeRunAdapter[] = [new PiRunAdapter(), new ClaudeRunAdapter(), new KiroRunAdapter(), new CodexRunAdapter()];
    assert.deepEqual(adapters.map((adapter) => adapter.runtimeId), Object.keys(PRE_DESCRIPTOR_RUN));
    for (const adapter of adapters) {
      const { run, adapterKeys } = PRE_DESCRIPTOR_RUN[adapter.runtimeId];
      assert.deepEqual(Object.keys(adapter), adapterKeys, adapter.runtimeId);
      assert.equal(adapter.nativeToolMode, run.toolMode, adapter.runtimeId);
      assert.equal(adapter.steering, run.steering, adapter.runtimeId);
      assert.equal(adapter.immediateSteering, run.immediateSteering, adapter.runtimeId);
      assert.equal(adapter.supportsNativeResume, run.supportsNativeResume, adapter.runtimeId);
    }
  });

  test('topology and run snapshot', () => {
    const snapshot = {
      static: Object.fromEntries(RUNTIME_FACTORIES.map(({ id, staticDescriptor }) => [id, topologyAndRun(staticDescriptor)])),
      instances: {
        'kiro-v2': topologyAndRun(kiro({ engine: 'v2' }, { mcp: true }).descriptor),
        'kiro-v2-without-mcp': topologyAndRun(kiro({ engine: 'v2' }).descriptor),
        'kiro-v2-sidecar-off': topologyAndRun(kiro({ engine: 'v2' }, { mcp: true, sidecarModel: 'off' }).descriptor),
        'kiro-v3-local': topologyAndRun(kiro({ engine: 'v3' }, { mcp: true }).descriptor),
        'kiro-v3-cloud': topologyAndRun(kiro({ engine: 'v3' }, { mcp: true, cloud: true }).descriptor),
        'kiro-v3-without-mcp': topologyAndRun(kiro({ engine: 'v3' }).descriptor),
        'kiro-v3-isolated-worker': topologyAndRun(kiro({ engine: 'v3', isolatedSession: true }, { mcp: true }).descriptor),
        crew: topologyAndRun(create('crew').descriptor),
        'crew-without-mcp': topologyAndRun(create('crew', { mcpRegistry: undefined }).descriptor),
        codex: topologyAndRun(create('codex').descriptor),
        claude: topologyAndRun(create('claude').descriptor),
        pi: topologyAndRun(create('pi').descriptor),
      },
    };
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (process.env.MICHI_WRITE_DESCRIPTOR_GOLDEN === '1') fs.writeFileSync(SNAPSHOT, text);
    assert.equal(text, fs.readFileSync(SNAPSHOT, 'utf8'));
  });
});
