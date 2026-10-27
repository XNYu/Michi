import type { McpSlot, McpSlotProvider } from '../contract/mcp';
import type { McpSlotHandle } from './types';

/**
 * What a provider createMcpSlotProvider built keeps besides the
 * McpSlotProvider members, for the host's own tests and wrappers. Kept off
 * the provider's shape, so a host gets McpSlotProvider and no handle to
 * dispose a host slot behind the provider's back. In a module of its own,
 * which no public entry exports or names: slotProvider.ts records the
 * internals here, and nothing in its declarations leads to this module.
 */
export interface McpSlotProviderInternals {
  /** The host slot behind a live provider slot. */
  hostSlot(slotId: string): McpSlotHandle<McpSlot> | undefined;
  /** The host slot (routable: false) whose binding is a live session group's catalog copy. */
  sessionGroupCatalog(groupId: string): McpSlotHandle<McpSlot> | undefined;
  /** The binding the group routes `sessionId`'s calls to now: bound, with its turn window open. */
  resolveSessionSlot(groupId: string, sessionId: string): McpSlot | undefined;
}

const internals = new WeakMap<McpSlotProvider, McpSlotProviderInternals>();

/** Records `found` as the internals of `provider`. */
export function recordMcpSlotProviderInternals(provider: McpSlotProvider, found: McpSlotProviderInternals): void {
  internals.set(provider, found);
}

/** The internals of a provider createMcpSlotProvider built. Throws for any other provider. */
export function mcpSlotProviderInternals(provider: McpSlotProvider): McpSlotProviderInternals {
  const found = internals.get(provider);
  if (!found) throw new Error('Not an MCP slot provider built by createMcpSlotProvider');
  return found;
}
