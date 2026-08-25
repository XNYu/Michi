import React, { useEffect, useState } from 'react';
import type { DiffPaneItem } from '../../state/paneItems';
import { useChatActions } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { API_BASE_URL } from '../../config/env';

type DiffState =
  | { phase: 'loading' }
  | { phase: 'loaded'; diff: string; truncated: boolean }
  | { phase: 'error'; message: string };

function lineStyle(line: string): React.CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return { color: 'var(--term-muted)' };
  if (line.startsWith('+')) return { color: 'var(--term-digest)', background: 'color-mix(in srgb, var(--term-digest) 8%, transparent)' };
  if (line.startsWith('-')) return { color: 'var(--term-danger)', background: 'color-mix(in srgb, var(--term-danger) 8%, transparent)' };
  if (line.startsWith('@@')) return { color: 'var(--term-accent)', background: 'color-mix(in srgb, var(--term-accent) 7%, transparent)' };
  return { color: 'var(--term-mid)' };
}

export default function DiffPane({ item }: { item: DiffPaneItem }) {
  const { focusPane, setFocusedNodeId } = useChatActions();
  const shellStyle = usePaneShellStyle(item.id);
  const [state, setState] = useState<DiffState>({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    fetch(`${API_BASE_URL}/workspaces/${encodeURIComponent(item.projectId)}/diff?path=${encodeURIComponent(item.filePath)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'No working-tree diff for this file' : `Request failed (${response.status})`);
        return response.json() as Promise<{ diff: string; truncated?: boolean }>;
      })
      .then((body) => setState({ phase: 'loaded', diff: body.diff, truncated: !!body.truncated }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ phase: 'error', message: error instanceof Error ? error.message : 'Failed to load diff' });
      });
    return () => controller.abort();
  }, [item.filePath, item.projectId, reloadKey]);

  return (
    <div data-pane-id={item.id} data-pane-kind="diff" className="terminal-pane" onMouseDown={() => { focusPane(item.id); setFocusedNodeId(null); }} style={shellStyle}>
      <div style={{ height: 36, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--term-line)', flexShrink: 0 }}>
        <span style={{ color: 'var(--term-digest)', fontSize: 11, fontWeight: 700 }}>±</span>
        <span title={item.filePath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--term-mid)' }}>{item.filePath}</span>
        {state.phase === 'loaded' && state.truncated ? <span style={{ fontSize: 9.5, color: 'var(--term-muted)' }}>truncated</span> : null}
        <button type="button" className="t-icon-btn" onClick={() => setReloadKey((value) => value + 1)} aria-label="Reload diff">↻</button>
      </div>
      <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 0 24px' }}>
        {state.phase === 'loading' ? <div style={{ padding: '10px 14px', color: 'var(--term-muted)', fontSize: 11 }}>loading diff…</div> : null}
        {state.phase === 'error' ? <div style={{ padding: '10px 14px', color: 'var(--term-danger)', fontSize: 11 }}>⚠ {state.message}</div> : null}
        {state.phase === 'loaded' ? (
          <pre style={{ margin: 0, minWidth: 'max-content', fontFamily: 'var(--message-code-font, monospace)', fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre' }}>
            {state.diff.split('\n').map((line, index) => <span key={index} style={{ display: 'block', padding: '0 14px', ...lineStyle(line) }}>{line || ' '}</span>)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
