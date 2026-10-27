import { ownerMode, type RuntimeSessionOwner } from 'michi-runtime';

// Michi's side of the runtime session owner. The runtime package knows an
// owner only by its mode and key; Michi names it a chat node or an Agent Run
// Attempt. Build owners here, and map them back here before reading Michi ids.

/** Michi's name for a runtime session owner. */
export type MichiSessionOwner =
  | { kind: 'chat_node'; nodeId: string }
  | { kind: 'agent_run'; runId: string; attemptId: string };

/** What a Run owner carries for Michi alone (frozen, so no holder can change it). */
interface RunOwnerRef {
  readonly runId: string;
}

/** A chat node's owner: interactive, keyed by the node id (the chat session's public id). */
export function chatOwner(nodeId: string): RuntimeSessionOwner {
  return { mode: 'interactive', key: nodeId };
}

/**
 * An Agent Run Attempt's owner: headless, keyed by the Attempt id (the Run
 * session's public id). The Attempt id is a primary key and decides its Run,
 * so mode and key identify the owner; the Run id rides along for Michi.
 */
export function runOwner(runId: string, attemptId: string): RuntimeSessionOwner {
  const hostRef: RunOwnerRef = Object.freeze({ runId });
  return { mode: 'headless', key: attemptId, hostRef };
}

/**
 * The chat node or Agent Run Attempt an owner stands for. Throws when a
 * headless owner carries no Run id: it was not built by runOwner, and no
 * Run can be named for it.
 */
export function hostOwner(owner: RuntimeSessionOwner): MichiSessionOwner {
  const key = owner.key;
  if (ownerMode(owner) === 'interactive') return { kind: 'chat_node', nodeId: key };
  const runId = refRunId(owner);
  if (!runId) throw new Error('Agent Run owner carries no Run id');
  return { kind: 'agent_run', runId, attemptId: key };
}

/** Whether the owner is an Agent Run Attempt (no owner is not). */
export function isRunOwner(owner: RuntimeSessionOwner | null | undefined): boolean {
  return owner != null && ownerMode(owner) === 'headless';
}

/** The chat node an owner stands for; undefined for an Agent Run or no owner. */
export function chatNodeOf(owner: RuntimeSessionOwner | null | undefined): string | undefined {
  if (owner == null || isRunOwner(owner)) return undefined;
  const host = hostOwner(owner);
  return host.kind === 'chat_node' ? host.nodeId : undefined;
}

/** The Run an Agent Run owner belongs to; null for a chat or no owner. Throws like hostOwner. */
export function runIdOfOwner(owner: RuntimeSessionOwner | null | undefined): string | null {
  if (!isRunOwner(owner)) return null;
  const host = hostOwner(owner!);
  return host.kind === 'agent_run' ? host.runId : null;
}

/** Michi's equality: the same chat node, or the same Run and Attempt. A headless owner without a Run id equals none. */
export function sameHostOwner(left: RuntimeSessionOwner, right: RuntimeSessionOwner): boolean {
  if ((isRunOwner(left) && !refRunId(left)) || (isRunOwner(right) && !refRunId(right))) return false;
  const a = hostOwner(left);
  const b = hostOwner(right);
  if (a.kind === 'chat_node') return b.kind === 'chat_node' && a.nodeId === b.nodeId;
  return b.kind === 'agent_run' && a.runId === b.runId && a.attemptId === b.attemptId;
}

function refRunId(owner: RuntimeSessionOwner): string | undefined {
  const ref = owner.hostRef as Partial<RunOwnerRef> | undefined;
  return typeof ref?.runId === 'string' && ref.runId ? ref.runId : undefined;
}
