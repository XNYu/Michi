import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as root from '../src';
import type {
  AgentRunToolInvoker,
  AgentRunToolSessionBinding,
  AgentToolBridge,
  McpHttpEndpoint,
  McpSlot,
  McpSlotCallbacks,
  McpSlotProvider,
  McpSlotRebindPatch,
} from '../src';
import * as tools from '../src/contract/tools';

const invoker = (label: string): AgentRunToolInvoker => ({ invoke: async () => ({ label }) });

const bridgeWith = (over: Partial<AgentToolBridge> = {}): AgentToolBridge => ({
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
  ...over,
});

const BINDING: AgentRunToolSessionBinding = {
  runtimeId: 'kiro',
  sessionId: 'session-1',
  owner: { mode: 'headless', key: 'attempt-1' },
  ownerUserId: 'user-1',
  workspaceId: 'ws-1',
  nodeId: null,
};

describe('tool contracts', () => {
  it('the package root exports the tool contract values', () => {
    assert.equal(root.AGENT_RUN_TOOL_NAMES, tools.AGENT_RUN_TOOL_NAMES);
    assert.equal(root.SUBMIT_AGENT_RESULT_TOOL, tools.SUBMIT_AGENT_RESULT_TOOL);
    assert.equal(root.resolveAgentRunToolsForSession, tools.resolveAgentRunToolsForSession);
  });

  it('names the Agent Run tools and the result tool', () => {
    assert.deepEqual([...tools.AGENT_RUN_TOOL_NAMES], [
      'list_agents', 'spawn_agent', 'check_agent', 'wait_agent',
      'send_agent_input', 'cancel_agent', 'watch_agent_runs', 'update_agent_watch',
    ]);
    assert.equal(tools.SUBMIT_AGENT_RESULT_TOOL, 'submit_agent_result');
  });

  it('binds Agent Run tools through the session factory with a frozen copy of the binding', () => {
    const seen: Array<Readonly<AgentRunToolSessionBinding>> = [];
    const bound = invoker('bound');
    const bridge = bridgeWith({
      agentRuns: invoker('singleton'),
      agentRunToolsForSession: (binding) => { seen.push(binding); return bound; },
    });
    assert.equal(tools.resolveAgentRunToolsForSession(bridge, BINDING), bound);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], BINDING);
    assert.notEqual(seen[0], BINDING);
    assert.notEqual(seen[0].owner, BINDING.owner);
    assert.ok(Object.isFrozen(seen[0]));
    assert.ok(Object.isFrozen(seen[0].owner));
    assert.ok(!Object.isFrozen(BINDING));
  });

  it('answers null when the session factory declines, without falling back to the singleton', () => {
    const bridge = bridgeWith({ agentRuns: invoker('singleton'), agentRunToolsForSession: () => undefined });
    assert.equal(tools.resolveAgentRunToolsForSession(bridge, BINDING), null);
  });

  it('falls back to the singleton invoker, or null, without a session factory', () => {
    const singleton = invoker('singleton');
    assert.equal(tools.resolveAgentRunToolsForSession(bridgeWith({ agentRuns: singleton }), BINDING), singleton);
    assert.equal(tools.resolveAgentRunToolsForSession(bridgeWith(), BINDING), null);
  });
});

/** A host without Michi's product tools: the required host extensions are no-ops. */
function inMemoryProvider(baseUrl: string): McpSlotProvider {
  const slots = new Map<string, McpSlot>();
  const endpointFor = (path: string): McpHttpEndpoint => ({ type: 'http', url: `${baseUrl}${path}`, headers: [] });
  let next = 0;
  return {
    create(parentChatId, cwd, ownerUserId, cbs: McpSlotCallbacks, opts) {
      // The sink is for the host's own tools (this host has none), never for the binding.
      const { sink: _sink, ...callbacks } = cbs;
      const slot: McpSlot = {
        slotId: `slot${next++}`,
        nodeId: opts?.nodeId ?? null,
        parentChatId,
        cwd,
        workspaceId: opts?.workspaceId ?? null,
        ownerUserId,
        ...callbacks,
      };
      slots.set(slot.slotId, slot);
      return slot;
    },
    get: (slotId) => slots.get(slotId),
    async dispose(slotId) { slots.delete(slotId); },
    createSessionGroup: () => 'group0',
    bindSession() {},
    beginSessionTurn: () => () => {},
    endSessionTurn() {},
    disposeSessionGroup() {},
    endpoint: (slotId) => endpointFor(`/mcp/${slotId}`),
    sessionEndpoint: (groupId) => endpointFor(`/mcp-session/${groupId}`),
    hookEndpoint: (slotId, hook) => `${baseUrl}/hooks/${slotId}/${hook}`,
    rebind(slotId, patch: McpSlotRebindPatch) {
      const slot = slots.get(slotId);
      if (slot) Object.assign(slot, patch);
    },
  };
}

describe('MCP slot provider contract', () => {
  it('a host without Michi tools implements it with no-op host extensions', async () => {
    const provider = inMemoryProvider('http://127.0.0.1:4000/api');
    const slot = provider.create('session-1', '/tmp', null, {
      sink: { emit: () => {} },
      onSpawnBranches: async () => [],
      onSaveArtifact: () => null,
      onUpdateArtifact: () => null,
    });
    assert.equal(provider.get(slot.slotId), slot);
    assert.equal('sink' in slot, false, 'the sink stays off the binding');
    assert.deepEqual(provider.endpoint(slot.slotId), { type: 'http', url: `http://127.0.0.1:4000/api/mcp/${slot.slotId}`, headers: [] });
    provider.rebind(slot.slotId, { parentChatId: 'session-2', nodeId: 'node-2' });
    assert.equal(provider.get(slot.slotId), slot);
    assert.equal(slot.parentChatId, 'session-2');
    assert.equal(slot.nodeId, 'node-2');
    await provider.dispose(slot.slotId);
    assert.equal(provider.get(slot.slotId), undefined);
  });
});
