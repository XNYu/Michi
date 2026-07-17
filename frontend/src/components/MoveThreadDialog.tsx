import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ModalShell } from './ui/ModalShell';

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

const PROMPT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--term-line)',
  background: 'var(--term-surface)',
  flexShrink: 0,
};

const PROMPT_GLYPH: React.CSSProperties = {
  fontFamily: 'var(--mono-font, ui-monospace, monospace)',
  fontSize: 12.5,
  color: 'var(--term-mauve, var(--term-accent))',
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

  const commit = (idx: number) => {
    const t = filtered[idx];
    if (!t) return;
    onPick(t.id);
    onClose();
  };

  // Move-thread role color, with accent fallback for themes that don't define it.
  const mauve = 'var(--term-mauve, var(--term-accent))';

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Move thread"
      titleGlyph="⎇"
      accent={mauve}
      width={480}
      headerTrailing={
        <span
          title={threadLabel}
          style={{
            color: 'var(--term-mid)',
            fontFamily: 'var(--ui-font)',
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 200,
          }}
        >
          {threadLabel}
        </span>
      }
    >
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
            }
          }}
          placeholder="filter workspaces…"
          style={PROMPT_INPUT}
        />
      </div>

      <div
        className="term-scrollbar"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          background: 'var(--term-bg)',
          padding: '6px 0',
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '10px 14px',
              color: 'var(--term-mid)',
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
                      background: active ? 'var(--term-alt)' : 'transparent',
                      color: 'var(--term-fg)',
                      fontFamily: 'var(--ui-font)',
                      fontSize: 13.5,
                      padding: '7px 14px',
                      cursor: 'pointer',
                      borderLeft: active
                        ? '2px solid var(--term-accent)'
                        : '2px solid transparent',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        fontFamily: 'var(--mono-font, ui-monospace, monospace)',
                        color: active ? 'var(--term-accent)' : 'var(--term-muted)',
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
    </ModalShell>
  );
}
