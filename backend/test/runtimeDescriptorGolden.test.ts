// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describeRuntimeCapabilities } from '../src/agents/capabilityDescriptors';
import { AcpAgentRuntime, type KiroAdapterOptions } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { RUNTIME_FACTORIES } from '../src/agents/runtimeFactories';
import { registerRuntime } from '../src/agents/registry';
import { setupAgentRoutes } from '../src/routes/agent';
import { updateAgentConfig } from '../src/services/agentConfig';
import type { AgentRuntime } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import { michiTestHost } from './helpers/michiTestHost';
import { codexTestOptions } from './helpers/codexTestOptions';

// Golden snapshots of what the frontend receives about each runtime's
// capabilities. They were recorded before the descriptors moved into the
// adapter directories; any later byte difference is a wire change.
// Regenerate (only for an intended wire change) with MICHI_WRITE_DESCRIPTOR_GOLDEN=1.

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'runtimeDescriptors');

function assertGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.MICHI_WRITE_DESCRIPTOR_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.equal(text, fs.readFileSync(file, 'utf8'), `${name}.json`);
}

// Pin the environment the status route and the runtimes read.
process.env.MICHI_WEB_SEARCH_ENABLED = '0';
delete process.env.MICHI_CLOUD;

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};
const mcpRegistry = {
  create: () => ({ slotId: 'slot-golden' }),
  dispose: async () => {},
  get: () => undefined,
} as unknown as McpSlotRegistry;
const codexClient = {
  onServerRequest: () => {},
  onExit: () => {},
  ensureStarted: async () => {},
  shutdown: async () => {},
} as unknown as CodexAppServerClient;

const created: AgentRuntime[] = [];
after(async () => {
  await Promise.all(created.map((runtime) => runtime.shutdown()));
});

function track<T extends AgentRuntime>(runtime: T): T {
  created.push(runtime);
  return runtime;
}

function kiro(options: Omit<KiroAdapterOptions, 'host'>, env: { cloud?: boolean; mcp?: boolean } = {}): AcpAgentRuntime {
  if (env.cloud) process.env.MICHI_CLOUD = '1';
  try {
    return track(new AcpAgentRuntime({ bridge, mcpSlots: env.mcp ? mcpRegistry : undefined, defaultCwd: '/tmp/michi-descriptor-golden', ...options, host: michiTestHost() }));
  } finally {
    delete process.env.MICHI_CLOUD;
  }
}

/** An ACP client as negotiated by initialize: only the facts the descriptor reads. */
function negotiated(extensions: readonly string[], fork: boolean) {
  return {
    isAlive: () => true,
    supportsExtension: (method: string) => extensions.includes(method),
    capabilities: { sessionCapabilities: fork ? { fork: {} } : {} },
    shutdown: async () => {},
  };
}

function withClients(runtime: AcpAgentRuntime, ...clients: Array<ReturnType<typeof negotiated>>): AcpAgentRuntime {
  const pool = (runtime as unknown as { pool: Map<string, unknown> }).pool;
  clients.forEach((client, index) => pool.set(`/tmp/michi-descriptor-golden-${index}`, client));
  return runtime;
}

const ALL_V3_EXTENSIONS = ['_kiro/session/compact', '_session/steer'];

function crew(): AgentRuntime {
  const factory = RUNTIME_FACTORIES.find((candidate) => candidate.id === 'crew');
  assert.ok(factory, 'crew factory registered');
  return track(factory.create({ bridge, mcpPort: 0, defaultCwd: '/tmp/michi-descriptor-golden', host: michiTestHost() }));
}

function claude(): ClaudeRuntime {
  return track(new ClaudeRuntime({ ...claudeTestOptions(), bridge, mcpSlots: mcpRegistry }));
}

function codex(): CodexRuntime {
  return track(new CodexRuntime({ ...codexTestOptions(), bridge, mcpSlots: mcpRegistry }, { client: codexClient, followUpsHookPocEnabled: false }));
}

function pi(): PiRuntime {
  return track(new PiRuntime(bridge));
}

