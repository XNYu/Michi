import React, { useState } from 'react';
import { Dot } from './primitives';
import ContextMenu from '../ContextMenu';
import { kbd } from '../../lib/platform';

const PANE_DRAG_MIME = 'application/x-michi-pane-id';

function dotColorFor(streaming: boolean, error: boolean, focused: boolean): string {
  if (streaming) return 'var(--term-select)';
  if (error) return 'var(--term-danger)';
  if (focused) return 'var(--term-accent)';
  return 'var(--term-faint)';
}

interface Props {
  nodeId: string;
  title: string;
  focused: boolean;
  streaming: boolean;
  error: boolean;
  kind?: 'chat' | 'digest' | 'artifact' | 'file' | 'diff' | 'terminal' | 'browser';
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (keepId: string) => void;
  canCloseOthers: boolean;
  onReorder: (fromId: string, toId: string) => void;
}

export default function PaneCaption({
  nodeId,
  title,
  focused,
  streaming,
  error,
  kind = 'chat',
  onFocus,
  onClose,
  onCloseOthers,
  canCloseOthers,
  // onReorder is intentionally accepted but unused: drops are handled by
  // TPane's existing pane-level drop zone (paneDropSide). Keeping it in
  // the API lets TPane pass reorderPane unconditionally.
  onReorder: _onReorder,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [closeHover, setCloseHover] = useState(false);

  const isDigest = kind === 'digest';
  const isArtifact = kind === 'artifact';
  const kindGlyph = kind === 'file' ? '◇'
    : kind === 'diff' ? '±'
    : kind === 'terminal' ? '>_'
    : kind === 'browser' ? '◎'
    : null;
  const dotColor = isDigest
    ? 'var(--term-digest)'
    : isArtifact || kind === 'file' || kind === 'browser'
      ? 'var(--term-accent)'
      : kind === 'diff' || kind === 'terminal'
        ? 'var(--term-digest)'
      : dotColorFor(streaming, error, focused);

  const titleColor = focused ? 'var(--term-fg)' : 'var(--term-mid)';
  const titleWeight = focused ? 600 : 400;

  return (
    <>
      <div
        aria-label={`${title} pane${focused ? ', focused' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(PANE_DRAG_MIME, nodeId);
          e.dataTransfer.setData('text/plain', nodeId);
        }}
        onClick={() => onFocus(nodeId)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); setCloseHover(false); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          maxWidth: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          padding: '0 11px',
          border: hovered
            ? '1px solid var(--term-line)'
            : '1px solid transparent',
          borderRadius: 0,
          fontFamily: 'var(--ui-font)',
          fontSize: 12.5,
          color: titleColor,
          background: hovered ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
          userSelect: 'none',
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
          transition: 'background var(--t-quick) var(--t-ease)',
        } as React.CSSProperties}
      >
        <Dot color={dotColor} size={6} pulse={streaming && !isDigest} />
        {kindGlyph ? (
          <span aria-hidden style={{ color: dotColor, fontFamily: 'var(--mono-font)', fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>{kindGlyph}</span>
        ) : null}
        {isDigest && (
          <span
            aria-hidden
            style={{
              color: 'var(--term-digest)',
              fontWeight: 700,
              fontSize: 13,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            §
          </span>
        )}
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: titleWeight,
          }}
          title={title}
        >
          {title}
        </span>
        {isDigest && (
          <span
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 9,
              padding: '1px 5px',
              border: '1px solid var(--term-digest)',
              color: 'var(--term-digest)',
              letterSpacing: '.12em',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            DIGEST
          </span>
        )}
        {error && (
          <span
            aria-hidden
            style={{ color: 'var(--term-danger)', fontSize: 11, flexShrink: 0 }}
          >
            ⚠
          </span>
        )}
        <button
          type="button"
          aria-label={`Close ${title}`}
          tabIndex={hovered ? 0 : -1}
          aria-hidden={!hovered}
          onClick={(e) => {
            e.stopPropagation();
            onClose(nodeId);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          style={{
            width: 22,
            height: 22,
            marginRight: -6,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: closeHover ? '1px solid var(--term-line)' : '1px solid transparent',
            borderRadius: 3,
            background: closeHover ? 'var(--term-alt2, var(--term-alt))' : 'transparent',
            color: closeHover ? 'var(--term-fg)' : 'var(--term-faint)',
            fontFamily: 'inherit',
            fontSize: 14,
            lineHeight: 1,
            cursor: 'pointer',
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            transition: 'opacity var(--t-quick) var(--t-ease), background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease), border-color var(--t-quick) var(--t-ease)',
          }}
        >
          ×
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          sections={[
            {
              items: [
                { id: 'close', label: 'Close', keys: kbd('mod', 'W'), run: () => onClose(nodeId) },
                {
                  id: 'close-others',
                  label: 'Close Others',
                  keys: 'O',
                  disabled: !canCloseOthers,
                  run: () => onCloseOthers(nodeId),
                },
              ],
            },
          ]}
        />
      )}
    </>
  );
}
