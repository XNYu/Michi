import type { McpHttpEndpoint, McpSlot, McpSlotProvider, McpSlotRebindPatch } from '../contract/mcp';
import { ownerMode } from '../contract/types';
import { recordMcpSlotProviderInternals } from './slotProviderInternals';
import type { McpHost, McpSessionGroup, McpSlotHandle, SessionToolSink } from './types';

export interface McpSlotProviderOptions {
  /**
   * Description of a session group's routing argument (`session_id`) in
   * tools/list; the agent reads it. Default: the MCP host's generic
   * description.
   */
  sessionAnchorDescription?: string;
  /**
   * The URL a slot's hook posts to. Default mcpHost.hookUrl(slotId, hook),
   * the host's own hook route, which answers 404 for an unknown slot. A host
   * that serves the hook on a route of its own returns that route's URL.
   * @experimental Follow-ups Stop-hook POC; outside the v1 compatibility guarantee.
   */
  hookEndpoint?: (slotId: string, hook: 'stop') => string;
}

/**
 * The sink of a slot whose session gave none, and of a session group's
 * catalog copy (it never runs tools itself): reports are dropped.
 */
const NO_HOST_EVENTS: SessionToolSink = { emit: () => {} };
/** Rebindable fields an undefined value clears. */
const REBIND_OPTIONAL_FIELDS = ['owner', 'exposedToolNames', 'agentRuns', 'agentRunToolNames', 'onSubmitAgentResult'] as const;
/** Rebindable fields McpSlot requires; an undefined value leaves them alone. */
const REBIND_REQUIRED_FIELDS = ['parentChatId', 'nodeId', 'workspaceId', 'ownerUserId'] as const;

