import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE_URL } from '../../config/env';

export interface DiffModalProps {
  /** Workspace whose cwd the diff is resolved against. */
  workspaceId: string;
  /** Workspace-relative file path. Shown as the modal title. */
  filePath: string;
  onClose: () => void;
}

type FetchState =
  | { phase: 'loading' }
  | { phase: 'loaded'; diff: string; truncated: boolean }
  | { phase: 'error'; message: string };

function lineColor(line: string): string | undefined {
  if (line.startsWith('+++') || line.startsWith('---')) return 'var(--term-muted)';
  if (line.startsWith('+')) return 'var(--term-digest)';
  if (line.startsWith('-')) return 'var(--term-danger)';
  if (line.startsWith('@@')) return 'var(--term-accent)';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'var(--term-muted)';
  return undefined;
}

/**
 * Read-only unified-diff viewer. Centered modal over a dim backdrop;
 * fetches GET /api/workspaces/:id/diff?path=... on mount. Dismiss on
 * Escape or backdrop click. Portal to <body> — pane ancestors set
 * `filter`, which would otherwise trap `position: fixed` inside the pane
 * (same reason Lightbox portals).
 */
export function DiffModal({ workspaceId, filePath, onClose }: DiffModalProps) {
  const [state, setState] = useState<FetchState>({ phase: 'loading' });

  useEffect(() => {
    // Capture phase + preventDefault + stopPropagation: the modal must
    // consume Escape exclusively. TerminalShell's global bubble-phase
    // keydown handler also acts on Escape (clears selection / leaves
    // fullscreen pages) and would otherwise fire in the same keypress.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // stopImmediatePropagation, not stopPropagation: when the event target
      // is window/document itself, plain stopPropagation would not suppress
      // the shell's bubble-phase listener registered on the same node.
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/workspaces/${encodeURIComponent(workspaceId)}/diff?path=${encodeURIComponent(filePath)}`,
          { signal: controller.signal },
        );
        if (cancelled) return;
        if (!res.ok) {
          setState({
            phase: 'error',
            message: res.status === 404 ? 'no diff available for this file' : `request failed (${res.status})`,
          });
          return;
        }
        const body = (await res.json()) as { diff: string; truncated?: boolean };
        if (cancelled) return;
        setState({ phase: 'loaded', diff: body.diff, truncated: !!body.truncated });
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setState({ phase: 'error', message: 'failed to fetch diff' });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId, filePath]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`diff: ${filePath}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(880px, 92vw)',
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-bg, var(--app-bg))',
          border: '1px solid var(--term-line)',
          fontFamily: 'var(--ui-font)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--term-line)',
            fontSize: 11.5,
            color: 'var(--term-fg)',
          }}
        >
          <span style={{ color: 'var(--term-muted)', flexShrink: 0 }}>diff</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {filePath}
          </span>
          {state.phase === 'loaded' && state.truncated && (
            <span style={{ color: 'var(--term-muted)', flexShrink: 0, fontSize: 10 }}>truncated at 100KB</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="t-icon-btn"
            aria-label="close diff"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--term-muted)',
              cursor: 'pointer',
              padding: '2px 4px',
              fontSize: 12,
            }}
          >
            ✕
          </button>
        </div>
        <div className="term-scrollbar" style={{ overflowY: 'auto', padding: '8px 12px' }}>
          {state.phase === 'loading' && (
            <div style={{ fontSize: 11, color: 'var(--term-muted)', padding: '12px 0' }}>loading diff…</div>
          )}
          {state.phase === 'error' && (
            <div style={{ fontSize: 11, color: 'var(--term-danger)', padding: '12px 0' }}>⚠ {state.message}</div>
          )}
          {state.phase === 'loaded' && (
            <pre
              style={{
                margin: 0,
                fontSize: 11,
                lineHeight: 1.55,
                fontFamily: 'var(--message-code-font, monospace)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {state.diff.split('\n').map((line, i) => (
                <span key={i} style={{ display: 'block', color: lineColor(line) ?? 'var(--term-mid)' }}>
                  {line || ' '}
                </span>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
