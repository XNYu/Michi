import React, { useEffect, useMemo, useState } from 'react';
import type { ReviewPaneItem } from '../../state/paneItems';
import { useChatActions, useChatProjects } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { getElectron, type GitChangeEntry } from '../../lib/electronBridge';
import { API_BASE_URL } from '../../config/env';
import { workspaceRoots } from './FilesPane';

type ChangesState =
  | { phase: 'loading'; changes: GitChangeEntry[] }
  | { phase: 'loaded'; changes: GitChangeEntry[] }
  | { phase: 'error'; changes: GitChangeEntry[]; message: string };

type DiffState =
  | { phase: 'empty' }
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

export default function ReviewPane({ item }: { item: ReviewPaneItem }) {
  const { projects } = useChatProjects();
  const { focusPane, setFocusedNodeId } = useChatActions();
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const roots = useMemo(() => workspaceRoots(project), [project]);
  const cwd = project?.cwd ?? roots[0] ?? '';
  const shellStyle = usePaneShellStyle(item.id);
  const [changes, setChanges] = useState<ChangesState>({ phase: 'loading', changes: [] });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [diff, setDiff] = useState<DiffState>({ phase: 'empty' });

  useEffect(() => {
    let active = true;
    setChanges({ phase: 'loading', changes: [] });
    const electron = getElectron();
    if (!cwd || !electron?.listGitChanges) {
      setChanges({ phase: 'error', changes: [], message: 'Review is available in the desktop app for Git workspaces' });
      return () => { active = false; };
    }
    void electron.listGitChanges(cwd, roots)
      .then((next) => { if (active) setChanges({ phase: 'loaded', changes: next }); })
      .catch((error) => { if (active) setChanges({ phase: 'error', changes: [], message: error instanceof Error ? error.message : 'Unable to read Git changes' }); });
    return () => { active = false; };
  }, [cwd, roots]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff({ phase: 'empty' });
      return;
    }
    const controller = new AbortController();
    setDiff({ phase: 'loading' });
    fetch(`${API_BASE_URL}/workspaces/${encodeURIComponent(item.projectId)}/diff?path=${encodeURIComponent(selectedPath)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'No diff is available for this file' : `Request failed (${response.status})`);
        return response.json() as Promise<{ diff: string; truncated?: boolean }>;
      })
      .then((body) => setDiff({ phase: 'loaded', diff: body.diff, truncated: !!body.truncated }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDiff({ phase: 'error', message: error instanceof Error ? error.message : 'Failed to load diff' });
      });
    return () => controller.abort();
  }, [item.projectId, selectedPath]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleChanges = changes.changes.filter((change) => !normalizedFilter || change.path.toLocaleLowerCase().includes(normalizedFilter));

  return (
    <div data-pane-id={item.id} data-pane-kind="review" className="terminal-pane" onMouseDown={() => { focusPane(item.id); setFocusedNodeId(null); }} style={shellStyle}>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 31%)' }}>
        <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 39, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid var(--term-line)', color: 'var(--term-mid)', fontSize: 11 }}>
            <span aria-hidden style={{ color: 'var(--term-digest)', fontWeight: 700 }}>±</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedPath ?? 'Working tree'}</span>
            {diff.phase === 'loaded' && diff.truncated ? <span style={{ color: 'var(--term-muted)', fontSize: 9.5 }}>truncated</span> : null}
          </div>
          <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: diff.phase === 'loaded' ? '10px 0 24px' : '20px 22px' }}>
            {diff.phase === 'empty' ? <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: 'var(--term-muted)', fontSize: 11 }}>Select a changed file to review</div> : null}
            {diff.phase === 'loading' ? <div style={{ color: 'var(--term-muted)', fontSize: 11 }}>loading diff…</div> : null}
            {diff.phase === 'error' ? <div style={{ color: 'var(--term-danger)', fontSize: 11 }}>{diff.message}</div> : null}
            {diff.phase === 'loaded' ? (
              <pre style={{ margin: 0, minWidth: 'max-content', fontFamily: 'var(--message-code-font, monospace)', fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre' }}>
                {diff.diff.split('\n').map((line, index) => <span key={index} style={{ display: 'block', padding: '0 14px', ...lineStyle(line) }}>{line || ' '}</span>)}
              </pre>
            ) : null}
          </div>
        </div>
        <aside style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--term-line)' }}>
          <div style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 9px', borderBottom: '1px solid var(--term-line)' }}>
            <label style={{ width: '100%', height: 29, display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px', border: '1px solid var(--term-line)', borderRadius: 'var(--term-control-radius, 5px)', color: 'var(--term-muted)', background: 'var(--term-bg)' }}>
              <span aria-hidden>⌕</span>
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter changes…" aria-label="Filter changes" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 11 }} />
            </label>
          </div>
          <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 0 14px' }}>
            {changes.phase === 'loading' ? <div style={{ padding: '8px 11px', color: 'var(--term-muted)', fontSize: 10.5 }}>reading Git status…</div> : null}
            {changes.phase === 'error' ? <div style={{ padding: '8px 11px', color: 'var(--term-danger)', fontSize: 10.5 }}>{changes.message}</div> : null}
            {changes.phase === 'loaded' && changes.changes.length === 0 ? <div style={{ padding: '8px 11px', color: 'var(--term-muted)', fontSize: 10.5 }}>Working tree is clean</div> : null}
            {visibleChanges.map((change) => (
              <button key={`${change.status}:${change.path}`} type="button" onClick={() => setSelectedPath(change.path)} title={change.path} style={{ width: '100%', minHeight: 29, display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', alignItems: 'center', gap: 3, padding: '3px 9px', border: 0, background: selectedPath === change.path ? 'var(--term-alt)' : 'transparent', color: selectedPath === change.path ? 'var(--term-fg)' : 'var(--term-mid)', cursor: 'pointer', fontFamily: 'var(--ui-font)', fontSize: 10.5, textAlign: 'left' }}>
                <span style={{ color: 'var(--term-digest)', fontFamily: 'var(--mono-font)', fontSize: 9.5 }}>{change.status}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.path}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
