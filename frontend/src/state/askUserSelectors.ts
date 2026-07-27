import type { ChatNodeState } from './chatTypes';

/**
 * One unanswered Ask User request, flattened for the global alert bar.
 *
 * The bar only needs enough to render a one-line reminder and navigate, so we
 * deliberately do not carry the whole `UserInputRequest` — the pane's inline
 * ask card owns the full interaction.
 */
export interface PendingAskUser {
  nodeId: string;
  /** Agent-set node title; `''` until `set_title` lands. */
  title: string;
  /** First question of the request. Multi-question asks show only this one. */
  question: string;
  requestId: number;
  /** Message the ask card was appended to, for scroll-into-view on click. */
  anchorMessageId: string | null;
}

/** True while the agent is blocked on an Ask User answer for this node. */
export function isAwaitingUserInput(node: ChatNodeState | undefined): boolean {
  if (!node || node.deletedAt) return false;
  const pending = node.pendingUserInput;
  return !!pending && !pending.resolved;
}

/**
 * Every node with an unanswered Ask User request, in nodes-map insertion order
 * (≈ node creation order, so the oldest thread's question comes first).
 *
 * Reads only structural fields (`pendingUserInput`, `title`, `deletedAt`), so
 * it is safe to pass to `useStructuralSelector`. `anchorMessageId` reads the
 * last message id, which is stable for the lifetime of the pending request:
 * the ask card is appended to the message that is current when the request
 * arrives, and a new message can only appear via a version-bumping action.
 */
export function selectPendingAskUsers(
  nodes: Record<string, ChatNodeState>,
): PendingAskUser[] {
  const pending: PendingAskUser[] = [];
  for (const id in nodes) {
    const node = nodes[id];
    if (!isAwaitingUserInput(node)) continue;
    const request = node.pendingUserInput!;
    const messages = node.messages ?? [];
    pending.push({
      nodeId: node.nodeId ?? id,
      title: node.title ?? '',
      question: request.questions[0]?.question ?? '',
      requestId: request.requestId,
      anchorMessageId: messages[messages.length - 1]?.id ?? null,
    });
  }
  return pending;
}

/** Field-wise equality so a re-selected identical list does not re-render. */
export function pendingAskUsersEqual(
  a: readonly PendingAskUser[],
  b: readonly PendingAskUser[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].nodeId !== b[i].nodeId ||
      a[i].requestId !== b[i].requestId ||
      a[i].question !== b[i].question ||
      a[i].title !== b[i].title ||
      a[i].anchorMessageId !== b[i].anchorMessageId
    ) {
      return false;
    }
  }
  return true;
}
