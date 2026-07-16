import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useChatStore, useChatNodesSnapshot, selectAllChats } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { buildCommands, filterCommands, Command, PageId } from '../../state/commands';
import { searchMessages, type MessageMatch } from '../../state/search';
import { requestDigest } from '../../lib/digestPrompt';
import { navigateToNode } from '../../state/navigateToNode';

function renderSnippetWithMark(text: string, range: [number, number]) {
  const [s, e] = range;
  return (
    <>
      {text.slice(0, s)}
      <mark style={{ background: 'var(--accent)', color: 'var(--accent-fg)', padding: '0 2px' }}>
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
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12.5,
        color: 'var(--accent)',
        flexShrink: 0,
      }}
    >
      ›_
    </span>
  );
}

const SCRIM: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(28,25,23,0.18)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'fadeIn 150ms ease-out both',
};

const PANE: React.CSSProperties = {
  position: 'relative',
  width: 620,
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  border: '1px solid var(--line-strong)',
  borderRadius: 0,
  boxShadow:
    '0 1px 0 rgba(0,0,0,.02), 0 1px 2px rgba(0,0,0,.04), 0 14px 28px -12px rgba(28,25,23,.28), inset 0 0 0 1px var(--surface)',
  fontFamily: 'var(--ui-font)',
  animation: 'scaleIn 180ms cubic-bezier(.2,.8,.2,1) backwards',
};

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 30,
  padding: '0 8px 0 12px',
  background: 'var(--surface-muted)',
  borderBottom: '1px solid var(--line)',
  flexShrink: 0,
};

const TAB_TAG: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 10.5,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const X_BTN: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-subtle, var(--fg-muted))',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const PROMPT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--line)',
  background: 'var(--surface)',
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
  color: 'var(--fg)',
  padding: 0,
};

const GROUP_LABEL: React.CSSProperties = {
  padding: '10px 14px 4px',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 10,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle, var(--fg-muted))',
};

const rowStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 14px',
  background: active ? 'var(--surface-hover)' : 'transparent',
  borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
  cursor: 'pointer',
});

const ROW_GLYPH = (active: boolean): React.CSSProperties => ({
  width: 18,
  textAlign: 'center',
  color: active ? 'var(--accent)' : 'var(--fg-subtle, var(--fg-muted))',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 12,
  fontWeight: 600,
  flexShrink: 0,
});

const ROW_LABEL = (active: boolean): React.CSSProperties => ({
  fontFamily: 'var(--ui-font)',
  fontSize: 13,
  color: 'var(--fg)',
  flex: 1,
  fontWeight: active ? 600 : 400,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

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

  // In-memory message search over current store state — same source as ⌘⇧F.
  const searchResult = useMemo(
    () => searchMessages(nodesSnapshot, projects, debouncedQuery),
    [nodesSnapshot, projects, debouncedQuery],
  );
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
        hasActiveProject: !!activeProject,
        setPage: (p) => { setPage(p); onClose(); },
        fanoutFromSelection: () => {
          if (selection.size < 2) return;
          const nodeId = createMergedChat(Array.from(selection));
          openPane(nodeId);
          clearSelection();
          setPage('dashboard');
          onClose();
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
    [activePage, selection, allChats, navDeps, selectProject, activeProject, setPage, onClose, clearSelection, createDigest, openPane, createMergedChat, createThread, activateTree, archiveTree, unarchiveTree, liveTrees, archivedTrees, prefs.bypassPermissions, setPref],
  );
  const visible = useMemo(() => {
    const base = query.trim() ? filterCommands(cmds, query) : cmds;
    // Suppress "Switch to thread ▸ …" rows — they overlap visually with chat rows
    // whose titles match the tree name. Tree navigation already lives in the sidebar.
    return base.filter((c) => !c.id.startsWith('thread.switch.'));
  }, [cmds, query]);
  const showRecents = !query.trim();

  // Flat list of keyboard-navigable rows = commands + message matches.
  const totalRows = visible.length + (showRecents ? 0 : searchMatches.length);

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

  const runActiveRow = useCallback(() => {
    if (active < visible.length) {
      const c = visible[active];
      if (c) {
        c.run();
        onClose();
      }
      return;
    }
    const matchIdx = active - visible.length;
    const m = searchMatches[matchIdx];
    if (m) navigateToResult(m);
  }, [active, visible, searchMatches, onClose, navigateToResult]);

  const onKey = (e: React.KeyboardEvent) => {
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
      e.preventDefault();
      runActiveRow();
    }
  };

  const groups: Array<['nav' | 'action' | 'chat' | 'search-result', string]> = [
    ['nav', 'NAV'],
    ['action', 'ACTION'],
    ['chat', 'CHAT'],
  ];

  return (
    <div style={SCRIM} onClick={onClose}>
      <div style={PANE} onClick={(e) => e.stopPropagation()}>
        <div style={TAB_BAR}>
          <span style={TAB_TAG}>
            <span aria-hidden>▸</span> COMMAND PALETTE
          </span>
          <button type="button" onClick={onClose} aria-label="Close" style={X_BTN}>×</button>
        </div>

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
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--app-bg)' }}
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
                      {c.keys && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                            fontSize: 10.5,
                            color: 'var(--fg-subtle, var(--fg-muted))',
                            letterSpacing: '.04em',
                          }}
                        >
                          {c.keys}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {visible.length === 0 && searchMatches.length === 0 && (
            <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--fg-muted)', fontStyle: 'italic' }}>
              {showRecents ? 'no commands available' : 'no matches'}
            </div>
          )}
          {/* Message search results — same source as ⌘⇧F */}
          {!showRecents && searchMatches.length > 0 && (
            <div>
              <div style={GROUP_LABEL}>
                MESSAGES{searchResult.truncated ? ` · capped at ${searchMatches.length}` : ''}
              </div>
              {searchMatches.map((m, mi) => {
                const rowIdx = visible.length + mi;
                const isActive = rowIdx === active;
                return (
                  <div
                    key={`${m.nodeId}-${m.messageIdx}`}
                    data-row-idx={rowIdx}
                    onMouseEnter={() => hoverSetActive(rowIdx)}
                    onClick={() => navigateToResult(m)}
                    style={rowStyle(isActive)}
                  >
                    <span style={ROW_GLYPH(isActive)}>⌕</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--ui-font)', fontSize: 12, color: 'var(--fg)', fontWeight: isActive ? 600 : 500 }}>
                        {m.threadName || 'Untitled'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {renderSnippetWithMark(m.snippet, m.matchOffsetInSnippet)}
                      </div>
                      <div style={{ fontSize: 9.5, color: 'var(--fg-subtle, var(--fg-muted))' }}>{m.workspaceName}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
