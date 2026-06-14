import React from 'react';
import MarkdownContent from './MarkdownContent';

export type ExportPanelState =
  | { kind: 'idle' }
  | { kind: 'running'; projectName: string; exportTitle: string }
  | { kind: 'done'; projectName: string; exportTitle: string; markdown: string; suggestedFilename: string }
  | { kind: 'error'; projectName: string; exportTitle: string; error: string };

interface ExportPanelProps {
  open: boolean;
  state: ExportPanelState;
  onClose(): void;
  onAbort(): void;
  onSave(): void;
}

const PANEL_PROSE =
  'prose prose-sm max-w-none wrap-break-word ' +
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ' +
  '[&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg) ' +
  '[&_p]:text-(--term-mid) [&_li]:text-(--term-mid) ' +
  '[&_strong]:text-(--term-fg) [&_a]:text-(--term-accent) ' +
  '[&_code]:text-(--term-fg) [&_code]:bg-(--term-alt) [&_code]:px-1 [&_code]:rounded';

export default function ExportPanel({ open, state, onClose, onAbort, onSave }: ExportPanelProps) {
  const headerTitle = state.kind === 'idle' ? 'Export' : `Export: ${state.exportTitle}`;

  return (
    <aside
      aria-hidden={!open}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 22, // clear status bar
        width: 480,
        maxWidth: '60vw',
        zIndex: 30,
        background: 'var(--term-pane-bg, var(--term-surface))',
        borderLeft: 'var(--term-pane-divider, 1px solid var(--term-line))',
        boxShadow: 'var(--term-pane-shadow, -8px 0 24px rgba(0,0,0,0.12))',
        color: 'var(--term-fg)',
        fontFamily: 'var(--ui-font)',
        display: 'flex',
        flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 200ms cubic-bezier(.4,0,.2,1)',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      {/* header — matches Settings drawer header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--term-line)',
          background: 'var(--term-pane-header-bg, var(--term-alt))',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: '.14em',
            color: 'var(--term-muted)',
            textTransform: 'uppercase',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          ▸ {headerTitle}
        </span>
        <span
          onClick={onClose}
          title="Close (esc)"
          style={{
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--term-mid)',
            padding: '0 4px',
          }}
        >
          ×
        </span>
      </div>

      {/* body */}
      <div
        className="term-scrollbar"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          background: 'var(--term-bg)',
        }}
      >
        {state.kind === 'idle' && (
          <div
            style={{
              padding: '40px 18px',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--term-muted)',
              fontStyle: 'italic',
            }}
          >
            No export yet. Trigger Export from a thread menu.
          </div>
        )}

        {state.kind === 'running' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              padding: '40px 18px',
            }}
          >
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 0' }}
              aria-label="loading"
              role="status"
            >
              {['0s', '.15s', '.3s'].map((delay) => (
                <span
                  key={delay}
                  className="typing-dot"
                  style={{ animationDelay: delay }}
                />
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--term-mid)' }}>
              Preparing export…
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--term-muted)',
                textAlign: 'center',
                maxWidth: 320,
                lineHeight: 1.5,
              }}
            >
              Michi is preparing the original transcript.
            </div>
          </div>
        )}

        {state.kind === 'error' && (
          <div style={{ padding: 18 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--term-danger)',
                marginBottom: 8,
              }}
            >
              Export failed
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--term-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {state.error}
            </div>
          </div>
        )}

        {state.kind === 'done' && (
          <div style={{ padding: 18 }}>
            <MarkdownContent text={state.markdown} className={PANEL_PROSE} />
          </div>
        )}
      </div>

      {/* footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '10px 14px',
          borderTop: '1px solid var(--term-line)',
          background: 'var(--term-surface)',
          flexShrink: 0,
        }}
      >
        {state.kind === 'running' ? (
          <button
            type="button"
            onClick={onAbort}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--term-line)',
              background: 'transparent',
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            Abort
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--term-line)',
              background: 'transparent',
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={state.kind !== 'done'}
          style={{
            padding: '6px 14px',
            border: '1px solid var(--term-accent)',
            background: state.kind === 'done' ? 'var(--term-accent)' : 'transparent',
            color: state.kind === 'done' ? 'var(--term-bg)' : 'var(--term-muted)',
            fontFamily: 'var(--ui-font)',
            fontSize: 11.5,
            fontWeight: 600,
            cursor: state.kind === 'done' ? 'pointer' : 'not-allowed',
            opacity: state.kind === 'done' ? 1 : 0.5,
          }}
        >
          Save as…
        </button>
      </div>
    </aside>
  );
}
