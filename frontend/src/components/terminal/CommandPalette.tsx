import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useChatStore, useChatNodesSnapshot, selectAllChats } from '../../state/chatStore';
import { isVisibleConversationNode } from '../../state/conversationVisibility';
import { buildCommands, filterCommands, Command, PageId } from '../../state/commands';
import { type MessageMatch } from '../../state/search';
import { useNodeSearch } from '../../state/useNodeSearch';
import { type NodeGroupedResult } from '../../services/api';
import { relativeTime } from '../../lib/relativeTime';
import { requestDigest } from '../../lib/digestPrompt';
import { navigateToNode } from '../../state/navigateToNode';
import { ModalShell } from '../ui/ModalShell';
import { MenuItem } from '../ui/Popover';
import { kbd } from '../../lib/platform';
import { TreePrefetchContext, TREE_PREFETCH_INTENT_MS } from '../../state/treePrefetch';
import { CommandIconGlyph } from './commandIcons';
import { isSystemWorkspace, systemWorkspaceIds, withoutSystemWorkspaces } from '../../state/assistant/systemWorkspace';
import { openAssistantPanel, useAssistantSnapshot } from '../../state/assistant/assistantStore';
import { requestAllTasks } from '../../state/pages/allTasksNav';
import { useBackendConnections } from '../../state/useBackendConnections';
import { workspaceRemoteNote } from '../WorkspaceLocation';

function renderSnippetWithMark(text: string, range: [number, number]) {
  const [s, e] = range;
  return (
    <>
      {text.slice(0, s)}
      <mark style={{ background: 'var(--term-accent)', color: 'var(--on-accent)', padding: '0 2px' }}>
        {text.slice(s, e)}
      </mark>
      {text.slice(e)}
    </>
  );
}

function PaletteSearchGlyph() {
  return (
    <span
      aria-hidden
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-lg)',
        color: 'var(--term-accent)',
        flexShrink: 0,
      }}
    >
      ›_
    </span>
  );
}

const PROMPT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--term-line)',
  background: 'transparent',
  flexShrink: 0,
};

const PROMPT_INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-xl)',
  color: 'var(--term-fg)',
  padding: 0,
};

// ── Node-grouped search result styles ────────────────────────────────────

/** Render a snippet containing `<mark>…</mark>` tags from the backend. */
function renderHtmlSnippet(html: string): React.ReactNode {
  // Split on <mark>…</mark> tags to produce React elements.
  const parts: React.ReactNode[] = [];
  let remaining = html;
  let key = 0;
  while (remaining.length > 0) {
    const openIdx = remaining.indexOf('<mark>');
    if (openIdx === -1) {
      parts.push(remaining);
      break;
    }
    if (openIdx > 0) parts.push(remaining.slice(0, openIdx));
    const afterOpen = remaining.slice(openIdx + '<mark>'.length);
    const closeIdx = afterOpen.indexOf('</mark>');
    if (closeIdx === -1) {
      parts.push(remaining);
      break;
    }
    parts.push(
      <mark key={key++} style={{ background: 'var(--term-accent)', color: 'var(--on-accent)', padding: '0 2px', borderRadius: 'var(--ui-radius-sm)' }}>
        {afterOpen.slice(0, closeIdx)}
      </mark>
    );
    remaining = afterOpen.slice(closeIdx + '</mark>'.length);
  }
  return parts;
}

// Multi-line menu row: breadcrumb line stacked over its snippets.
const NODE_ROW_STYLE: React.CSSProperties = {
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 5,
  fontWeight: 400,
};

const BREADCRUMB_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 'var(--fs-md)',
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const NODE_TIME_STYLE: React.CSSProperties = {
  flexShrink: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-sm)',
  color: 'var(--term-muted)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

const SNIPPET_ROW_STYLE: React.CSSProperties = {
  fontSize: 'var(--fs-sm)',
  lineHeight: '1.55',
  color: 'var(--term-mid)',
  padding: '2px 0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const SNIPPET_ROLE_STYLE: React.CSSProperties = {
  color: 'var(--term-muted)',
  fontSize: 'var(--fs-2xs)',
  marginRight: 4,
};