function assignRebindField<K extends keyof McpSlotRebindPatch>(slot: McpSlot, patch: McpSlotRebindPatch, key: K): void {
  slot[key] = patch[key] as McpSlot[K];
}

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * The host's MCP slots on an MCP host, for the adapters: one host slot per
 * agent session, chat session groups, and the URLs built from the host's
 * base. Serves a slot only its exposedToolNames when set (through the
 * host's allowTools, after a rebind too). It does not judge
 * McpSlot.restricted or isServing: the host's tools read them from
 * ctx.slot.binding. Registers no tools or hooks; the host registers its own
 * on mcpHost.
 *
 * exposedToolNames reaches the host's gate through create() and rebind()
 * only. Assigning it on a binding get() returns changes the binding, not
 * what the host serves: narrowed that way, the slot keeps serving the
 * earlier list. Change it with rebind().
 *
 * Use the provider only while mcpHost is open. After mcpHost.close(), get()
 * still returns the bindings it held, where the McpSlotProvider contract
 * gives undefined for a disposed slot, and a rebind() whose patch has a
 * parentChatId or an exposedToolNames key throws "MCP slot is disposed",
 * after it has assigned the patch on the binding.
 */
export function createMcpSlotProvider(mcpHost: McpHost<McpSlot>, options: McpSlotProviderOptions = {}): McpSlotProvider {
  const { sessionAnchorDescription, hookEndpoint } = options;
  if (sessionAnchorDescription !== undefined && (typeof sessionAnchorDescription !== 'string' || sessionAnchorDescription.trim() === '')) {
    throw new Error('MCP slot provider sessionAnchorDescription must be a non-empty string');
  }
  if (hookEndpoint !== undefined && typeof hookEndpoint !== 'function') throw new Error('MCP slot provider hookEndpoint must be a function');

  const slots = new Map<string, McpSlotHandle<McpSlot>>();
  const sessionGroups = new Map<string, {
    group: McpSessionGroup<McpSlot>;
    /** Host slot (routable: false) whose binding is the catalog copy. */
    catalog: McpSlotHandle<McpSlot>;
  }>();

  const attributionTurns = new Map<McpSlot, {
    token: symbol;
    baseline: McpSlot['getActivePageTurnAttribution'];
    getter: McpSlot['getActivePageTurnAttribution'];
  }>();
  const clearAttribution = (slot: McpSlot | undefined) => {
    if (!slot) return;
    const turn = attributionTurns.get(slot);
    if (!turn) return;
    if (slot.getActivePageTurnAttribution === turn.getter) slot.getActivePageTurnAttribution = turn.baseline;
    attributionTurns.delete(slot);
  };

  const provider: McpSlotProvider = {
    create(parentChatId, cwd, ownerUserId, cbs, opts) {
      // The session's sink goes to the host slot, where tool calls get it; the binding never carries it.
      const { sink, ...callbacks } = cbs;
      const slot: McpSlot = {
        slotId: '',
        owner: callbacks.owner,
        nodeId: opts?.nodeId ?? null,
        parentChatId,
        cwd,
        workspaceId: opts?.workspaceId ?? null,
        ownerUserId,
        exposedToolNames: callbacks.exposedToolNames,
        ...callbacks,
      };
      const handle = mcpHost.createSlot({
        sessionKey: parentChatId, cwd, binding: slot, sink: sink ?? NO_HOST_EVENTS, allowTools: slot.exposedToolNames,
      });
      slot.slotId = handle.slotId;
      slots.set(handle.slotId, handle);
      return slot;
    },

    get(slotId) {
      return slots.get(slotId)?.binding;
    },

    async dispose(slotId) {
      // The host drops the slot at once (its URL answers 404), aborts its
      // in-flight calls and unbinds it from every session group.
      const handle = slots.get(slotId);
      if (!handle) return;
      clearAttribution(handle.binding);
      slots.delete(slotId);
      await handle.dispose();
    },

    createSessionGroup(catalog) {
      const copy: McpSlot = { ...catalog };
      // Only the group serves the copy: its own <basePath>/<id> must not run tools with it.
      const catalogSlot = mcpHost.createSlot({
        sessionKey: copy.parentChatId, cwd: copy.cwd, binding: copy, sink: NO_HOST_EVENTS, routable: false,
        allowTools: copy.exposedToolNames,
      });
      const group = mcpHost.createSessionGroup(catalogSlot, { anchorArg: 'session_id', anchorDescription: sessionAnchorDescription });
      sessionGroups.set(group.groupId, { group, catalog: catalogSlot });
      return group.groupId;
    },

    bindSession(groupId, sessionId, slotId) {
      const entry = sessionGroups.get(groupId);
      const handle = slots.get(slotId);
      const slot = handle?.binding;
      if (!entry || !handle || !slot || slot.parentChatId !== sessionId || !slot.nodeId
        || (slot.owner != null && ownerMode(slot.owner) === 'headless')) throw new Error('Invalid MCP chat session binding');
      // (Re)binding starts with the turn window closed, as a fresh binding always has.
      clearAttribution(entry.group.resolve(sessionId)?.binding);
      entry.group.endTurn(sessionId);
      entry.group.bind(sessionId, handle);
    },

    beginSessionTurn(groupId, sessionId, attribution) {
      const group = sessionGroups.get(groupId)?.group;
      const handle = group?.resolve(sessionId);
      if (!group || !handle) throw new Error('MCP session is not bound');
      const slot = handle.binding;
      const prior = attributionTurns.get(slot);
      const baseline = prior ? prior.baseline : slot.getActivePageTurnAttribution;
      const getter = attribution ?? baseline;
      const token = Symbol('page-attribution-turn');
      slot.getActivePageTurnAttribution = getter;
      attributionTurns.set(slot, { token, baseline, getter });
      const end = group.beginTurn(sessionId);
      return () => {
        end();
        if (attributionTurns.get(slot)?.token === token) clearAttribution(slot);
      };
    },

    endSessionTurn(groupId, sessionId) {
      const group = sessionGroups.get(groupId)?.group;
      clearAttribution(group?.resolve(sessionId)?.binding);
      group?.endTurn(sessionId);
    },

    disposeSessionGroup(groupId) {
      const entry = sessionGroups.get(groupId);
      if (!entry) return;
      sessionGroups.delete(groupId);
      for (const slot of attributionTurns.keys()) {
        if (entry.group.resolve(slot.parentChatId)?.binding === slot) clearAttribution(slot);
      }
      entry.group.dispose();
      void entry.catalog.dispose();
    },

    endpoint(slotId): McpHttpEndpoint {
      return mcpHost.slotEndpoint(slotId);
    },

    sessionEndpoint(groupId): McpHttpEndpoint {
      return mcpHost.sessionGroupEndpoint(groupId);
    },

    hookEndpoint(slotId, hook) {
      return hookEndpoint ? hookEndpoint(slotId, hook) : mcpHost.hookUrl(slotId, hook);
    },

    /**
     * Assigns the patch on the slot's binding itself: the host reads that
     * same object on every call, so the next tool call sees the new values.
     * A new parentChatId also becomes the host slot's sessionKey, and a
     * present exposedToolNames its allowTools.
     */
    rebind(slotId, patch) {
      const handle = slots.get(slotId);
      if (!handle) return;
      const slot = handle.binding;
      for (const key of REBIND_OPTIONAL_FIELDS) {
        if (hasOwn(patch, key)) assignRebindField(slot, patch, key);
      }
      for (const key of REBIND_REQUIRED_FIELDS) {
        if (patch[key] !== undefined) assignRebindField(slot, patch, key);
      }
      const hostPatch: { sessionKey?: string; allowTools?: ReadonlySet<string> } = {};
      if (patch.parentChatId !== undefined) hostPatch.sessionKey = slot.parentChatId;
      if (hasOwn(patch, 'exposedToolNames')) hostPatch.allowTools = slot.exposedToolNames;
      if (Object.keys(hostPatch).length > 0) handle.rebind(hostPatch);
    },
  };

  recordMcpSlotProviderInternals(provider, {
    hostSlot: (slotId) => slots.get(slotId),
    sessionGroupCatalog: (groupId) => sessionGroups.get(groupId)?.catalog,
    resolveSessionSlot(groupId, sessionId) {
      const group = sessionGroups.get(groupId)?.group;
      return group?.isTurnActive(sessionId) ? group.resolve(sessionId)?.binding : undefined;
    },
  });
  return provider;
}
