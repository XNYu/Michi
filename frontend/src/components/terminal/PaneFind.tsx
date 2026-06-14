import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatNodeState } from '../../state/chatTypes';
import { visibleMessageText } from '../../state/assistantBlocks';

export interface FindMatch {
  messageId: string;
  messageIdx: number;
  start: number;
  end: number;
}

export interface PaneFindProps {
  open: boolean;
  node: ChatNodeState;
  onClose: () => void;
  /**
   * Navigate to a match. `occurrence` is the 0-based index of this hit *within
   * its own message* (not the global list), and `query` is the active search
   * term — together they let TPane re-find and flash that exact hit in the DOM.
   */
  onScrollToMatch: (match: FindMatch, occurrence: number, query: string) => void;
  /**
   * Bumped by the parent on every ⌘F press. While `open` is already true,
   * incrementing this re-focuses + selects the existing input so the user
   * can retype without first clearing.
   */
  focusNonce?: number;
}

export default function PaneFind({ open, node, onClose, onScrollToMatch, focusNonce }: PaneFindProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [currentIdx, setCurrentIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setCurrentIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Refocus + select on each ⌘F nonce bump while already open.
  useEffect(() => {
    if (!open) return;
    if (focusNonce === undefined) return;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }, [focusNonce, open]);

  // Global ESC while find is open — closes regardless of focus location.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 80);
    return () => clearTimeout(t);
  }, [query]);

  const matches = useMemo<FindMatch[]>(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return [];
    const out: FindMatch[] = [];
    for (let i = 0; i < node.messages.length; i++) {
      const m = node.messages[i];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const lower = visibleMessageText(m).toLowerCase();
      let idx = 0;
      while (idx < lower.length) {
        const found = lower.indexOf(q, idx);
        if (found === -1) break;
        out.push({ messageId: m.id, messageIdx: i, start: found, end: found + q.length });
        idx = found + q.length;
      }
    }
    return out;
  }, [node.messages, debounced]);

  // Broadcast query changes so TPane can paint matching ranges via CSS
  // Custom Highlight API. Fires on every debounced query change while open,
  // and clears (sends empty query) when closed/unmounted.
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(
      new CustomEvent('michi:pane-find-update', {
        detail: { nodeId: node.nodeId, query: debounced },
      }),
    );
  }, [open, debounced, node.nodeId]);

  useEffect(() => {
    if (!open) {
      window.dispatchEvent(
        new CustomEvent('michi:pane-find-update', {
          detail: { nodeId: node.nodeId, query: '' },
        }),
      );
    }
  }, [open, node.nodeId]);

  // Reset cursor when matches change (typing, query edits).
  // We deliberately do NOT scroll/flash here — that's reserved for user-driven
  // navigation (Enter, prev/next buttons). Typing should only update the
  // highlight overlay and counter; the viewport stays put.
  useEffect(() => {
    setCurrentIdx(0);
  }, [matches]);

  if (!open) return null;

  function go(delta: number) {
    if (matches.length === 0) return;
    const next = (currentIdx + delta + matches.length) % matches.length;
    setCurrentIdx(next);
    const match = matches[next];
    // Occurrence index of this hit within its own message (matches are in
    // message order, so counting earlier same-message hits gives the position).
    let occurrence = 0;
    for (let i = 0; i < next; i++) {
      if (matches[i].messageId === match.messageId) occurrence++;
    }
    onScrollToMatch(match, occurrence, debounced);
  }

  return (
    <div className="t-pane-find" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="find in pane…"
        className="t-pane-find-input"
        type="text"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <button type="button" className="t-pane-find-nav" onClick={() => go(-1)} aria-label="prev">◀</button>
      <button type="button" className="t-pane-find-nav" onClick={() => go(1)} aria-label="next">▶</button>
      <span className="t-pane-find-counter">
        {matches.length === 0 ? '0 / 0' : `${currentIdx + 1} / ${matches.length}`}
      </span>
      <button type="button" className="t-pane-find-close" onClick={onClose} aria-label="close">×</button>
    </div>
  );
}

const FIND_CSS = `
/* CSS Custom Highlight API rule for ⌘F per-pane find. Keep this runtime-injected
   so Lightning CSS does not warn on the valid ::highlight() pseudo-element. */
::highlight(pane-find) {
  background-color: color-mix(in srgb, var(--term-select, #ffd54f) 38%, transparent);
}
.t-pane-find {
  position: absolute; top: 8px; right: 8px;
  display: flex; align-items: center; gap: 4px;
  padding: 4px 6px;
  background: var(--term-surface);
  border: 1px solid var(--term-line);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  font-family: var(--ui-font);
  font-size: 11px;
  z-index: 100;
}
.t-pane-find-input {
  width: 160px;
  background: transparent; border: 0; outline: none;
  font: inherit; color: var(--term-fg);
  padding: 2px 6px;
}
.t-pane-find-input::placeholder { color: var(--term-faint); }
.t-pane-find-nav, .t-pane-find-close {
  background: transparent; border: 0; cursor: pointer;
  color: var(--term-mid);
  padding: 2px 4px;
  font: inherit;
  border-radius: 2px;
}
.t-pane-find-nav:hover, .t-pane-find-close:hover {
  background: var(--term-hover-bg, var(--term-alt)); color: var(--term-fg);
}
.t-pane-find-counter {
  color: var(--term-faint);
  padding: 0 4px;
  white-space: nowrap;
}
`;

if (typeof document !== 'undefined' && !document.getElementById('t-pane-find-css')) {
  const el = document.createElement('style');
  el.id = 't-pane-find-css';
  el.textContent = FIND_CSS;
  document.head.appendChild(el);
}