const OVERFLOW_HINT_STYLE: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--term-muted)',
  padding: '2px 0 0 0',
  fontStyle: 'italic',
};

export function openWorkspaceFromPalette(
  projectId: string,
  actions: {
    selectProject: (projectId: string) => void;
    setPage: (page: PageId) => void;
    onClose: () => void;
  },
) {
  actions.selectProject(projectId);
  actions.setPage('home');
  actions.onClose();
}

export default function CommandPalette({
  onClose,
  setPage,
  activePage,
}: {
  onClose: () => void;
  setPage: (p: PageId) => void;
  activePage: PageId;
}) {
  const {
    activeProject,
    projects,
    agentStatus,
    selection,
    clearSelection,
    openPane,
    openPaneInTree,
    createDigest,
    createMergedChat,
    createThread,
    activateTree,
    archiveTree,
    unarchiveTree,
    selectProject,
    setFocusedNodeId,
    setSearchHighlightTerm,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce the query so we don't re-scan on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // The assistant's system workspace is never offered: not as a workspace,
  // a chat or a search hit. Navigation still resolves it (navDeps).
  // The assistant's own id counts too: search can find its messages before
  // this window has loaded its workspace.
  const assistant = useAssistantSnapshot();
  const assistantWorkspaceId = assistant.info?.workspaceId ?? null;
  const userProjects = useMemo(() => withoutSystemWorkspaces(projects), [projects]);
  const hiddenWorkspaceIds = useMemo(() => {
    const ids = systemWorkspaceIds(projects);
    return assistantWorkspaceId && !ids.has(assistantWorkspaceId) ? new Set([...ids, assistantWorkspaceId]) : ids;
  }, [projects, assistantWorkspaceId]);

  // Server-side FTS search — node-grouped, time-sorted, with breadcrumbs.
  // Each result is one unique node with up to 3 best-matching snippets.
  const nodeSearch = useNodeSearch(debouncedQuery);
  const nodeResults = useMemo(
    () => nodeSearch.nodes.filter((r) => !hiddenWorkspaceIds.has(r.workspaceId) && isVisibleConversationNode(nodesSnapshot[r.nodeId])),
    [nodeSearch.nodes, hiddenWorkspaceIds, nodesSnapshot],
  );

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

  /** Navigate to a node-grouped search result (goes to the node, not a specific message). */
  const navigateToNodeResult = useCallback((r: NodeGroupedResult, messageId?: string) => {
    if (query.trim()) setSearchHighlightTerm({ term: query.trim(), nodeId: r.nodeId });
    navigateToNode(navDeps, r.nodeId, r.workspaceId);
    setPage('dashboard');
    if (messageId) {
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent('michi:scroll-to-message', {
            detail: { nodeId: r.nodeId, messageId, messageIdx: -1 },
          }),
        );
      });
    }
    onClose();
  }, [navDeps, setPage, onClose, query, setSearchHighlightTerm]);

  const navigateToResult = useCallback((m: MessageMatch) => {
    if (query.trim()) setSearchHighlightTerm({ term: query.trim(), nodeId: m.nodeId });
    navigateToNode(navDeps, m.nodeId, m.projectId);
    setPage('dashboard');
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('michi:scroll-to-message', {
          detail: { nodeId: m.nodeId, messageId: m.messageId, messageIdx: m.messageIdx },
        }),
      );
    });
    onClose();
  }, [navDeps, setPage, onClose, query, setSearchHighlightTerm]);

  const allChats = useMemo(() => selectAllChats({ projects: userProjects, nodes: nodesSnapshot }), [userProjects, nodesSnapshot]);

  // Live workspaces offered as direct jump targets — exclude deleted/archived
  // and the currently-active one (jumping to where you already are is a no-op).
  const connections = useBackendConnections();
  const workspaces = useMemo(
    () =>
      userProjects
        .filter((p) => !p.deletedAt && !p.archivedAt && p.id !== activeProject?.id)
        .map((p) => ({ id: p.id, name: p.name, remoteNote: workspaceRemoteNote(p.backendConnectionId, connections) })),
    [userProjects, activeProject, connections],
  );
  const openAssistant = useMemo(
    () => (assistant.status === 'unsupported' ? undefined : () => { onClose(); openAssistantPanel(); }),
    [assistant.status, onClose],
  );

  const switchWorkspace = useCallback(
    (projectId: string) => {
      openWorkspaceFromPalette(projectId, { selectProject, setPage, onClose });
    },
    [selectProject, setPage, onClose],
  );

  // With the assistant's hidden workspace active (its conversation opened as
  // a pane) the palette offers none of that workspace's threads: archiving
  // the assistant's thread would start a new conversation behind the panel.
  const threadProject = isSystemWorkspace(activeProject) ? null : activeProject;
  const liveTrees = useMemo(
    () => (threadProject?.trees ?? []).filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name || nodesSnapshot[t.rootNodeId]?.title || 'Untitled' })),
    [threadProject, nodesSnapshot],
  );
  const archivedTrees = useMemo(
    () => (threadProject?.trees ?? []).filter((t) => !!t.archivedAt).map((t) => ({ id: t.id, name: t.name || nodesSnapshot[t.rootNodeId]?.title || 'Untitled' })),
    [threadProject, nodesSnapshot],
  );

  const cmds = useMemo<Command[]>(
    () =>
      buildCommands({
        activePage,
        selection,
        allChats,
        switchProject: selectProject,
        workspaces,
        switchWorkspace,
        hasActiveProject: !!activeProject,
        setPage: (p) => { setPage(p); onClose(); },
        fanoutFromSelection: () => {
          if (selection.size < 2) return;
          void createMergedChat(Array.from(selection)).then((nodeId) => {
            openPane(nodeId);
            clearSelection();
            setPage('dashboard');
            onClose();
          }).catch(() => {});
        },
        digestFromSelection: () => {
          if (!activeProject) return;
          const ids = Array.from(selection);
          requestDigest(activeProject.id, ids);
          onClose();
        },
        exportSelection: () => {
          window.dispatchEvent(new CustomEvent('michi:toggle-export-panel'));
          onClose();
        },
        clearSelection: () => { clearSelection(); onClose(); },
        openChat: (id) => {
          navigateToNode(navDeps, id);
          setPage('dashboard');
          onClose();
        },
        createThread: () => { setPage('home'); onClose(); },
        activateTree: (treeId) => { activateTree(treeId); onClose(); },
        archiveTree: (treeId) => { archiveTree(treeId); onClose(); },
        unarchiveTree: (treeId) => { unarchiveTree(treeId); onClose(); },
        activeTreeId: threadProject?.activeTreeId ?? null,
        liveTrees,
        archivedTrees,
        customAgentsEnabled: agentStatus?.customAgentsEnabled === true,
        openAssistant,
        openAllTasks: () => { requestAllTasks(); onClose(); },
      }),
    [activePage, selection, allChats, navDeps, selectProject, activeProject, threadProject?.activeTreeId, agentStatus?.customAgentsEnabled, setPage, onClose, clearSelection, createDigest, openPane, createMergedChat, createThread, activateTree, archiveTree, unarchiveTree, liveTrees, archivedTrees, workspaces, switchWorkspace, openAssistant],
  );
  const visible = useMemo(() => {
    const q = query.trim();
    const base = q ? filterCommands(cmds, query) : cmds;
    return base.filter((c) => {
      // Suppress "Switch to thread ▸ …" rows — they overlap visually with chat rows
      // whose titles match the tree name. Tree navigation already lives in the sidebar.
      if (c.id.startsWith('thread.switch.')) return false;
      // Workspace jumps are search-only: the empty/recents view stays focused on
      // nav + chats; typing surfaces the WORKSPACE group (filtered by the query).
      if (!q && c.group === 'workspace') return false;
      return true;
    });
  }, [cmds, query]);
  const showRecents = !query.trim();

  const totalRows = visible.length + (showRecents ? 0 : nodeResults.length);
  const prefetchTree = React.useContext(TreePrefetchContext);
  const activeCommand = visible[active];
  const prefetchNodeId = activeCommand?.group === 'chat'
    ? activeCommand.id.slice('chat.'.length)
    : !showRecents && active >= visible.length ? nodeResults[active - visible.length]?.nodeId : undefined;
  useEffect(() => {
    if (!prefetchNodeId) return;
    const timer = setTimeout(() => prefetchTree(prefetchNodeId), TREE_PREFETCH_INTENT_MS);
    return () => clearTimeout(timer);
  }, [prefetchNodeId, prefetchTree]);

  // Reset the active highlight whenever the query changes so the user can
  // type a filter term and immediately press Enter to run the top match.
  // When the results include a workspace match, auto-focus it so Enter
  // switches workspaces without extra arrow-key navigation.
  // Keyed on the index, not on `visible`: a reply streaming in any pane gives
  // `visible` a new identity many times a second, and resetting on each one
  // put the highlight (and the list's scroll) back on the first row.
  const workspaceIdx = useMemo(() => visible.findIndex((c) => c.group === 'workspace'), [visible]);
  useEffect(() => {
    setActive(workspaceIdx >= 0 ? workspaceIdx : 0);
  }, [query, workspaceIdx]);

  useEffect(() => {
    if (active >= totalRows) setActive(0);
  }, [totalRows, active]);

  const listRef = useRef<HTMLDivElement>(null);
  // Suppress hover-driven `setActive` for a beat after a keyboard nav so the
  // scrollIntoView doesn't immediately snap `active` back to whichever row
  // landed under the mouse pointer post-scroll.
  const kbdNavAt = useRef(0);
  const hoverSetActive = useCallback((i: number) => {
    if (Date.now() - kbdNavAt.current < 200) return;
    setActive(i);
  }, []);
  // Only the highlighted MenuItem carries data-active.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Stabilize scroll when async search results arrive (totalRows changes)
  // without the active index itself changing. Without this, the DOM reflows
  // when the MESSAGES section appears and the previously-visible active row
  // may scroll out of view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [totalRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const runRowAtIndex = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= totalRows) return;
      if (idx < visible.length) {
        const c = visible[idx];
        if (c) {
          c.run();
          onClose();
        }
        return;
      }
      const matchIdx = idx - visible.length;
      const nr = nodeResults[matchIdx];
      if (nr) navigateToNodeResult(nr);
    },
    [visible, nodeResults, totalRows, onClose, navigateToNodeResult],
  );

  const runActiveRow = useCallback(() => {
    runRowAtIndex(active);
  }, [runRowAtIndex, active]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const isModifier = e.metaKey || e.ctrlKey;
    if (!showRecents && isModifier && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const targetIdx = parseInt(e.key, 10) - 1;
      runRowAtIndex(targetIdx);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      kbdNavAt.current = Date.now();
      setActive((i) => Math.min(totalRows - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      kbdNavAt.current = Date.now();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      runActiveRow();
    }
  };

  const groups: Array<['nav' | 'action' | 'workspace' | 'chat' | 'search-result', string]> = [
    ['nav', 'Navigate'],
    ['action', 'Actions'],
    ['workspace', 'Workspaces'],
    ['chat', 'Chats'],
  ];

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Command palette"
      titleGlyph="▸"
      width={620}
      anchor="top"
      motion="enter"
    >
        <div style={PROMPT_ROW}>
          <PaletteSearchGlyph />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search chats, commands, messages…"
            style={PROMPT_INPUT}
          />
        </div>

        {/* Rows are the shared menu rows (MenuItem + .michi-menu-scope), so the
            palette's list reads exactly like the right-click / dropdown menus. */}
        <div
          ref={listRef}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          className="hide-sb michi-menu-scope"
          data-menu="palette"
        >
          {groups.map(([g, label]) => {
            const rows = visible.filter((c) => c.group === g);
            if (rows.length === 0) return null;
            return (
              <ul key={g} className="michi-menu-list" aria-label={label}>
                <li aria-hidden="true" className="michi-menu-section">{label}</li>
                {rows.map((c) => {
                  const idx = visible.indexOf(c);
                  const quickKey = !showRecents && idx < 9 ? kbd('mod', String(idx + 1)) : null;
                  const keys = quickKey ?? c.keys;
                  return (
                    <MenuItem
                      key={c.id}
                      active={idx === active}
                      onMouseEnter={() => hoverSetActive(idx)}
                      onClick={() => { c.run(); onClose(); }}
                    >
                      <span className="michi-menu-glyph" aria-hidden="true"><CommandIconGlyph name={c.icon} /></span>
                      <span className="michi-menu-label">
                        {c.label}
                        {c.meta ? <span className="michi-menu-caption michi-menu-sublabel">{c.meta}</span> : null}
                      </span>
                      {keys ? <span className="michi-menu-keys">{keys}</span> : null}
                    </MenuItem>
                  );
                })}
              </ul>
            );
          })}
          {visible.length === 0 && nodeResults.length === 0 && (
            <div className="michi-menu-caption" style={{ padding: 'var(--m-rowY) var(--m-rowX)' }}>
              {showRecents ? 'No commands available' : 'No matches'}
            </div>
          )}
          {/* Node-grouped search results — deduped by node, time-sorted, with breadcrumbs */}
          {!showRecents && nodeResults.length > 0 && (
            <ul className="michi-menu-list" aria-label="Messages">
              <li aria-hidden="true" className="michi-menu-section">
                Messages · {nodeResults.length} node{nodeResults.length !== 1 ? 's' : ''}
              </li>
              {nodeResults.map((nr, ni) => {
                const rowIdx = visible.length + ni;
                const overflow = nr.totalMatches - nr.snippets.length;
                return (
                  <MenuItem
                    key={nr.nodeId}
                    active={rowIdx === active}
                    onMouseEnter={() => hoverSetActive(rowIdx)}
                    onClick={() => navigateToNodeResult(nr)}
                    style={NODE_ROW_STYLE}
                  >
                    {/* Breadcrumb + timestamp row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
                      <div style={BREADCRUMB_STYLE}>
                        <span style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', letterSpacing: 'var(--ls-wide)' }}>
                          {nr.workspaceName}
                        </span>
                        {nr.breadcrumb.length > 0 && (
                          <span style={{ color: 'var(--term-line-s)', margin: '0 5px', fontSize: 'var(--fs-xs)' }}>›</span>
                        )}
                        {nr.breadcrumb.map((seg, si) => {
                          const isLast = si === nr.breadcrumb.length - 1;
                          return (
                            <React.Fragment key={si}>
                              {si > 0 && (
                                <span style={{ color: 'var(--term-faint)', margin: '0 3px', fontSize: 'var(--fs-xs)' }}>/</span>
                              )}
                              <span style={isLast ? { color: 'var(--term-fg)', fontWeight: 500 } : { color: 'var(--term-muted)' }}>
                                {seg}
                              </span>
                            </React.Fragment>
                          );
                        })}
                      </div>
                      <span style={NODE_TIME_STYLE}>{relativeTime(nr.lastMessageAt)}</span>
                    </div>
                    {/* Snippets */}
                    <div>
                      {nr.snippets.map((s, si) => (
                        <div
                          key={si}
                          style={SNIPPET_ROW_STYLE}
                          onClick={(e) => { e.stopPropagation(); navigateToNodeResult(nr, s.messageId); }}
                        >
                          <span style={SNIPPET_ROLE_STYLE}>⌕</span>
                          <span>{renderHtmlSnippet(s.snippet)}</span>
                        </div>
                      ))}
                      {overflow > 0 && (
                        <div style={OVERFLOW_HINT_STYLE}>+ {overflow} more match{overflow !== 1 ? 'es' : ''}</div>
                      )}
                    </div>
                  </MenuItem>
                );
              })}
            </ul>
          )}
        </div>
    </ModalShell>
  );
}
