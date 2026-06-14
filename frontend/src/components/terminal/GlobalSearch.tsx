import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatNodeState, Project } from '../../state/chatTypes';
import { searchMessages, type MessageMatch } from '../../state/search';

export interface GlobalSearchProps {
  open: boolean;
  nodes: Record<string, ChatNodeState>;
  projects: Project[];
  activeProjectId: string | null;
  onClose: () => void;
  onOpenMatch: (m: MessageMatch) => void;
}

export default function GlobalSearch({
  open,
  nodes,
  projects,
  activeProjectId,
  onClose,
  onOpenMatch,
}: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce query input by 200ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebouncedQuery('');
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const result = useMemo(
    () => searchMessages(nodes, projects, debouncedQuery),
    [nodes, projects, debouncedQuery],
  );

  // Group matches by `${projectId}::${nodeId}` preserving result order.
  const groups = useMemo(() => {
    const map = new Map<string, MessageMatch[]>();
    for (const m of result.matches) {
      const k = `${m.projectId}::${m.nodeId}`;
      const arr = map.get(k);
      if (arr) arr.push(m);
      else map.set(k, [m]);
    }
    return Array.from(map.entries()).map(([key, ms]) => ({ key, matches: ms }));
  }, [result.matches]);

  const flatMatches = result.matches;

  useEffect(() => {
    if (activeIdx >= flatMatches.length) setActiveIdx(0);
  }, [flatMatches.length, activeIdx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(flatMatches.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        const m = flatMatches[activeIdx];
        if (m) {
          e.preventDefault();
          onOpenMatch(m);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flatMatches, activeIdx, onClose, onOpenMatch]);

  if (!open) return null;

  return createPortal(
    <div className="t-search-modal-backdrop" onMouseDown={onClose}>
      <div className="t-search-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="t-search-modal-header">
          <span className="t-search-modal-glyph">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search messages across workspaces…"
            type="text"
            className="t-search-modal-input"
            aria-label="search messages"
          />
          <button
            type="button"
            onClick={onClose}
            className="t-search-modal-close"
            aria-label="close"
          >
            ×
          </button>
        </header>
        <div className="t-search-modal-body">
          {!debouncedQuery.trim() && (
            <div className="t-search-modal-hint">
              type to search across workspaces · case-insensitive · message content only
            </div>
          )}
          {debouncedQuery.trim() && groups.length === 0 && (
            <div className="t-search-modal-hint">no matches</div>
          )}
          {groups.map((g) => {
            const head = g.matches[0];
            return (
              <div key={g.key} className="t-search-group">
                <div className="t-search-group-header">
                  ▸ {head.workspaceName} · {head.threadName} · {g.matches.length} match
                  {g.matches.length > 1 ? 'es' : ''}
                </div>
                {g.matches.map((m) => {
                  const flatIdx = flatMatches.indexOf(m);
                  const active = flatIdx === activeIdx;
                  return (
                    <div
                      key={`${m.nodeId}-${m.messageIdx}`}
                      className={`t-search-row ${active ? 'is-active' : ''}`}
                      onMouseEnter={() => setActiveIdx(flatIdx)}
                      onClick={() => onOpenMatch(m)}
                    >
                      <span className="t-search-row-role">{m.role === 'user' ? '👤' : '◆'}</span>
                      <span className="t-search-row-snippet">
                        {renderSnippetWithMark(m.snippet, m.matchOffsetInSnippet)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <footer className="t-search-modal-footer">
          <span>⏎ open · esc close</span>
          <span>
            {result.totalUnbounded} result{result.totalUnbounded === 1 ? '' : 's'}
            {result.truncated ? ` · capped at ${result.matches.length}` : ''}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function renderSnippetWithMark(text: string, range: [number, number]) {
  const [s, e] = range;
  return (
    <>
      {text.slice(0, s)}
      <mark>{text.slice(s, e)}</mark>
      {text.slice(e)}
    </>
  );
}

const MODAL_CSS = `
.t-search-modal-backdrop {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0,0,0,0.35);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 80px;
}
.t-search-modal {
  width: 620px; max-width: 90vw;
  background: var(--term-surface);
  border: 1px solid var(--term-line);
  box-shadow: 0 20px 60px rgba(0,0,0,0.25);
  font-family: var(--ui-font);
  display: flex; flex-direction: column;
  max-height: 70vh;
}
.t-search-modal-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--term-line);
}
.t-search-modal-glyph { color: var(--term-mid); font-size: 14px; }
.t-search-modal-input {
  flex: 1;
  background: transparent; border: 0; outline: none;
  font: inherit; color: var(--term-fg);
  font-size: 13px;
}
.t-search-modal-input::placeholder { color: var(--term-faint); }
.t-search-modal-close {
  background: transparent; border: 0; cursor: pointer;
  color: var(--term-faint); font-size: 16px;
  padding: 0 4px;
}
.t-search-modal-close:hover { color: var(--term-fg); }
.t-search-modal-body {
  flex: 1; overflow-y: auto;
  padding: 8px 0;
}
.t-search-modal-hint {
  padding: 16px 12px;
  color: var(--term-faint);
  font-size: 11px;
}
.t-search-group { padding: 4px 0; }
.t-search-group-header {
  padding: 4px 12px;
  color: var(--term-mid);
  font-size: 10.5px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.t-search-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 12px 6px 24px;
  cursor: pointer;
  font-size: 12px;
  color: var(--term-fg);
}
.t-search-row.is-active { background: var(--term-alt); }
.t-search-row-role { width: 16px; flex-shrink: 0; color: var(--term-mid); }
.t-search-row-snippet { flex: 1; line-height: 1.5; word-break: break-word; }
.t-search-row-snippet mark {
  background: var(--term-select-f, var(--term-alt));
  color: var(--term-fg);
  padding: 0 1px;
}
.t-search-modal-footer {
  display: flex; justify-content: space-between;
  padding: 8px 12px;
  border-top: 1px solid var(--term-line);
  color: var(--term-faint); font-size: 10px;
}
`;

if (typeof document !== 'undefined' && !document.getElementById('t-search-modal-css')) {
  const el = document.createElement('style');
  el.id = 't-search-modal-css';
  el.textContent = MODAL_CSS;
  document.head.appendChild(el);
}
