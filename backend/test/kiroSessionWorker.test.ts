/**
 * The host a Kiro runtime runs on. Construction requires the ports the
 * runtime reads. A v3 session worker (an isolated kiro-cli process per
 * session) is part of its parent runtime: it runs on the parent's host,
 * slot provider and session directory, and the MCP URL its session receives
 * comes from that provider, not from a port the worker works out for itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { AcpAgentFlavor } from 'michi-runtime/internal/adapters/kiro/acpAgentFlavor';
import { CREW_KIRO_FLAVOR } from 'michi-runtime/internal/adapters/crew/crewFlavor';
import type { AgentSession } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { RuntimeHostConfigError } from 'michi-runtime/internal/contract/host';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { runOwner } from './helpers/owners';

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

test('a v3 session worker shares its parent\'s host and slot provider', async (t) => {
  const previousCloud = process.env.MICHI_CLOUD;
  delete process.env.MICHI_CLOUD;
  t.after(() => { if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud; });
  const servers: unknown[] = [];
  t.mock.method(AcpClient.prototype, 'start', () => {});
  t.mock.method(AcpClient.prototype, 'initialize', async () => {});
  t.mock.method(AcpClient.prototype, 'isAlive', () => true);
  t.mock.method(AcpClient.prototype, 'shutdown', async () => {});
  t.mock.method(AcpClient.prototype, 'cancel', async () => false);
  t.mock.method(AcpClient.prototype, 'newSession', async (mcpServers: unknown[]) => {
    servers.push(mcpServers);
    return { sessionId: 'native-run', modes: { currentModeId: 'default' } };
  });
  const host = michiTestHost();
  const registry = fakeMcpRegistry({}, { mcpPort: 45678 });
  const runtime = new AcpAgentRuntime({ bridge, mcpSlots: registry, defaultCwd: '/tmp/michi-kiro-worker', host, engine: 'v3' });
  t.after(() => runtime.shutdown());

  // Local v3 chats share one MCP group; an Agent Run gets its own worker.
  const session: AgentSession = await runtime.newSession({
    sessionId: 'attempt-1', cwd: '/tmp/michi-kiro-worker',
    owner: runOwner('run-1', 'attempt-1'),
    toolProfile: { allowedToolNames: [] },
  });
  const worker = (runtime as unknown as { sessionWorkers: Map<string, AcpAgentRuntime> }).sessionWorkers.get('attempt-1');
  assert.ok(worker instanceof AcpAgentRuntime && worker !== runtime, 'the Run opened on a session worker');
  assert.equal(worker.host, host, 'same host');
  assert.equal((worker as unknown as { mcpRegistry: unknown }).mcpRegistry, registry, 'same slot provider');

  const slotId = worker.getBinding(session.id)?.slotId;
  assert.ok(slotId && registry.slots.has(slotId), 'the worker allocated its slot from the parent\'s provider');
  assert.deepEqual(servers, [[{
    name: 'michi', type: 'http', url: `http://127.0.0.1:45678/api/mcp/${slotId}`, headers: [],
    _meta: { kiro: { waitForReady: true, versionNegotiation: 'legacy' } },
  }]]);
  assert.deepEqual(registry.endpoint(slotId).url, `http://127.0.0.1:45678/api/mcp/${slotId}`);

  // Same session directory: the worker's session, registered as its owner
  // registers it, is the one the parent and the worker both look up.
  sessionRegistry.registerSession(session, null);
  t.after(() => sessionRegistry.dropSession(session.id));
  assert.equal(sessionRegistry.getSession(session.id), session, 'the process-wide directory holds the worker\'s session');
  assert.equal(runtime.getBinding(session.id), worker.getBinding(session.id), 'the parent resolves the worker\'s binding');
});

test('a Kiro runtime refuses a host without the ports it reads', () => {
  const host = michiTestHost();
  const construct = (overrides: Partial<typeof host>, options: { engine?: 'v2' | 'v3'; id?: string; flavor?: AcpAgentFlavor } = {}) =>
    () => new AcpAgentRuntime({ bridge, defaultCwd: '/tmp/michi-kiro-worker', ...options, host: { ...host, ...overrides } });
  const missing = (ports: string[]) => (error: unknown) => error instanceof RuntimeHostConfigError
    && JSON.stringify(error.missing) === JSON.stringify(ports);
  assert.throws(construct({ backgroundTurns: undefined }), missing(['backgroundTurns']));
  assert.throws(construct({ workflows: undefined }, { engine: 'v3' }), missing(['workflows']));
  assert.doesNotThrow(construct({ workflows: undefined }, { engine: 'v2' }));
  assert.throws(construct({ bindings: { ...host.bindings, crewMemory: undefined } }, { engine: 'v2', id: 'crew', flavor: CREW_KIRO_FLAVOR }),
    missing(['bindings.crewMemory']));
  assert.doesNotThrow(construct({ bindings: { ...host.bindings, crewMemory: undefined } }, { engine: 'v2' }));
});
