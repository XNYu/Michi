import React from 'react';
import MarkdownContent from './MarkdownContent';
import { DrawerShell } from './ui/DrawerShell';
import { Button } from './ui/controls';

export type ExportPanelState =
  | { kind: 'idle' }
  | { kind: 'loading'; projectName: string; exportTitle: string }
  | { kind: 'done'; projectName: string; exportTitle: string; markdown: string; suggestedFilename: string }
  | { kind: 'error'; projectName: string; exportTitle: string; error: string };

interface ExportPanelProps {
  open: boolean;
  state: ExportPanelState;
  onClose(): void;
  onSave(): void;
}

const PANEL_PROSE =
  'prose prose-sm max-w-none wrap-break-word ' +
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ' +
  '[&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg) ' +
  '[&_p]:text-(--term-mid) [&_li]:text-(--term-mid) ' +
  '[&_strong]:text-(--term-fg) [&_a]:text-(--term-accent) ' +
  '[&_code]:text-(--term-fg) [&_code]:bg-(--term-alt) [&_code]:px-1 [&_code]:rounded-(--ui-radius-sm)';

export default function ExportPanel({ open, state, onClose, onSave }: ExportPanelProps) {
  const headerTitle = state.kind === 'idle' ? 'Export' : `Export · ${state.exportTitle}`;

  return (
    <DrawerShell open={open} onClose={onClose} title={headerTitle}>
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
              fontSize: 'var(--fs-md)',
              color: 'var(--term-muted)',
              fontStyle: 'italic',
            }}
          >
            No export yet. Trigger Export from a thread menu.
          </div>
        )}

        {state.kind === 'error' && (
          <div style={{ padding: 18 }}>
            <div
              style={{
                fontSize: 'var(--fs-md)',
                fontWeight: 600,
                color: 'var(--term-danger)',
                marginBottom: 8,
              }}
            >
              Export failed
            </div>
            <div
              style={{
                fontSize: 'var(--fs-sm)',
                color: 'var(--term-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {state.error}
            </div>
          </div>
        )}

        {state.kind === 'loading' && (
          <div role="status" className="p-5 text-muted">Loading conversation history…</div>
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
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" onClick={onSave} disabled={state.kind !== 'done'}>
          Save as…
        </Button>
      </div>
    </DrawerShell>
  );
}
