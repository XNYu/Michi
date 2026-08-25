import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactEntry, Project } from '../../state/chatTypes';
import type { FilesPaneItem } from '../../state/paneItems';
import { useChatActions, useChatProjects } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { fetchArtifactContent } from '../../services/api';
import { getElectron, type FilePreviewResult, type FileTreeEntry } from '../../lib/electronBridge';
import MarkdownContent from '../MarkdownContent';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

type DirectoryState =
  | { phase: 'loading'; entries: FileTreeEntry[] }
  | { phase: 'loaded'; entries: FileTreeEntry[] }
  | { phase: 'error'; entries: FileTreeEntry[]; message: string };

interface FileSelection {
  id: string;
  label: string;
  absolutePath?: string;
  artifactPath?: string;
}

type PreviewState =
  | { phase: 'empty' }
  | { phase: 'loading' }
  | { phase: 'loaded'; result: FilePreviewResult }
  | { phase: 'error'; message: string };

function basename(value: string): string {
  return value.split('/').filter(Boolean).pop() ?? value;
}

export function workspaceRoots(project: Project | undefined): string[] {
  if (!project) return [];
  const candidates = project.folders?.length
    ? project.folders.map((folder) => folder.path)
    : project.cwd ? [project.cwd] : [];
  return [...new Set(candidates.map((root) => root.replace(/\/$/, '')).filter(Boolean))];
}

export function resolveArtifactSelection(artifact: ArtifactEntry, project: Project | undefined): FileSelection | null {
  if (!artifact.filePath || artifact.type === 'link') return null;
  if (artifact.filePath.startsWith('/')) {
    return { id: `artifact:${artifact.id}`, label: artifact.name, absolutePath: artifact.filePath };
  }
  const cwd = project?.cwd ?? project?.folders?.[0]?.path;
  return {
    id: `artifact:${artifact.id}`,
    label: artifact.name,
    absolutePath: cwd ? `${cwd.replace(/\/$/, '')}/${artifact.filePath}` : undefined,
    artifactPath: artifact.filePath,
  };
}

function isTreeMatch(entry: FileTreeEntry, filter: string, directories: Record<string, DirectoryState>): boolean {
  if (!filter) return true;
  if (entry.name.toLocaleLowerCase().includes(filter)) return true;
  if (entry.kind !== 'directory') return false;
  return directories[entry.path]?.entries.some((child) => isTreeMatch(child, filter, directories)) ?? false;
}

