import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useChatStore, useChatNodesSnapshot, selectAllChats } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { buildCommands, filterCommands, Command, PageId } from '../../state/commands';
import { type MessageMatch } from '../../state/search';
import { useServerSearch } from '../../state/useServerSearch';
import { useNodeSearch } from '../../state/useNodeSearch';
import { type NodeGroupedResult } from '../../services/api';
import { relativeTime } from '../../lib/relativeTime';
import { requestDigest } from '../../lib/digestPrompt';
import { navigateToNode } from '../../state/navigateToNode';
import { ModalShell } from '../ui/ModalShell';
import { kbd } from '../../lib/platform';

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
        fontFamily: 'var(--mono-font, ui-monospace, monospace)',
        fontSize: 12.5,
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
  fontSize: 14,
  color: 'var(--term-fg)',
  padding: 0,
};

const GROUP_LABEL: React.CSSProperties = {
  padding: '10px 14px 4px',
  fontFamily: 'var(--mono-font, ui-monospace, monospace)',
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--term-muted)',
};

const rowStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 14px',
  background: active ? 'var(--term-alt)' : 'transparent',
  borderLeft: active ? '2px solid var(--term-accent)' : '2px solid transparent',
  cursor: 'pointer',
});

const ROW_GLYPH = (active: boolean): React.CSSProperties => ({
  width: 18,
  textAlign: 'center',
  color: active ? 'var(--term-accent)' : 'var(--term-muted)',
  fontFamily: 'var(--mono-font, ui-monospace, monospace)',
  fontSize: 12,
  fontWeight: 600,
  flexShrink: 0,
});

const ROW_LABEL = (active: boolean): React.CSSProperties => ({
  fontFamily: 'var(--ui-font)',
  fontSize: 13,
  color: 'var(--term-fg)',
  flex: 1,
  fontWeight: active ? 600 : 400,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

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
      <mark key={key++} style={{ background: 'var(--term-accent)', color: 'var(--on-accent)', padding: '0 2px', borderRadius: 1 }}>
        {afterOpen.slice(0, closeIdx)}
      </mark>
    );
    remaining = afterOpen.slice(closeIdx + '</mark>'.length);
  }
  return parts;
}

const nodeCardStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 14px 10px 12px', // 12px + 2px border-left = 14px total (aligns with group label)
  cursor: 'pointer',
  borderLeft: active ? '2px solid var(--term-accent)' : '2px solid transparent',
  background: active ? 'var(--term-alt)' : 'transparent',
  transition: 'background 60ms cubic-bezier(.2,0,.6,1)',
});

const NODE_CARD_SEPARATOR: React.CSSProperties = {
  borderTop: '1px solid color-mix(in srgb, var(--term-line) 50%, transparent)',
};

const BREADCRUMB_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11.5,
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const NODE_TIME_STYLE: React.CSSProperties = {
  flexShrink: 0,
  fontFamily: 'var(--mono-font, ui-monospace, monospace)',
  fontSize: 10.5,
  color: 'var(--term-faint)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

const SNIPPET_ROW_STYLE: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '1.55',
  color: 'var(--term-mid)',
  padding: '2px 0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const SNIPPET_ROLE_STYLE: React.CSSProperties = {
  color: 'var(--term-faint)',
  fontSize: 9,
  marginRight: 4,
};

