import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FilePaneItem } from '../../state/paneItems';
import { useChatActions, useChatProjects, useChatStore, ChatNodeStoreContext } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { fetchArtifactContent } from '../../services/api';
import { getElectron } from '../../lib/electronBridge';
import MarkdownContent from '../MarkdownContent';
import SelectionActions from '../SelectionActions';
import { formatQuotedMessage, QuoteSource } from '../../lib/quoteFormat';
import { computeTextSelector, rangeToOffsets, type TextSelector } from '../../lib/textSelector';
import { RetryIcon, ExternalLinkIcon } from './icons';
import { usePrefs } from '../../state/prefs';
import { DARK_PALETTES } from './tokens';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; content: string; size: number; modifiedAt: number; extension: string }
  | { phase: 'error'; message: string };

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

const fileProseVars: React.CSSProperties = {
  '--tw-prose-body': 'var(--term-fg)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent)',
  '--tw-prose-counters': 'var(--term-mid)',
  '--tw-prose-bullets': 'var(--term-mid)',
} as React.CSSProperties;

export default function FilePane({ item }: { item: FilePaneItem }) {
  const { projects } = useChatProjects();
  const { focusPane, setFocusedNodeId, updatePaneItem, createChildChat, addPendingComment, setComposerDraft } = useChatActions();
  const { focusedNodeId } = useChatStore();
  const nodeStore = useContext(ChatNodeStoreContext)!;
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const shellStyle = usePaneShellStyle(item.id);
  const { prefs } = usePrefs();
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const loadRef = useRef<{ key: string; promise: Promise<LoadState> } | null>(null);
  const diskStateRef = useRef(item.diskState);
  diskStateRef.current = item.diskState;
  const contentScrollRef = useRef<HTMLDivElement>(null);

  // Track the last focused chat pane so selection actions route there even
  // while the file pane itself is focused (for reading).
  const lastFocusedChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedNodeId && focusedNodeId !== item.id) {
      const target = nodeStore.getNode(focusedNodeId);
      if (target && target.kind === 'chat') {
        lastFocusedChatRef.current = focusedNodeId;
      }
    }
  }, [focusedNodeId, item.id, nodeStore]);

  /** Resolve the target chat node for quote/comment/branch routing. */
  const getTargetChatNodeId = useCallback((): string | null => {
    if (focusedNodeId && focusedNodeId !== item.id) {
      const target = nodeStore.getNode(focusedNodeId);
      if (target && target.kind === 'chat') return focusedNodeId;
    }
    return lastFocusedChatRef.current;
  }, [focusedNodeId, item.id, nodeStore]);

  const fileSource = useMemo((): QuoteSource | undefined => {
    return { type: 'artifact', name: basename(item.filePath), filePath: item.filePath };
  }, [item.filePath]);

  const handleQuote = useCallback(
    (text: string) => {
      const targetId = getTargetChatNodeId();
      if (!targetId) return;
      const target = nodeStore.getNode(targetId);
      setComposerDraft(targetId, {
        value: target?.composerDraft?.value ?? '',
        mentions: target?.composerDraft?.mentions ?? [],
        quotedText: text,
      });
    },
    [getTargetChatNodeId, nodeStore, setComposerDraft],
  );

  const handleBranch = useCallback(
    (quoted: string, prompt: string) => {
      const targetId = getTargetChatNodeId();
      if (!targetId) return;
      void createChildChat(
        targetId,
        formatQuotedMessage(quoted, prompt, fileSource),
        { quotedText: quoted, displayText: prompt },
      ).catch(() => {});
    },
    [getTargetChatNodeId, createChildChat, fileSource],
  );

  const handleComment = useCallback(
    (quoted: string, body: string, range?: Range) => {
      const targetId = getTargetChatNodeId();
      if (!targetId) return;
      const docText = state.phase === 'loaded' ? state.content : null;
      let sourceWithSelector = fileSource;
      if (range && docText && fileSource && contentScrollRef.current) {
        const offsets = rangeToOffsets(range, contentScrollRef.current, docText);
        if (offsets) {
          const selector = computeTextSelector(docText, offsets.startOffset, offsets.endOffset);
          sourceWithSelector = { ...fileSource, selector };
        }
      }
      addPendingComment(targetId, quoted, body, sourceWithSelector);
    },
    [getTargetChatNodeId, addPendingComment, fileSource, state],
  );

  useEffect(() => {
    let active = true;
    setState({ phase: 'loading' });
    const key = `${item.projectId}\0${item.filePath}\0${reloadKey}`;
    const load = async (): Promise<LoadState> => {
      try {
        const electron = getElectron();
        if (item.filePath.startsWith('/') && electron?.readFile && !project?.backendConnectionId) {
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
  }, [item.filePath, item.id, item.projectId, project?.backendConnectionId, reloadKey, updatePaneItem]);

  const extension = state.phase === 'loaded'
    ? state.extension
    : (basename(item.filePath).split('.').pop()?.toLowerCase() ?? '');
  const isMarkdown = MARKDOWN_EXTS.has(extension);
  const absolutePath = useMemo(() => {
    if (project?.backendConnectionId) return null;
    if (item.filePath.startsWith('/')) return item.filePath;
    return project?.cwd ? `${project.cwd.replace(/\/$/, '')}/${item.filePath}` : null;
  }, [item.filePath, project?.backendConnectionId, project?.cwd]);

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
            className={`t-text-btn${item.viewMode === 'source' ? ' is-active' : ''}`}
            onClick={() => updatePaneItem(item.id, { viewMode: item.viewMode === 'rendered' ? 'source' : 'rendered' })}
          >
            {item.viewMode === 'rendered' ? 'source' : 'preview'}
          </button>
        ) : null}
        <button type="button" className="t-icon-btn" onClick={() => setReloadKey((value) => value + 1)} aria-label="Reload file" title="Reload file"><RetryIcon size={14} /></button>
        {absolutePath ? <button type="button" className="t-icon-btn" onClick={openExternal} aria-label="Open externally" title="Open externally"><ExternalLinkIcon size={14} /></button> : null}
      </div>
      <div ref={contentScrollRef} className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 22px 28px', color: 'var(--term-fg)' }}>
        <SelectionActions
          containerRef={contentScrollRef}
          onQuote={handleQuote}
          onBranch={handleBranch}
          onComment={handleComment}
        />
        {state.phase === 'loading' ? <div style={{ color: 'var(--term-muted)', fontSize: 11 }}>loading {basename(item.filePath)}…</div> : null}
        {state.phase === 'error' ? <div style={{ color: 'var(--term-danger)', fontSize: 11 }}>⚠ {state.message}</div> : null}
        {state.phase === 'loaded' && isMarkdown && item.viewMode === 'rendered' ? (
          <MarkdownContent text={state.content} className={`prose prose-sm max-w-none wrap-break-word${isDark ? ' prose-invert' : ''}`} style={fileProseVars} />
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
