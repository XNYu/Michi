import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilePaneItem } from '../../state/paneItems';
import { useChatActions, useChatProjects } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { fetchArtifactContent } from '../../services/api';
import { getElectron } from '../../lib/electronBridge';
import MarkdownContent from '../MarkdownContent';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; content: string; size: number; modifiedAt: number; extension: string }
  | { phase: 'error'; message: string };

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

export default function FilePane({ item }: { item: FilePaneItem }) {
  const { projects } = useChatProjects();
  const { focusPane, setFocusedNodeId, updatePaneItem } = useChatActions();
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const shellStyle = usePaneShellStyle(item.id);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const loadRef = useRef<{ key: string; promise: Promise<LoadState> } | null>(null);
  const diskStateRef = useRef(item.diskState);
  diskStateRef.current = item.diskState;

  useEffect(() => {
    let active = true;
    setState({ phase: 'loading' });
    const key = `${item.projectId}\0${item.filePath}\0${reloadKey}`;
    const load = async (): Promise<LoadState> => {
      try {
        const electron = getElectron();
        if (item.filePath.startsWith('/') && electron?.readFile) {
          const stat = await electron.statFile?.(item.filePath);
          if (stat && stat.size > MAX_FILE_BYTES) throw new Error(`File is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
          const result = await electron.readFile(item.filePath);
          if (!result) throw new Error('File is not readable');
          const name = basename(item.filePath);
          const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
          return { phase: 'loaded', content: result.content, size: result.size, modifiedAt: result.modifiedAt, extension };
        }
        const result = await fetchArtifactContent(item.projectId, item.filePath);
        return {
          phase: 'loaded',
          content: result.content,
          size: result.size,
          modifiedAt: result.modifiedAt,
          extension: result.extension.toLowerCase(),
        };
      } catch (error) {
        return { phase: 'error', message: error instanceof Error ? error.message : 'Failed to read file' };
      }
    };
    if (loadRef.current?.key !== key) loadRef.current = { key, promise: load() };
    void loadRef.current.promise.then((next) => {
      if (!active) return;
      setState(next);
      if (next.phase === 'loaded' && diskStateRef.current) updatePaneItem(item.id, { diskState: undefined });
    });
    return () => { active = false; };
  }, [item.filePath, item.id, item.projectId, reloadKey, updatePaneItem]);

  const extension = state.phase === 'loaded'
    ? state.extension
    : (basename(item.filePath).split('.').pop()?.toLowerCase() ?? '');
  const isMarkdown = MARKDOWN_EXTS.has(extension);
  const absolutePath = useMemo(() => {
    if (item.filePath.startsWith('/')) return item.filePath;
    return project?.cwd ? `${project.cwd.replace(/\/$/, '')}/${item.filePath}` : null;
  }, [item.filePath, project?.cwd]);

  const openExternal = useCallback(() => {
    if (absolutePath) void getElectron()?.openPath?.(absolutePath);
  }, [absolutePath]);

  return (
    <div
      data-pane-id={item.id}
      data-pane-kind="file"
      className="terminal-pane"
      onMouseDown={() => { focusPane(item.id); setFocusedNodeId(null); }}
      style={shellStyle}
    >
      <div style={{ height: 36, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--term-line)', flexShrink: 0 }}>
        <span aria-hidden style={{ color: 'var(--term-accent)' }}>◇</span>
        <span title={item.filePath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--term-mid)' }}>
          {item.filePath}
        </span>
        {item.diskState === 'changed' ? (
          <button type="button" onClick={() => setReloadKey((value) => value + 1)} style={{ border: '1px solid var(--term-accent)', background: 'transparent', color: 'var(--term-accent)', padding: '2px 7px', fontFamily: 'var(--ui-font)', fontSize: 9.5, cursor: 'pointer', whiteSpace: 'nowrap' }}>● Changed on disk · refresh</button>
        ) : null}
        {item.diskState === 'removed' ? <span style={{ color: 'var(--term-danger)', fontSize: 9.5 }}>⚠ Deleted on disk</span> : null}
        {isMarkdown ? (
          <button
            type="button"
            className="t-icon-btn"
            onClick={() => updatePaneItem(item.id, { viewMode: item.viewMode === 'rendered' ? 'source' : 'rendered' })}
            style={{ fontSize: 10, color: 'var(--term-mid)' }}
          >
            {item.viewMode === 'rendered' ? 'source' : 'preview'}
          </button>
        ) : null}
        <button type="button" className="t-icon-btn" onClick={() => setReloadKey((value) => value + 1)} aria-label="Reload file" title="Reload file">↻</button>
        {absolutePath ? <button type="button" className="t-icon-btn" onClick={openExternal} aria-label="Open externally" title="Open externally">↗</button> : null}
      </div>
      <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 22px 28px', color: 'var(--term-fg)' }}>
        {state.phase === 'loading' ? <div style={{ color: 'var(--term-muted)', fontSize: 11 }}>loading {basename(item.filePath)}…</div> : null}
        {state.phase === 'error' ? <div style={{ color: 'var(--term-danger)', fontSize: 11 }}>⚠ {state.message}</div> : null}
        {state.phase === 'loaded' && isMarkdown && item.viewMode === 'rendered' ? (
          <MarkdownContent text={state.content} className="prose prose-sm max-w-none wrap-break-word" />
        ) : null}
        {state.phase === 'loaded' && (!isMarkdown || item.viewMode === 'source') ? (
          <pre style={{ margin: 0, minWidth: 'max-content', whiteSpace: 'pre', fontFamily: 'var(--message-code-font, monospace)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--term-mid)', tabSize: 2 }}>
            {state.content}
          </pre>
        ) : null}
      </div>
      {state.phase === 'loaded' ? (
        <div style={{ height: 24, padding: '0 12px', borderTop: '1px solid var(--term-line)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, fontSize: 9.5, color: 'var(--term-muted)' }}>
          <span>{basename(item.filePath)}</span>
          <span>{state.size < 1024 ? `${state.size} B` : `${(state.size / 1024).toFixed(1)} KB`}</span>
          <span>{new Date(state.modifiedAt).toLocaleTimeString()}</span>
        </div>
      ) : null}
    </div>
  );
}
