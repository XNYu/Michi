import React, { useEffect, useState } from 'react';
import { workspaceBackendApiBase } from '../../config/backendConnections';
import { ModalShell } from '../ui/ModalShell';

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
 * Read-only unified-diff viewer on the shared ModalShell; fetches
 * GET /api/workspaces/:id/diff?path=... on mount. Escape is captured so
 * TerminalShell's own Escape (clear selection / leave fullscreen pages)
 * does not also fire in the same keypress.
 */
export function DiffModal({ workspaceId, filePath, onClose }: DiffModalProps) {
  const [state, setState] = useState<FetchState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(workspaceId)}/diff?path=${encodeURIComponent(filePath)}`,
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

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Diff"
      titleGlyph="±"
      aria-label={`diff: ${filePath}`}
      width={880}
      maxHeight="84vh"
      captureEscape
      headerTrailing={
        <>
          <span
            title={filePath}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11.5,
              color: 'var(--term-fg)',
            }}
          >
            {filePath}
          </span>
          {state.phase === 'loaded' && state.truncated && (
            <span style={{ color: 'var(--term-muted)', flexShrink: 0, fontSize: 10 }}>truncated at 100KB</span>
          )}
        </>
      }
    >
        <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px' }}>
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
    </ModalShell>
  );
}
