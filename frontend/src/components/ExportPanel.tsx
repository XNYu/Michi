import React from 'react';
import MarkdownContent from './MarkdownContent';
import { DrawerShell } from './ui/DrawerShell';
import { Button } from './ui/controls';

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
  const headerTitle = state.kind === 'idle' ? 'Export' : `Export · ${state.exportTitle}`;

  // Dismissing (Escape / scrim click) while an export is in flight should abort
  // it, not leave the controller running behind a closed drawer (which would
  // later flip state to done/error and show a stale result on next open).
  const dismiss = state.kind === 'running' ? onAbort : onClose;

  return (
    <DrawerShell open={open} onClose={dismiss} title={headerTitle}>
      {/* body */}
      <div
        className="term-scrollbar"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
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
          flexShrink: 0,
        }}
      >
        {state.kind === 'running' ? (
          <Button variant="secondary" onClick={onAbort}>
            Abort
          </Button>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )}
        <Button variant="primary" onClick={onSave} disabled={state.kind !== 'done'}>
          Save as…
        </Button>
      </div>
    </DrawerShell>
  );
}