const TreeRow = memo(function TreeRow({
  entry,
  depth,
  directories,
  expanded,
  filter,
  selectedPath,
  onToggle,
  onSelect,
}: {
  entry: FileTreeEntry;
  depth: number;
  directories: Record<string, DirectoryState>;
  expanded: ReadonlySet<string>;
  filter: string;
  selectedPath?: string;
  onToggle: (path: string) => void;
  onSelect: (entry: FileTreeEntry) => void;
}) {
  if (!isTreeMatch(entry, filter, directories)) return null;
  const isDirectory = entry.kind === 'directory';
  const isExpanded = expanded.has(entry.path) || filter.length > 0;
  const state = directories[entry.path];
  return (
    <>
      <button
        type="button"
        onClick={() => isDirectory ? onToggle(entry.path) : onSelect(entry)}
        title={entry.path}
        style={{
          width: '100%',
          minHeight: 27,
          display: 'grid',
          gridTemplateColumns: '16px minmax(0, 1fr)',
          alignItems: 'center',
          gap: 4,
          padding: `3px 7px 3px ${7 + depth * 14}px`,
          border: 0,
          background: selectedPath === entry.path ? 'var(--term-alt)' : 'transparent',
          color: selectedPath === entry.path ? 'var(--term-fg)' : 'var(--term-mid)',
          cursor: 'pointer',
          fontFamily: 'var(--ui-font)',
          fontSize: 11,
          textAlign: 'left',
        }}
        onMouseEnter={(event) => { if (selectedPath !== entry.path) event.currentTarget.style.background = 'var(--term-hover-bg, var(--term-alt))'; }}
        onMouseLeave={(event) => { if (selectedPath !== entry.path) event.currentTarget.style.background = 'transparent'; }}
      >
        <span aria-hidden style={{ color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', textAlign: 'center' }}>
          {isDirectory ? (isExpanded ? '⌄' : '›') : '·'}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
      </button>
      {isDirectory && isExpanded ? (
        <div>
          {state?.phase === 'loading' ? <div style={{ padding: `4px 8px 4px ${29 + depth * 14}px`, color: 'var(--term-muted)', fontSize: 10 }}>loading…</div> : null}
          {state?.phase === 'error' ? <div style={{ padding: `4px 8px 4px ${29 + depth * 14}px`, color: 'var(--term-danger)', fontSize: 10 }}>{state.message}</div> : null}
          {state?.entries.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              directories={directories}
              expanded={expanded}
              filter={filter}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </>
  );
});

function Preview({ selection, project }: { selection: FileSelection | null; project: Project | undefined }) {
  const [state, setState] = useState<PreviewState>({ phase: 'empty' });
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');

  useEffect(() => {
    if (!selection) {
      setState({ phase: 'empty' });
      return;
    }
    let active = true;
    setState({ phase: 'loading' });
    const load = async (): Promise<FilePreviewResult> => {
      const electron = getElectron();
      if (selection.absolutePath && electron?.readFilePreview) {
        const result = await electron.readFilePreview(selection.absolutePath);
        if (!result) throw new Error('File is not readable or exceeds 5 MB');
        return result;
      }
      if (selection.artifactPath && project) {
        const result = await fetchArtifactContent(project.id, selection.artifactPath);
        return { kind: 'text', content: result.content, size: result.size, modifiedAt: result.modifiedAt, extension: result.extension };
      }
      throw new Error('Workspace browsing is available in the desktop app');
    };
    void load()
      .then((result) => { if (active) setState({ phase: 'loaded', result }); })
      .catch((error) => { if (active) setState({ phase: 'error', message: error instanceof Error ? error.message : 'Failed to read file' }); });
    return () => { active = false; };
  }, [project, selection]);

  const extension = state.phase === 'loaded' ? state.result.extension.toLowerCase() : '';
  const isMarkdown = MARKDOWN_EXTS.has(extension);

  return (
    <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 39, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid var(--term-line)' }}>
        <span aria-hidden style={{ color: 'var(--term-muted)' }}>▱</span>
        <span title={selection?.absolutePath ?? selection?.artifactPath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selection ? 'var(--term-mid)' : 'var(--term-muted)', fontSize: 11 }}>
          {selection ? selection.absolutePath ?? selection.artifactPath : '/'}
        </span>
        {state.phase === 'loaded' && state.result.kind === 'text' && isMarkdown ? (
          <button type="button" className="t-icon-btn" onClick={() => setViewMode((value) => value === 'rendered' ? 'source' : 'rendered')} style={{ width: 'auto', padding: '0 6px', fontSize: 9.5, color: 'var(--term-mid)' }}>
            {viewMode === 'rendered' ? 'source' : 'preview'}
          </button>
        ) : null}
        {selection?.absolutePath ? (
          <button type="button" className="t-icon-btn" aria-label="Open file externally" title="Open externally" onClick={() => { void getElectron()?.openPath?.(selection.absolutePath!); }}>↗</button>
        ) : null}
      </div>
      <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: state.phase === 'loaded' && state.result.kind === 'image' ? 18 : '20px 22px 28px', color: 'var(--term-fg)' }}>
        {state.phase === 'empty' ? (
          <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: 'var(--term-muted)', textAlign: 'center' }}>
            <div>
              <div aria-hidden style={{ fontSize: 32, lineHeight: 1, marginBottom: 12 }}>▱</div>
              <div style={{ color: 'var(--term-fg)', fontSize: 13, fontWeight: 500 }}>Open file</div>
              <div style={{ marginTop: 5, fontSize: 10.5 }}>Select a file from the workspace tree</div>
            </div>
          </div>
        ) : null}
        {state.phase === 'loading' ? <div style={{ color: 'var(--term-muted)', fontSize: 11 }}>loading {selection?.label}…</div> : null}
        {state.phase === 'error' ? <div style={{ color: 'var(--term-danger)', fontSize: 11 }}>{state.message}</div> : null}
        {state.phase === 'loaded' && state.result.kind === 'image' ? (
          <img src={state.result.dataUrl} alt={selection?.label ?? 'Preview'} style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', margin: '0 auto', objectFit: 'contain' }} />
        ) : null}
        {state.phase === 'loaded' && state.result.kind === 'text' && isMarkdown && viewMode === 'rendered' ? (
          <MarkdownContent text={state.result.content} className="prose prose-sm max-w-none wrap-break-word" />
        ) : null}
        {state.phase === 'loaded' && state.result.kind === 'text' && (!isMarkdown || viewMode === 'source') ? (
          <pre style={{ margin: 0, minWidth: 'max-content', whiteSpace: 'pre', fontFamily: 'var(--message-code-font, monospace)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--term-mid)', tabSize: 2 }}>{state.result.content}</pre>
        ) : null}
      </div>
    </div>
  );
}

