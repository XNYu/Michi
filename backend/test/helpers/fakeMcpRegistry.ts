import type {
  McpHttpEndpoint,
  McpSlot,
  McpSlotCallbacks,
  McpSlotProvider,
  McpSlotRebindPatch,
} from 'michi-runtime/internal/contract/mcp';
import { ownerMode } from 'michi-runtime';

/** A chat session group of the fake: its catalog copy, session bindings and open turn windows. */
export interface FakeMcpSessionGroup {
  readonly catalog: McpSlot;
  /** Native session id -> slot id. */
  readonly sessions: Map<string, string>;
  /** Native session ids whose turn window is open. */
  readonly openTurns: Set<string>;
}

/** An in-memory McpSlotProvider whose state tests can read. */
export interface FakeMcpRegistry extends McpSlotProvider {
  /** Live slots by id. get() returns these same objects, and rebind assigns on them. */
  readonly slots: Map<string, McpSlot>;
  readonly sessionGroups: Map<string, FakeMcpSessionGroup>;
}

export interface FakeMcpRegistryOptions {
  /**
   * Port in the endpoint URLs. Default 3000, as McpSlotRegistry's. A function
   * is read each time a URL is built, as McpSlotRegistry reads it.
   */
  mcpPort?: number | (() => number);
}

/** Fields rebind may clear with undefined, and the ones McpSlot requires (undefined leaves them alone). */
const REBIND_OPTIONAL_FIELDS = ['owner', 'exposedToolNames', 'agentRuns', 'agentRunToolNames', 'onSubmitAgentResult'] as const;
const REBIND_REQUIRED_FIELDS = ['parentChatId', 'nodeId', 'workspaceId', 'ownerUserId'] as const;

function assignRebindField<K extends keyof McpSlotRebindPatch>(slot: McpSlot, patch: McpSlotRebindPatch, key: K): void {
  slot[key] = patch[key] as McpSlot[K];
}

function httpEndpoint(url: string): McpHttpEndpoint {
  return { type: 'http', url, headers: [] };
}

/**
 * A typed McpSlotProvider for tests, with every method implemented as
 * McpSlotRegistry (backend/src/services/mcpServer.ts) behaves, minus the
 * HTTP server: the URLs are the registry's byte for byte, rebind assigns on
 * the slot get() returns, session groups validate bindings the same way, a
 * turn's closer closes only that turn, and a slot's sink stays off its binding.
 * `overrides` replace single methods; the rest keep reading the fake's state.
 */
export function fakeMcpRegistry(
  overrides: Partial<McpSlotProvider> = {},
  options: FakeMcpRegistryOptions = {},
): FakeMcpRegistry {
  const mcpPort = options.mcpPort ?? 3000;
  const baseUrl = () => `http://127.0.0.1:${typeof mcpPort === 'function' ? mcpPort() : mcpPort}/api`;
  const slots = new Map<string, McpSlot>();
  const sessionGroups = new Map<string, FakeMcpSessionGroup>();
  /** Each open turn window's token, as the MCP host keeps one per bound session. */
  const turnTokens = new WeakMap<FakeMcpSessionGroup, Map<string, symbol>>();
  let nextSlot = 0;
  let nextGroup = 0;

  const closeTurn = (group: FakeMcpSessionGroup, sessionId: string): void => {
    group.openTurns.delete(sessionId);
    turnTokens.get(group)?.delete(sessionId);
  };

  const registry: FakeMcpRegistry = {
    slots,
    sessionGroups,

    create(parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks,
      opts?: { nodeId?: string | null; workspaceId?: string | null }): McpSlot {
      // The registry hands the sink to the slot's tools, never to the binding; the fake has no tools.
      const { sink: _sink, ...callbacks } = cbs;
      const slot: McpSlot = {
        slotId: `fake-slot-${++nextSlot}`,
        owner: callbacks.owner,
        nodeId: opts?.nodeId ?? null,
        parentChatId,
        cwd,
        workspaceId: opts?.workspaceId ?? null,
        ownerUserId,
        exposedToolNames: callbacks.exposedToolNames,
        ...callbacks,
      };
      slots.set(slot.slotId, slot);
      return slot;
    },

    get(slotId: string): McpSlot | undefined {
      return slots.get(slotId);
    },

    async dispose(slotId: string): Promise<void> {
      if (!slots.delete(slotId)) return;
      for (const group of sessionGroups.values()) {
        for (const [sessionId, bound] of group.sessions) {
          if (bound !== slotId) continue;
          group.sessions.delete(sessionId);
          closeTurn(group, sessionId);
        }
      }
    },

    createSessionGroup(catalog: McpSlot): string {
      const groupId = `fake-group-${++nextGroup}`;
      sessionGroups.set(groupId, { catalog: { ...catalog }, sessions: new Map(), openTurns: new Set() });
      return groupId;
    },

    bindSession(groupId: string, sessionId: string, slotId: string): void {
      const group = sessionGroups.get(groupId);
      const slot = slots.get(slotId);
      if (!group || !slot || slot.parentChatId !== sessionId || !slot.nodeId
        || (slot.owner && ownerMode(slot.owner) === 'headless')) throw new Error('Invalid MCP chat session binding');
      closeTurn(group, sessionId);
      group.sessions.set(sessionId, slotId);
    },

    /** The returned closer closes only this turn: a late one leaves a newer turn open. */
    beginSessionTurn(groupId: string, sessionId: string): () => void {
      const group = sessionGroups.get(groupId);
      if (!group?.sessions.has(sessionId)) throw new Error('MCP session is not bound');
      const token = Symbol('fake-mcp-turn');
      let tokens = turnTokens.get(group);
      if (!tokens) turnTokens.set(group, tokens = new Map());
      tokens.set(sessionId, token);
      group.openTurns.add(sessionId);
      return () => {
        if (turnTokens.get(group)?.get(sessionId) === token) closeTurn(group, sessionId);
      };
    },

    endSessionTurn(groupId: string, sessionId: string): void {
      const group = sessionGroups.get(groupId);
      if (group) closeTurn(group, sessionId);
    },

    disposeSessionGroup(groupId: string): void {
      sessionGroups.delete(groupId);
    },

    endpoint(slotId: string): McpHttpEndpoint {
      return httpEndpoint(`${baseUrl()}/mcp/${slotId}`);
    },

    sessionEndpoint(groupId: string): McpHttpEndpoint {
      return httpEndpoint(`${baseUrl()}/mcp-session/${groupId}`);
    },

    hookEndpoint(slotId: string, hook: 'stop'): string {
      if (hook !== 'stop') throw new Error(`Unknown MCP slot hook: ${String(hook)}`);
      return `${baseUrl()}/codex-hooks/${slotId}/stop`;
    },

    rebind(slotId: string, patch: McpSlotRebindPatch): void {
      const slot = slots.get(slotId);
      if (!slot) return;
      for (const key of REBIND_OPTIONAL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) assignRebindField(slot, patch, key);
      }
      for (const key of REBIND_REQUIRED_FIELDS) {
        if (patch[key] !== undefined) assignRebindField(slot, patch, key);
      }
    },
  };
  return Object.assign(registry, overrides);
}