describe('runtime capability descriptor golden', () => {
  test('describeRuntimeCapabilities by id, including ids no runtime owns', () => {
    const ids = ['kiro', 'crew', 'pi', 'claude', 'codex', 'cursor', 'constructor', '__proto__', ''];
    assertGolden('describeRuntimeCapabilities', Object.fromEntries(ids.map((id) => [id, describeRuntimeCapabilities(id)])));
  });

  test('capabilityDescriptor of each runtime instance', () => {
    const cloudWorker = withClients(kiro({ engine: 'v3', isolatedSession: true }, { mcp: true }), negotiated(ALL_V3_EXTENSIONS, true));
    const cloud = kiro({ engine: 'v3' }, { cloud: true, mcp: true });
    (cloud as unknown as { sessionWorkers: Map<string, AcpAgentRuntime> }).sessionWorkers.set('chat-golden', cloudWorker);
    const instances: Record<string, AgentRuntime> = {
      'kiro-v2': kiro({ engine: 'v2' }, { mcp: true }),
      'kiro-v2-without-mcp': kiro({ engine: 'v2' }),
      'kiro-v3-local-unnegotiated': kiro({ engine: 'v3' }, { mcp: true }),
      'kiro-v3-local-negotiated': withClients(kiro({ engine: 'v3' }, { mcp: true }), negotiated(ALL_V3_EXTENSIONS, true)),
      'kiro-v3-local-without-steer': withClients(kiro({ engine: 'v3' }, { mcp: true }),
        negotiated(ALL_V3_EXTENSIONS, true), negotiated(['_kiro/session/compact'], true)),
      'kiro-v3-local-partial-compact-fork': withClients(kiro({ engine: 'v3' }, { mcp: true }),
        negotiated(ALL_V3_EXTENSIONS, true), negotiated(['_session/steer'], false)),
      'kiro-v3-cloud-worker': cloud,
      crew: crew(),
      codex: codex(),
      claude: claude(),
      pi: pi(),
    };
    assertGolden('capabilityDescriptor', Object.fromEntries(
      Object.entries(instances).map(([name, runtime]) => [name, runtime.descriptor.harness]),
    ));
  });

  describe('/api/agent/status', () => {
    let server: ReturnType<typeof express.application.listen>;
    let base = '';
    after(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // Fields a runtime descriptor can affect, in response order, plus the key
    // list so a moved or dropped field also shows up. Model, provider and
    // key readiness come from per-machine configuration and stay out.
    const DESCRIPTOR_FIELDS = new Set(['runtime', 'label', 'capabilities', 'capabilityDescriptor', 'availableRuntimes', 'workflowRuntimes']);
    async function status(runtime: string): Promise<Record<string, unknown>> {
      updateAgentConfig({ runtime });
      const response = await fetch(`${base}/agent/status`);
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      return {
        keys: Object.keys(body),
        ...Object.fromEntries(Object.entries(body).filter(([key]) => DESCRIPTOR_FIELDS.has(key))),
      };
    }
    const IDS = ['kiro', 'crew', 'pi', 'claude', 'codex'];

    // Each test registers the runtimes it reports on, so any one of them runs alone.
    before(async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', setupAgentRoutes());
      server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    });

    /** Registers this Kiro instance and the other runtimes, all with pinned availability. */
    function registerRuntimes(kiroRuntime: AcpAgentRuntime): void {
      const piRuntime = pi();
      // Provider readiness reads this machine's keys; the descriptor does not depend on it.
      piRuntime.listProviders = async () => [];
      const runtimes: AgentRuntime[] = [kiroRuntime, crew(), piRuntime, claude(), codex()];
      for (const runtime of runtimes) {
        runtime.checkAvailability = () => ({ available: true });
        registerRuntime(runtime);
      }
    }

    test('configured runtimes without a registered instance', async () => {
      const result: Record<string, unknown> = {};
      for (const id of [...IDS, 'cursor']) result[id] = await status(id);
      assertGolden('agentStatus.unregistered', result);
    });

    test('registered runtime instances with pinned availability', async () => {
      registerRuntimes(kiro({ engine: 'v2' }, { mcp: true }));
      const result: Record<string, unknown> = {};
      for (const id of IDS) result[id] = await status(id);
      assertGolden('agentStatus.registered', result);
    });

    // With a v3 Kiro instance, workflowRuntimes is no longer empty.
    test('a registered Kiro v3 instance lists workflow runtimes', async () => {
      registerRuntimes(kiro({ engine: 'v3' }, { mcp: true }));
      const result: Record<string, unknown> = {};
      for (const id of IDS) result[id] = await status(id);
      assertGolden('agentStatus.registeredKiroV3', result);
    });
  });
});