const OVERFLOW_HINT_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--term-faint)',
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
  const { prefs, setPref } = usePrefs();
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

  // Server-side FTS search — node-grouped, time-sorted, with breadcrumbs.
  // Each result is one unique node with up to 3 best-matching snippets.
  const nodeSearch = useNodeSearch(debouncedQuery);
  const nodeResults = nodeSearch.nodes;

  // Keep the old flat search available for backward compat / fallback.
  const searchResult = useServerSearch(debouncedQuery, projects);
  const searchMatches = searchResult.matches;

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

  const allChats = useMemo(() => selectAllChats({ projects, nodes: nodesSnapshot }), [projects, nodesSnapshot]);

  // Live workspaces offered as direct jump targets — exclude deleted/archived
  // and the currently-active one (jumping to where you already are is a no-op).
  const workspaces = useMemo(
    () =>
      projects
        .filter((p) => !p.deletedAt && !p.archivedAt && p.id !== activeProject?.id)
        .map((p) => ({ id: p.id, name: p.name })),
    [projects, activeProject],
  );

  const switchWorkspace = useCallback(
    (projectId: string) => {
      openWorkspaceFromPalette(projectId, { selectProject, setPage, onClose });
    },
    [selectProject, setPage, onClose],
  );

  const liveTrees = useMemo(
    () => (activeProject?.trees ?? []).filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name || nodesSnapshot[t.rootNodeId]?.title || 'Untitled' })),
    [activeProject, nodesSnapshot],
  );
  const archivedTrees = useMemo(
    () => (activeProject?.trees ?? []).filter((t) => !!t.archivedAt).map((t) => ({ id: t.id, name: t.name || nodesSnapshot[t.rootNodeId]?.title || 'Untitled' })),
    [activeProject, nodesSnapshot],
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
        activeTreeId: activeProject?.activeTreeId ?? null,
        liveTrees,
        archivedTrees,
        bypassPermissions: prefs.bypassPermissions,
        toggleBypassPermissions: () => { setPref('bypassPermissions', !prefs.bypassPermissions); },
      }),
    [activePage, selection, allChats, navDeps, selectProject, activeProject, setPage, onClose, clearSelection, createDigest, openPane, createMergedChat, createThread, activateTree, archiveTree, unarchiveTree, liveTrees, archivedTrees, workspaces, switchWorkspace, prefs.bypassPermissions, setPref],
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

  // Flat list of keyboard-navigable rows = commands + node search results.
  const totalRows = visible.length + (showRecents ? 0 : nodeResults.length);

  // Reset the active highlight whenever the query changes so the user can
  // type a filter term and immediately press Enter to run the top match.
  // When the results include a workspace match, auto-focus it so Enter
  // switches workspaces without extra arrow-key navigation.
  useEffect(() => {
    const wsIdx = visible.findIndex((c) => c.group === 'workspace');
    setActive(wsIdx >= 0 ? wsIdx : 0);
  }, [query, visible]);

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
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Stabilize scroll when async search results arrive (totalRows changes)
  // without the active index itself changing. Without this, the DOM reflows
  // when the MESSAGES section appears and the previously-visible active row
  // may scroll out of view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${active}"]`);
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

  const onKey = (e: React.KeyboardEvent) => {
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
    ['nav', 'NAV'],
    ['action', 'ACTION'],
    ['workspace', 'WORKSPACE'],
    ['chat', 'CHAT'],
  ];

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Command palette"
      titleGlyph="▸"
      width={620}
      anchor="top"
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

        <div
          ref={listRef}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
          className="hide-sb"
        >
          {groups.map(([g, label]) => {
            const rows = visible.filter((c) => c.group === g);
            if (rows.length === 0) return null;
            return (
              <div key={g}>
                <div style={GROUP_LABEL}>{label}</div>
                {rows.map((c) => {
                  const idx = visible.indexOf(c);
                  const isActive = idx === active;
                  const quickKey = !showRecents && idx < 9 ? kbd('mod', String(idx + 1)) : null;
                  return (
                    <div
                      key={c.id}
                      data-row-idx={idx}
                      onMouseEnter={() => hoverSetActive(idx)}
                      onClick={() => { c.run(); onClose(); }}
                      style={rowStyle(isActive)}
                    >
                      <span style={ROW_GLYPH(isActive)}>{c.glyph}</span>
                      <span style={ROW_LABEL(isActive)}>{c.label}</span>
                      {quickKey ? (
                        <kbd
                          style={{
                            fontFamily: 'var(--mono-font, ui-monospace, monospace)',
                            fontSize: 10.5,
                            color: isActive ? 'var(--term-fg)' : 'var(--term-muted)',
                            background: isActive ? 'var(--term-subtle)' : 'var(--term-alt)',
                            border: '1px solid var(--term-line)',
                            borderRadius: 3,
                            padding: '1px 5px',
                            letterSpacing: '.04em',
                            flexShrink: 0,
                          }}
                        >
                          {quickKey}
                        </kbd>
                      ) : c.keys ? (
                        <span
                          style={{
                            fontFamily: 'var(--mono-font, ui-monospace, monospace)',
                            fontSize: 10.5,
                            color: 'var(--term-muted)',
                            letterSpacing: '.04em',
                          }}
                        >
                          {c.keys}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {visible.length === 0 && nodeResults.length === 0 && (
            <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--term-mid)', fontStyle: 'italic' }}>
              {showRecents ? 'no commands available' : 'no matches'}
            </div>
          )}
          {/* Node-grouped search results — deduped by node, time-sorted, with breadcrumbs */}
          {!showRecents && nodeResults.length > 0 && (
            <div>
              <div style={GROUP_LABEL}>
                MESSAGES · {nodeResults.length} node{nodeResults.length !== 1 ? 's' : ''}
              </div>
              {nodeResults.map((nr, ni) => {
                const rowIdx = visible.length + ni;
                const isActive = rowIdx === active;
                const overflow = nr.totalMatches - nr.snippets.length;
                return (
                  <div
                    key={nr.nodeId}
                    data-row-idx={rowIdx}
                    onMouseEnter={() => hoverSetActive(rowIdx)}
                    onClick={() => navigateToNodeResult(nr)}
                    style={{
                      ...nodeCardStyle(isActive),
                      ...(ni > 0 ? NODE_CARD_SEPARATOR : {}),
                    }}
                  >
                    {/* Breadcrumb + timestamp row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
                      <div style={BREADCRUMB_STYLE}>
                        <span style={{ color: 'var(--term-faint)', fontSize: 10.5, letterSpacing: '.02em' }}>
                          {nr.workspaceName}
                        </span>
                        {nr.breadcrumb.length > 0 && (
                          <span style={{ color: 'var(--term-line-s)', margin: '0 5px', fontSize: 10 }}>›</span>
                        )}
                        {nr.breadcrumb.map((seg, si) => {
                          const isLast = si === nr.breadcrumb.length - 1;
                          return (
                            <React.Fragment key={si}>
                              {si > 0 && (
                                <span style={{ color: 'var(--term-faint)', margin: '0 3px', fontSize: 10 }}>/</span>
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
                    <div style={{ marginTop: 5 }}>
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
    </ModalShell>
  );
}