export default function FilesPane({ item }: { item: FilesPaneItem }) {
  const { projects } = useChatProjects();
  const { focusPane, setFocusedNodeId } = useChatActions();
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const roots = useMemo(() => workspaceRoots(project), [project]);
  const rootsKey = roots.join('\0');
  const shellStyle = usePaneShellStyle(item.id);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const loadingDirectoriesRef = useRef<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState<FileSelection | null>(null);

  const loadDirectory = useCallback(async (directory: string) => {
    const current = directoriesRef.current[directory];
    if (current?.phase === 'loaded' || loadingDirectoriesRef.current.has(directory)) return;
    loadingDirectoriesRef.current.add(directory);
    setDirectories((previous) => ({ ...previous, [directory]: { phase: 'loading', entries: previous[directory]?.entries ?? [] } }));
    try {
      const electron = getElectron();
      if (!electron?.listDirectory) throw new Error('Desktop file browsing is unavailable');
      const entries = await electron.listDirectory(directory, roots);
      setDirectories((previous) => ({ ...previous, [directory]: { phase: 'loaded', entries } }));
    } catch (error) {
      setDirectories((previous) => ({
        ...previous,
        [directory]: { phase: 'error', entries: previous[directory]?.entries ?? [], message: error instanceof Error ? error.message : 'Unable to list directory' },
      }));
    } finally {
      loadingDirectoriesRef.current.delete(directory);
    }
  }, [rootsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadingDirectoriesRef.current.clear();
    setDirectories({});
    setExpanded(new Set(roots));
    setSelection(null);
    for (const root of roots) void loadDirectory(root);
  }, [loadDirectory, rootsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDirectory = useCallback((directory: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
    void loadDirectory(directory);
  }, [loadDirectory]);

  const artifactSelections = useMemo(
    () => (project?.artifacts ?? []).flatMap((artifact) => {
      const resolved = resolveArtifactSelection(artifact, project);
      return resolved ? [resolved] : [];
    }),
    [project],
  );
  const deferredFilter = useDeferredValue(filter);
  const normalizedFilter = deferredFilter.trim().toLocaleLowerCase();

  return (
    <div
      data-pane-id={item.id}
      data-pane-kind="files"
      className="terminal-pane"
      onMouseDown={() => { focusPane(item.id); setFocusedNodeId(null); }}
      style={shellStyle}
    >
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 31%)' }}>
        <Preview selection={selection} project={project} />
        <aside style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--term-line)', background: 'var(--term-pane-bg)' }}>
          <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 9px', borderBottom: '1px solid var(--term-line)' }}>
            <label style={{ width: '100%', height: 29, display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px', border: '1px solid var(--term-line)', borderRadius: 'var(--term-control-radius, 5px)', color: 'var(--term-muted)', background: 'var(--term-bg)' }}>
              <span aria-hidden>⌕</span>
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files…" aria-label="Filter files" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 11 }} />
            </label>
          </div>
          <div className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '5px 0 14px' }}>
            {roots.length === 0 ? <div style={{ padding: '10px 12px', color: 'var(--term-muted)', fontSize: 10.5 }}>No workspace folders</div> : null}
            {roots.map((root) => (
              <section key={root} style={{ marginBottom: 7 }}>
                <button type="button" onClick={() => toggleDirectory(root)} title={root} style={{ width: '100%', height: 28, display: 'grid', gridTemplateColumns: '17px minmax(0, 1fr)', alignItems: 'center', gap: 4, padding: '0 8px', border: 0, background: 'transparent', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 10.5, fontWeight: 600, textAlign: 'left', cursor: 'pointer' }}>
                  <span aria-hidden style={{ color: 'var(--term-muted)' }}>{expanded.has(root) ? '⌄' : '›'}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{basename(root) || root}</span>
                </button>
                {expanded.has(root) ? (
                  <div>
                    {directories[root]?.phase === 'loading' ? <div style={{ padding: '5px 12px 5px 29px', color: 'var(--term-muted)', fontSize: 10 }}>loading…</div> : null}
                    {directories[root]?.phase === 'error' ? <div style={{ padding: '5px 12px 5px 29px', color: 'var(--term-danger)', fontSize: 10 }}>{(directories[root] as Extract<DirectoryState, { phase: 'error' }>).message}</div> : null}
                    {directories[root]?.entries.map((entry) => (
                      <TreeRow key={entry.path} entry={entry} depth={0} directories={directories} expanded={expanded} filter={normalizedFilter} selectedPath={selection?.absolutePath} onToggle={toggleDirectory} onSelect={(chosen) => setSelection({ id: chosen.path, label: chosen.name, absolutePath: chosen.path })} />
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
            {artifactSelections.length > 0 ? (
              <section style={{ borderTop: '1px solid var(--term-line)', paddingTop: 6 }}>
                <div style={{ height: 25, display: 'flex', alignItems: 'center', padding: '0 9px', color: 'var(--term-muted)', fontSize: 9.5, fontWeight: 600, letterSpacing: '.05em' }}>ARTIFACTS</div>
                {artifactSelections.filter((artifact) => !normalizedFilter || artifact.label.toLocaleLowerCase().includes(normalizedFilter)).map((artifact) => (
                  <button key={artifact.id} type="button" onClick={() => setSelection(artifact)} title={artifact.absolutePath ?? artifact.artifactPath} style={{ width: '100%', minHeight: 28, display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', alignItems: 'center', gap: 4, padding: '3px 9px', border: 0, background: selection?.id === artifact.id ? 'var(--term-alt)' : 'transparent', color: selection?.id === artifact.id ? 'var(--term-fg)' : 'var(--term-mid)', cursor: 'pointer', fontFamily: 'var(--ui-font)', fontSize: 11, textAlign: 'left' }}>
                    <span aria-hidden style={{ color: 'var(--term-accent)', textAlign: 'center' }}>◇</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.label}</span>
                  </button>
                ))}
              </section>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
