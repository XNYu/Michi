import React, { useEffect, useMemo } from 'react';
import type { ToolCallState } from '../../state/chatTypes';
import { useOptionalChatActions } from '../../state/chatStore';
import {
  invalidateTurnPageReceipt, parseTurnPageReceipt, putsTaskBoard, resetTurnPageReceiptInvalidationForTests, taskBoardPageId, taskWriteLine, type TurnPageReceipt,
} from '../../lib/turnPageReceipt';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';

function PageWriteReceipt({ receipt, workspaceId, backendConnectionId, variant, boardPageId = null }: {
  receipt: TurnPageReceipt;
  workspaceId: string;
  backendConnectionId: string;
  variant?: 'conversation';
  /** The page this reply put a task board on: where a task write opens while no page showed its tasks yet. */
  boardPageId?: string | null;
}) {
  const openPagePane = useOptionalChatActions()?.openPagePane;
  const ownWorkspaceId = receipt.workspaceId ?? workspaceId;
  const pageIds = receipt.resourceKind === 'page'
    ? [receipt.resourceId]
    : receipt.originatingPageId
      ? [receipt.originatingPageId]
      : receipt.originatingPageIds.length === 0 && receipt.tasks && boardPageId
        ? [boardPageId]
        : receipt.originatingPageIds;
  const openPage = (pageId: string) => {
    openPagePane?.({ pageId, workspaceId: ownWorkspaceId, backendConnectionId, title: receipt.title });
    const targetId = receipt.affectedTargetIds[0];
    if (!targetId) return;
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('michi:scroll-to-page-target', {
      detail: { pageId, workspaceId: ownWorkspaceId, backendConnectionId, resourceKind: receipt.resourceKind, resourceId: receipt.resourceId, targetId },
    })));
  };

  // A write to the task database says what it did to the tasks; one that put a task board on a page says so.
  const tasks = receipt.tasks ? taskWriteLine(receipt.tasks) : null;
  const board = putsTaskBoard(receipt);
  const more = board && receipt.appliedCount > 1 ? ` · and ${receipt.appliedCount - 1} more ${receipt.appliedCount === 2 ? 'change' : 'changes'}` : '';
  const waiting = receipt.proposedCount ? ` · ${receipt.proposedCount} waiting for you` : '';
  const label = receipt.created
    ? `Created ${receipt.title}`
    : tasks
      ? `${tasks}${waiting}`
      : board
        ? `Added a task board to ${receipt.title}${more}`
        : `Updated ${receipt.title} · ${receipt.appliedCount} changes · ${receipt.proposedCount} waiting for you`;
  // Under a reply on the conversation page: how many places, and only what still waits.
  const shown = variant === 'conversation' && !receipt.created && !tasks && !board
    ? `Updated ${receipt.title} · ${receipt.appliedCount + receipt.proposedCount} ${receipt.appliedCount + receipt.proposedCount === 1 ? 'place' : 'places'}${receipt.proposedCount ? ` · ${receipt.proposedCount} waiting for you` : ''}`
    : label;
  return (
    <div className="assistant-receipt" data-page-receipt="true" data-variant={variant}>
      <span className="assistant-receipt__glyph" aria-hidden="true">✓</span>
      <span className="assistant-receipt__label" title={shown}>{shown}</span>
      {openPagePane && pageIds.map((pageId) => (
        <button className="assistant-receipt__btn" key={pageId} type="button" onClick={() => openPage(pageId)}>
          {variant === 'conversation' ? (pageIds.length > 1 ? `View ${receipt.title}` : 'View') : pageIds.length > 1 ? `Open ${receipt.title}` : 'Open'}
        </button>
      ))}
    </div>
  );
}

export function PageReceipt({ tools, workspaceId, backendConnectionId, variant }: {
  tools: readonly ToolCallState[];
  workspaceId: string;
  backendConnectionId: string;
  variant?: 'conversation';
}) {
  const receipts = useMemo(() => tools.flatMap((tool) => {
    const receipt = parseTurnPageReceipt(tool, backendConnectionId);
    return receipt && (receipt.created || receipt.appliedCount > 0 || receipt.proposedCount > 0) ? [{ id: tool.id, receipt }] : [];
  }), [backendConnectionId, tools]);
  const boardReceipts = useMemo(() => receipts.map(({ receipt }) => receipt), [receipts]);

  useEffect(() => {
    for (const { id, receipt } of receipts) {
      invalidateTurnPageReceipt(receipt, { backendConnectionId, workspaceId }, id);
    }
  }, [backendConnectionId, receipts, workspaceId]);

  // The Meta agent window shows its own cards (with Undo) for the same tools.
  const cards = useMetaChatDecorations()?.toolCards;
  if (cards) return <>{cards(tools)}</>;
  if (!receipts.length) return null;
  return <>{receipts.map(({ id, receipt }) => (
    <PageWriteReceipt key={id} receipt={receipt} workspaceId={workspaceId} backendConnectionId={backendConnectionId} variant={variant} boardPageId={taskBoardPageId(boardReceipts, receipt.workspaceId)} />
  ))}</>;
}

export function resetPageReceiptInvalidationForTests(): void { resetTurnPageReceiptInvalidationForTests(); }
