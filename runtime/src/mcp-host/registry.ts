import { randomBytes } from 'node:crypto';
import type { HostHookHandler, HostToolDef, HostToolSource, SessionToolSink, SlotBuiltins, SlotView } from './types';

/**
 * Slot, session-group, tool and hook registries. Slot and group ids are
 * 128-bit capability secrets: anything that can POST to an id's URL can run
 * that slot's tools, so ids are validated before lookup and never logged in full.
 */

const ID_PATTERN = /^[0-9a-f]{32}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function newCapabilityId(): string {
  return randomBytes(16).toString('hex');
}

export function isCapabilityId(value: string): boolean {
  return value.length === 32 && ID_PATTERN.test(value);
}

/** The only form in which a slot or group id may reach a log line. */
export function redactId(id: string): string {
  return `${id.slice(0, 4)}…`;
}

export interface SlotRecord<B> {
  readonly slotId: string;
  sessionKey: string;
  readonly cwd: string;
  binding: B;
  readonly sink: SessionToolSink;
  /** Read on every request, so McpSlotHandle.rebind takes effect from the next one. */
  allowTools?: ReadonlySet<string>;
  readonly builtins: SlotBuiltins;
  /** False for a slot without a URL of its own (CreateSlotOptions.routable). */
  readonly routable: boolean;
  disposed: boolean;
  /** Controllers of in-flight tool calls, aborted on dispose. */
  readonly inflight: Set<AbortController>;
}

export interface SessionBinding {
  readonly slotId: string;
  turn?: symbol;
}

export interface GroupRecord {
  readonly groupId: string;
  readonly catalogSlotId: string;
  readonly anchorArg: string;
  readonly anchorDescription: string;
  readonly sessions: Map<string, SessionBinding>;
}

export function slotSnapshot<B>(record: SlotRecord<B>): SlotView<B> {
  return Object.freeze({
    slotId: record.slotId,
    sessionKey: record.sessionKey,
    cwd: record.cwd,
    binding: record.binding,
  });
}

export class McpHostRegistry<B> {
  readonly tools = new Map<string, HostToolDef<B>>();
  /** Per-slot tool sources in registration order. */
  readonly sources: HostToolSource<B>[] = [];
  readonly hooks = new Map<string, HostHookHandler<B>>();
  private readonly slots = new Map<string, SlotRecord<B>>();
  private readonly groups = new Map<string, GroupRecord>();

  addSlot(record: SlotRecord<B>): void {
    this.slots.set(record.slotId, record);
  }

  /** Live slot for an id, or undefined for malformed, unknown and disposed ids. */
  slot(id: string): SlotRecord<B> | undefined {
    if (!isCapabilityId(id)) return undefined;
    const record = this.slots.get(id);
    return record && !record.disposed ? record : undefined;
  }

  /** Live slot addressed by its own URL segment: as slot(), minus slots created with routable: false. */
  routableSlot(id: string): SlotRecord<B> | undefined {
    const record = this.slot(id);
    return record?.routable ? record : undefined;
  }

  addGroup(record: GroupRecord): void {
    this.groups.set(record.groupId, record);
  }

  /** Live group for a URL segment; a group whose catalog slot is gone does not resolve. */
  group(id: string): GroupRecord | undefined {
    if (!isCapabilityId(id)) return undefined;
    const record = this.groups.get(id);
    return record && this.slot(record.catalogSlotId) ? record : undefined;
  }

  hasGroup(id: string): boolean {
    return this.groups.has(id);
  }

  removeGroup(id: string): boolean {
    return this.groups.delete(id);
  }

  /**
   * Drops a slot, aborts its in-flight calls, unbinds it from every session
   * group and removes the groups that used it as their catalog.
   */
  removeSlot(id: string): string[] {
    const record = this.slots.get(id);
    if (!record) return [];
    record.disposed = true;
    this.slots.delete(id);
    for (const controller of record.inflight) controller.abort(new Error('MCP slot disposed'));
    record.inflight.clear();
    const removedGroups: string[] = [];
    for (const [groupId, group] of this.groups) {
      if (group.catalogSlotId === id) {
        this.groups.delete(groupId);
        removedGroups.push(groupId);
        continue;
      }
      for (const [sessionId, binding] of group.sessions) {
        if (binding.slotId === id) group.sessions.delete(sessionId);
      }
    }
    return removedGroups;
  }

  clear(): void {
    for (const id of [...this.slots.keys()]) this.removeSlot(id);
    this.groups.clear();
    this.tools.clear();
    this.sources.length = 0;
    this.hooks.clear();
  }
}
