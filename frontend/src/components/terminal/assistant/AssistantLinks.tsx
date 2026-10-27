import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownLinkRendererContext, type MarkdownLinkRenderer } from '../../markdownLinkRenderer';
import { useChatActions, useChatNode, useChatNodeReader, useChatProjects } from '../../../state/chatStore';
import { navigateToNode } from '../../../state/navigateToNode';
import { isSystemWorkspace } from '../../../state/assistant/systemWorkspace';
import { parseAssistantLink, type AssistantLink } from '../../../state/assistant/assistantLinks';
import { fetchWorkspaceHoldingNode } from '../../../state/assistant/locateNode';
import { AssistantScopeContext } from './assistantScope';
import { PageLinkChip } from '../spaces/metaChat/PageLinkChip';
import './assistant.css';

function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) return textOf(children.props.children);
  return '';
}

/**
 * A Michi thread. One this window doesn't have yet (made in another window
 * since this one loaded: the assistant reads the backend) is loaded with
 * its workspace on the first click and opened once it is in; one the
 * backend doesn't have either, or that its workspace didn't bring in, says
 * so. One that couldn't be loaded says that, and the next click tries again;
 * so does a remote connection's thread the store doesn't hold (only that
 * connection's load brings it in, never this machine's backend).
 */
function NodeChip({ id, children }: { id: string; children: React.ReactNode }) {
  const node = useChatNode(id);
  const { projects, activeProjectId } = useChatProjects();
  const { selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId, installWorkspaceSnapshot } = useChatActions();
  const readNode = useChatNodeReader();
  const label = textOf(children).trim() || node?.title || 'Thread';
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'missing' | 'failed'>('idle');
  const openWhenLoadedRef = useRef(false);
  const owner = node ? projects.find((p) => p.id === node.projectId && p.chatIds.includes(id)) : undefined;

  const navigate = (projectId: string) => {
    navigateToNode(
      { projects, activeProjectId, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId },
      id,
      projectId,
    );
    window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'dashboard' } }));
  };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // A thread loaded on click opens once the store has it and its workspace.
  const ownerId = owner?.id ?? null;
  useEffect(() => {
    if (!openWhenLoadedRef.current || !ownerId) return;
    openWhenLoadedRef.current = false;
    navigateRef.current(ownerId);
  }, [ownerId]);

  // A chip that goes away (the answer re-rendered, the panel closed) stops
  // its lookup: nothing is installed or opened for it afterwards.
  const lookupRef = useRef<AbortController | null>(null);
  useEffect(() => () => lookupRef.current?.abort(), []);

  // A thread found missing stays so unless the store gets it live after all.
  const missing = lookup === 'missing' && (!node || node.deletedAt != null);
  const failed = !node && lookup === 'failed';
  const open = () => {
    if (missing || lookup === 'loading') return;
    if (node) {
      navigate(node.projectId);
      return;
    }
    const controller = new AbortController();
    lookupRef.current = controller;
    setLookup('loading');
    fetchWorkspaceHoldingNode(id, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        // Only the backend saying there is no such thread means "not found".
        if (found === null) {
          setLookup('missing');
          return;
        }
        if (!installWorkspaceSnapshot(found.workspace, found.readStartedAt)) {
          setLookup('failed');
          return;
        }
        // The workspace can leave it out (deleted since the lookup, or in a
        // tree this window is removing): then there is nothing to open.
        const arrived = readNode(id);
        if (!arrived || arrived.deletedAt != null) {
          setLookup('missing');
          return;
        }
        openWhenLoadedRef.current = true;
        setLookup('idle');
      })
      // Couldn't ask (offline, a hiccup): the next click tries again.
      .catch(() => { if (!controller.signal.aborted) setLookup('failed'); });
  };
  return (
    <button
      type="button"
      className="assistant-cite"
      data-assistant-link="node"
      aria-disabled={missing || undefined}
      aria-busy={lookup === 'loading' || undefined}
      title={missing ? `${label} — not found in Michi` : failed ? `${label} — couldn't load it; click to try again` : label}
      onClick={open}
    >
      <span className="assistant-cite__text">{label}</span>
      {missing && <span className="assistant-cite__note">not found</span>}
      {failed && <span className="assistant-cite__note">couldn't load</span>}
    </button>
  );
}

export function AssistantLinkChip({ link, children }: { link: AssistantLink; children: React.ReactNode }) {
  if (link.kind === 'node') return <NodeChip id={link.id}>{children}</NodeChip>;
  if (link.kind === 'page') return <PageLinkChip id={link.id} blockId={link.blockId}>{children}</PageLinkChip>;
}

const ASSISTANT_LINKS: MarkdownLinkRenderer = {
  protocols: ['michi'],
  matches: (href) => parseAssistantLink(href) !== null,
  render: (href, children) => {
    const link = parseAssistantLink(href);
    return link ? <AssistantLinkChip link={link}>{children}</AssistantLinkChip> : children;
  },
};

/**
 * The assistant's conversation renders native `michi://` links as chips.
 */
export function AssistantLinkScope({ children }: { children: React.ReactNode }) {
  return (
    <AssistantScopeContext.Provider value>
      <MarkdownLinkRendererContext.Provider value={ASSISTANT_LINKS}>{children}</MarkdownLinkRendererContext.Provider>
    </AssistantScopeContext.Provider>
  );
}

/** The assistant's node opened as a normal pane gets the same chips as the panel. */
export function AssistantPaneScope({ nodeId, children }: { nodeId: string; children: React.ReactNode }) {
  const { projects } = useChatProjects();
  // Projects only: streaming into the node must not re-render this wrapper.
  const assistant = useMemo(
    () => projects.some((p) => isSystemWorkspace(p) && p.chatIds.includes(nodeId)),
    [nodeId, projects],
  );
  // Always the provider (null = Markdown's default links), so a pane never
  // remounts if the answer to "is this the assistant?" changes.
  return (
    <AssistantScopeContext.Provider value={assistant}>
      <MarkdownLinkRendererContext.Provider value={assistant ? ASSISTANT_LINKS : null}>
        {children}
      </MarkdownLinkRendererContext.Provider>
    </AssistantScopeContext.Provider>
  );
}
