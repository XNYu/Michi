import React from 'react';
import type { ProgressCardAwaiting } from 'michi-shared';
import { backendConnectionIdForWorkspace } from '../../../../config/backendConnections';
import { openConversationFromSpaces } from '../../../../state/sourceNav/sourceNav';
import type { SpaceConversationScope } from '../../../../state/spaceConversations/store';

/**
 * Fired after a conversation started from a Space opens in the Conversations
 * area: `from` is the page its card was on.
 */
export const SPACE_CONVERSATION_OPENED_EVENT = 'michi:space-conversation-opened';

export interface SpaceConversationOpened {
  nodeId: string;
  workspaceId: string;
  /** Continue chatting: the composer takes focus. */
  continueChat: boolean;
  from: SpaceConversationScope | null;
}

const PENDING_WAIT_MS = 3_000;

/** Elements marked with the conversation's id: its pane (and its column), but also chips that mention it. */
function marked(nodeId: string): Element[] {
  const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(nodeId) : nodeId.replace(/["\\]/g, '\\$&');
  return Array.from(document.querySelectorAll(`[data-node-id="${id}"]`));
}

/**
 * Moves focus to the request a conversation's pane waits on once it renders:
 * the approval banner above its composer, or the question card in its
 * transcript. The pane owns both; this only finds them.
 */
export function focusPendingRequest(nodeId: string, pending: ProgressCardAwaiting, timeoutMs = PENDING_WAIT_MS): () => void {
  const started = Date.now();
  let timer: number | undefined;
  const find = (scope: Element): HTMLElement | null | undefined => (pending === 'approval'
    ? scope.querySelector('[data-testid="permission-source"]')?.closest<HTMLElement>('[tabindex="-1"]')
    // The live question is the newest open card that still takes an answer.
    : Array.from(scope.querySelectorAll<HTMLElement>('.ask-card:not(.ask-resolved)')).reverse().find((card) => card.querySelector('button:not(:disabled)')));
  const attempt = () => {
    const request = marked(nodeId).map(find).find(Boolean);
    if (request) {
      request.scrollIntoView?.({ block: 'nearest' });
      const focus = pending === 'question' ? request.querySelector<HTMLElement>('button:not(:disabled)') ?? request : request;
      focus.focus({ preventScroll: true });
      return;
    }
    if (Date.now() - started < timeoutMs) timer = window.setTimeout(attempt, 100);
  };
  attempt();
  return () => { if (timer !== undefined) window.clearTimeout(timer); };
}

/**
 * Opens a Space-started conversation in the Conversations area with the same
 * "Back to <page>" bar as a source link; "continue" also puts the cursor in
 * its composer, and `pending` puts it on the request the conversation waits on.
 */
export function useOpenSpaceConversation() {
  return React.useCallback(async (
    target: { threadNodeId: string; workspaceId: string },
    { continueChat = false, from = null, pending = null }: { continueChat?: boolean; from?: SpaceConversationScope | null; pending?: ProgressCardAwaiting | null } = {},
  ): Promise<boolean> => {
    const opened = await openConversationFromSpaces({
      backendConnectionId: from?.backendConnectionId ?? backendConnectionIdForWorkspace(target.workspaceId),
      workspaceId: target.workspaceId,
      nodeId: target.threadNodeId,
      focus: continueChat && !pending,
    });
    if (!opened) return false;
    const detail: SpaceConversationOpened = { nodeId: target.threadNodeId, workspaceId: target.workspaceId, continueChat, from };
    window.dispatchEvent(new CustomEvent<SpaceConversationOpened>(SPACE_CONVERSATION_OPENED_EVENT, { detail }));
    if (pending) focusPendingRequest(target.threadNodeId, pending);
    return true;
  }, []);
}
