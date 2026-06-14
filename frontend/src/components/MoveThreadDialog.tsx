import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MoveThreadTarget {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  threadLabel: string;
  targets: readonly MoveThreadTarget[];
  onClose: () => void;
  onPick: (targetProjectId: string) => void;
}

const SCRIM: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(28,25,23,0.18)',
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'fadeIn 150ms ease-out both',
};

const PANE: React.CSSProperties = {
  position: 'relative',
  width: 480,
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface)',
  border: '1px solid var(--line-strong)',
  borderRadius: 0,
  boxShadow:
    '0 1px 0 rgba(0,0,0,.02), 0 1px 2px rgba(0,0,0,.04), 0 14px 28px -12px rgba(28,25,23,.28), inset 0 0 0 1px var(--surface)',
  fontFamily: 'var(--ui-font)',
  animation: 'scaleIn 180ms cubic-bezier(.2,.8,.2,1) both',
};

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 30,
  padding: '0 8px 0 12px',
  background: 'var(--surface-muted)',
  borderBottom: '1px solid var(--line)',
  gap: 8,
  flexShrink: 0,
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
  flexShrink: 0,
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

const PROMPT_GLYPH: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 12.5,
  color: 'var(--accent)',
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

export default function MoveThreadDialog({ open, threadLabel, targets, onClose, onPick }: Props) {
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setActiveIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => (t.name || 'Untitled').toLowerCase().includes(q));
  }, [targets, filter]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIndex]);

  if (!open) return null;

  const commit = (idx: number) => {
    const t = filtered[idx];
    if (!t) return;
    onPick(t.id);
    onClose();
  };

  // Move-thread role color, with accent fallback for themes that don't define it.
  const mauve = 'var(--mauve, var(--accent))';

  // Render via portal to document.body so the dialog escapes the sidebar's
  // stacking context (the sidebar has position:relative + z-index:1 +
  // overflow:hidden, which would otherwise clip & hit-confine this fixed
  // overlay to the sidebar's box — leaving the main pane uncovered).
  return createPortal(
    <div style={SCRIM} onClick={onClose}>
      <div style={PANE} onClick={(e) => e.stopPropagation()}>
        <div style={TAB_BAR}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 10.5,
              letterSpacing: '.14em',
              textTransform: 'uppercase',
              minWidth: 0,
              flex: 1,
            }}
          >
            <span style={{ color: mauve }} aria-hidden>⎇</span>
            <span style={{ color: mauve }}>MOVE THREAD</span>
            <span style={{ color: 'var(--fg-subtle, var(--fg-muted))' }} aria-hidden>·</span>
            <span
              title={threadLabel}
              style={{
                color: 'var(--fg-muted)',
                textTransform: 'none',
                letterSpacing: 0,
                fontFamily: 'var(--ui-font)',
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {threadLabel}
            </span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close" style={X_BTN}>×</button>
        </div>

        <div style={PROMPT_ROW}>
          <span style={PROMPT_GLYPH} aria-hidden>›_</span>
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                commit(activeIndex);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="filter workspaces…"
            style={PROMPT_INPUT}
          />
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            background: 'var(--app-bg)',
            padding: '6px 0',
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '10px 14px',
                color: 'var(--fg-muted)',
                fontSize: 12,
                fontStyle: 'italic',
              }}
            >
              No matching workspaces
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {filtered.map((t, idx) => {
                const active = idx === activeIndex;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => commit(idx)}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        background: active ? 'var(--surface-hover)' : 'transparent',
                        color: 'var(--fg)',
                        fontFamily: 'var(--ui-font)',
                        fontSize: 13.5,
                        padding: '7px 14px',
                        cursor: 'pointer',
                        borderLeft: active
                          ? '2px solid var(--accent)'
                          : '2px solid transparent',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                          color: active ? 'var(--accent)' : 'var(--fg-subtle, var(--fg-muted))',
                          flexShrink: 0,
                        }}
                      >
                        {active ? '›' : '>'}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.name || 'Untitled'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
