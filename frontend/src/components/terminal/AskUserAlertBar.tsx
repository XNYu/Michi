import React, { useCallback, useMemo } from 'react';
import { useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { navigateToNode } from '../../state/navigateToNode';
import {
  pendingAskUsersEqual,
  selectPendingAskUsers,
  type PendingAskUser,
} from '../../state/askUserSelectors';
import type { PageId } from '../../state/commands';

/**
 * Global "the agent is asking you something" reminder.
 *
 * The Ask User card renders inline in the pane's transcript, which is easy to
 * miss: the pane may be closed, in another thread/workspace, or scrolled far
 * above the fold. This bar sits under the topbar on EVERY page for as long as
 * any node has an unanswered ask, and clicking it navigates to that node's
 * pane and scrolls the card into view.
 *
 * Deliberately not gated on the `notifications` pref — that pref governs
 * toasts / OS notifications (transient, dismissible), while this is a state
 * indicator that disappears only when the question is answered or skipped.
 */
export default function AskUserAlertBar({ onNav }: { onNav?: (page: PageId) => void }) {
  const { projects, activeProject } = useChatProjects();
  const { selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId } =
    useChatActions();

  const pending = useStructuralSelector(selectPendingAskUsers, pendingAskUsersEqual);

  const navDeps = useMemo(
    () => ({
      projects,
      activeProjectId: activeProject?.id ?? null,
      selectProject,
      openPane,
      openPaneInTree,
      activateTree,
      setFocusedNodeId,
    }),
    [projects, activeProject, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId],
  );

  const reveal = useCallback((target: PendingAskUser) => {
    navigateToNode(navDeps, target.nodeId);
    onNav?.('dashboard');
    if (!target.anchorMessageId) return;
    // One frame so the destination pane is mounted before we ask it to scroll.
    // TPane's listener retries for ~1s if the message DOM is still loading.
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('michi:scroll-to-message', {
          detail: { nodeId: target.nodeId, messageId: target.anchorMessageId },
        }),
      );
    });
  }, [navDeps, onNav]);

  if (pending.length === 0) return null;

  // Oldest unanswered ask is the click target; answering it promotes the next
  // one, so repeated clicks walk the queue without any local cursor state.
  const next = pending[0];
  const extra = pending.length - 1;
  const label = next.title || 'Untitled thread';

  return (
    // role="alert" (not "button") so assistive tech announces the question the
    // moment the bar appears; the nested button carries the keyboard/AT action,
    // while the whole row stays clickable for the mouse.
    <div role="alert" className="ask-alert-bar" onClick={() => reveal(next)}>
      <span className="ask-alert-badge">? ASK</span>
      <span className="ask-alert-text">
        <strong>{label}</strong>
        {next.question ? <span className="ask-alert-q"> — {next.question}</span> : null}
      </span>
      {extra > 0 && (
        <span className="ask-alert-more">
          +{extra} more {extra === 1 ? 'question' : 'questions'}
        </span>
      )}
      <button
        type="button"
        className="ask-alert-cta"
        aria-label={`Open ${label} and answer the agent's question`}
        onClick={(e) => {
          e.stopPropagation();
          reveal(next);
        }}
      >
        Answer →
      </button>
    </div>
  );
}
