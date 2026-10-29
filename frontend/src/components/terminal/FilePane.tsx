import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FilePaneItem, SourceLocation } from '../../state/paneItems';
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
import { usePaneViewState } from './PaneViewState';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';
import { createFileReadSnapshot, isFileFeedbackTargetValid, type FileFeedbackTarget, type FileReadSnapshot } from '../../state/fileFeedback';
import type { ChatNodeState } from '../../state/chatTypes';
import { findTreeIdForNode } from '../../state/tree';

const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type LoadState =
  | { phase: 'loading' }
  | {
      phase: 'loaded';
      content: string;
      imageMime?: string;
      size: number;
      modifiedAt: number;
      extension: string;
      resolvedFilePath: string;
      snapshot: FileReadSnapshot;
      sourceReferenceFallback?: boolean;
    }
  | { phase: 'error'; message: string };

interface CapturedFileSelection {
  source: QuoteSource;
  target: FileFeedbackTarget | null;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function isAbsoluteFilePath(filePath: string): boolean {
  const isUncPath = filePath.length >= 2 && filePath[0] === '\\' && filePath[1] === '\\';
  return filePath.startsWith('/') || isUncPath || /^[a-zA-Z]:[\\/]/.test(filePath);
}

function measuredLineHeight(element: HTMLElement): number | null {
  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const fontSize = Number.parseFloat(style.fontSize);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return style.lineHeight.trim().endsWith('px') ? lineHeight : lineHeight * fontSize;
  }
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : null;
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

function getSelectionSourceLabel(context: unknown): string | undefined {
  return (context as CapturedFileSelection | null)?.source.name;
}

export default function FilePane({ item }: { item: FilePaneItem }) {
  const { projects } = useChatProjects();
  const { focusPane, setFocusedNodeId, updatePaneItem, createChildChat, addPendingComment, setComposerDraft } = useChatActions();
  // Keep destination choices current when threads are deleted or archived.
  useChatStore();
  const nodeStore = useContext(ChatNodeStoreContext)!;
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const shellStyle = usePaneShellStyle(item.id);
  const { prefs } = usePrefs();
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const loadRef = useRef<{ key: string; promise: Promise<LoadState> } | null>(null);
  const diskStateRef = useRef(item.diskState);
  diskStateRef.current = item.diskState;
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const viewState = usePaneViewState();
  const feedbackDraftKey = JSON.stringify([project?.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID, item.projectId, item.treeId, item.filePath, item.sourceReferencePath ?? null]);
  const viewIdentity = JSON.stringify([item.createdAt, item.projectId, item.treeId, project?.backendConnectionId ?? null, item.filePath, item.sourceReferencePath ?? null, item.viewMode]);
  const sourcePreRef = useRef<HTMLPreElement>(null);
  /** Track the exact source-location request already handled. A reopened link
   *  receives a new object even when it targets the same line. */
  const scrolledToRef = useRef<SourceLocation | undefined>(undefined);
  const resolvedFilePath = state.phase === 'loaded'
    ? state.resolvedFilePath
    : item.sourceReferencePath ?? item.filePath;
  const sourceLocation = item.sourceReferencePath
    ? state.phase === 'loaded' && state.sourceReferenceFallback ? item.sourceLocation : undefined
    : item.sourceLocation;

  const getTargetNodes = useCallback(() => {
    const nodes: Record<string, ChatNodeState> = {};
    for (const candidate of projects) {
      for (const id of candidate.chatIds) {
        const node = nodeStore.getNode(id);
        if (node) nodes[id] = node;
      }
    }
    return nodes;
  }, [projects, nodeStore]);

  const captureSelectionContext = useCallback((text: string, range: Range): CapturedFileSelection | null => {
    if (state.phase !== 'loaded') return null;
    const offsets = contentScrollRef.current
      ? rangeToOffsets(range, contentScrollRef.current, state.content) : null;
    // A rendered Markdown selection may not map back to raw Markdown. Keep
    // the exact passage and version without inventing positions in that case.
    const selector: TextSelector = offsets
      ? computeTextSelector(state.content, offsets.startOffset, offsets.endOffset)
      : { exact: text };
    const target: FileFeedbackTarget | null = item.originChatNodeId && state.snapshot.treeId ? {
      backendConnectionId: state.snapshot.backendConnectionId,
      projectId: state.snapshot.projectId,
      treeId: state.snapshot.treeId,
      nodeId: item.originChatNodeId,
    } : null;
    setFeedbackError(null);
    return {
      source: { type: 'artifact', name: basename(state.resolvedFilePath), filePath: state.resolvedFilePath, selector, snapshot: state.snapshot },
      target: target && isFileFeedbackTargetValid(target, projects, getTargetNodes()) ? target : null,
    };
  }, [state, item.originChatNodeId, item.projectId, item.treeId, projects, getTargetNodes]);

  const validatedSelection = useCallback((context: unknown): CapturedFileSelection | null => {
    const selection = context as CapturedFileSelection | null;
    if (!selection?.source.snapshot || !selection.target
      || selection.source.snapshot.projectId !== selection.target.projectId
      || selection.source.snapshot.backendConnectionId !== selection.target.backendConnectionId
      || (selection.source.snapshot.treeId != null && selection.source.snapshot.treeId !== selection.target.treeId)
      || !isFileFeedbackTargetValid(selection.target, projects, getTargetNodes())) {
      setFeedbackError('Choose an available thread in this tree. Your text is kept.');
      return null;
    }
    setFeedbackError(null);
    return selection;
  }, [projects, getTargetNodes]);

  const handleQuote = useCallback(
    (text: string, _range?: Range, context?: unknown) => {
      const selection = validatedSelection(context);
      if (!selection?.target) return false;
      const targetId = selection.target.nodeId;
      const target = nodeStore.getNode(targetId);
      setComposerDraft(targetId, {
        value: target?.composerDraft?.value ?? '',
        mentions: target?.composerDraft?.mentions ?? [],
        quotedText: text,
        quoteSource: selection.source,
      });
      return true;
    },
    [validatedSelection, nodeStore, setComposerDraft],
  );

  const handleBranch = useCallback(
    (quoted: string, prompt: string, _anchorMessageId?: string, _range?: Range, context?: unknown) => {
      const selection = validatedSelection(context);
      if (!selection?.target) return false;
      void createChildChat(
        selection.target.nodeId,
        formatQuotedMessage(quoted, prompt, selection.source),
        { quotedText: quoted, displayText: prompt, quoteSource: selection.source },
      ).catch(() => {});
      return true;
    },
    [validatedSelection, createChildChat],
  );

  const handleComment = useCallback(
    (quoted: string, body: string, _range?: Range, context?: unknown) => {
      const selection = validatedSelection(context);
      if (!selection?.target) return false;
      const accepted = addPendingComment(selection.target.nodeId, quoted, body, selection.source, selection.target);
      if (accepted === false) setFeedbackError('That thread is no longer available. Your text is kept. Choose another thread.');
      return accepted;
    },
    [validatedSelection, addPendingComment],
  );

  const renderSelectionContext = useCallback((context: unknown, replace: (next: unknown) => void) => {
    const selection = context as CapturedFileSelection | null;
    if (!selection?.source.snapshot) return <div role="status">Select text after the file finishes loading.</div>;
    const snapshot = selection.source.snapshot;
    const nodes = getTargetNodes();
    const sourceProject = projects.find(candidate => candidate.id === snapshot.projectId);
    const options = Object.values(nodes).flatMap(node => {
      const treeId = snapshot.treeId ?? (sourceProject ? findTreeIdForNode(node.nodeId, sourceProject) : null);
      const target = treeId ? {
        backendConnectionId: snapshot.backendConnectionId, projectId: snapshot.projectId, treeId, nodeId: node.nodeId,
      } : null;
      return target && isFileFeedbackTargetValid(target, projects, nodes) ? [{ node, target }] : [];
    });
    const selectedAvailable = options.some(({ node }) => node.nodeId === selection.target?.nodeId);
    const previousVersion = state.phase !== 'loaded' || state.snapshot.contentHash !== snapshot.contentHash
      || state.snapshot.backendConnectionId !== snapshot.backendConnectionId;
    return (
      <div className="file-selection-context">
        <label className="file-selection-target">
          <span>Send to</span>
          <span className="file-selection-picker">
            <select aria-label="File feedback thread" value={selectedAvailable ? selection.target!.nodeId : ''}
              title={selectedAvailable ? nodes[selection.target!.nodeId].title || 'Untitled thread' : 'Choose a thread'}
              onChange={(event) => {
                const nodeId = event.target.value;
                setFeedbackError(null);
                replace({ ...selection, target: options.find(option => option.node.nodeId === nodeId)?.target ?? null });
              }}>
              <option value="">Choose a thread</option>
              {options.map(({node}) => <option key={node.nodeId} value={node.nodeId}>{node.title || 'Untitled thread'}</option>)}
            </select>
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg>
          </span>
        </label>
        {previousVersion && <span role="status">File changed since this selection.</span>}
        {feedbackError ? <span role="status">{feedbackError}</span> : null}
      </div>
    );
  }, [feedbackError, getTargetNodes, projects, state]);

  useEffect(() => {
    let active = true;
    // A reload can reuse DOM text nodes. Remove the native range before
    // replacing their text, while SelectionActions keeps an open comment's
    // captured passage and version independently.
    const nativeSelection = window.getSelection();
    if (nativeSelection?.rangeCount && contentScrollRef.current?.contains(nativeSelection.getRangeAt(0).commonAncestorContainer)) {
      nativeSelection.removeAllRanges();
    }
    setState({ phase: 'loading' });
    const backendConnectionId = project?.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID;
    const key = JSON.stringify([backendConnectionId, item.projectId, item.treeId, item.filePath, item.sourceReferencePath, reloadKey]);
    const loadPath = async (targetPath: string): Promise<Extract<LoadState, { phase: 'loaded' }>> => {
      const electron = getElectron();
      if (!/\.(png|jpe?g|gif|webp)$/i.test(targetPath) && isAbsoluteFilePath(targetPath) && electron?.readFile && !project?.backendConnectionId) {
        const stat = await electron.statFile?.(targetPath);
        if (stat && stat.size > MAX_FILE_BYTES) {
          throw new Error(`File is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        }
        const result = await electron.readFile(targetPath);
        if (!result) throw new Error('File is not readable');
        const name = basename(targetPath);
        const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
        return {
          phase: 'loaded',
          content: result.content,
          size: result.size,
          modifiedAt: result.modifiedAt,
          extension,
          resolvedFilePath: targetPath,
          snapshot: await createFileReadSnapshot(result.content, {
            backendConnectionId, projectId: item.projectId, treeId: item.treeId, resolvedFilePath: targetPath, size: result.size, modifiedAt: result.modifiedAt,
          }),
        };
      }
      const result = await fetchArtifactContent(item.projectId, targetPath, true);
      return {
        phase: 'loaded',
        content: result.content,
        imageMime: result.imageMime,
        size: result.size,
        modifiedAt: result.modifiedAt,
        extension: result.extension.toLowerCase(),
        resolvedFilePath: targetPath,
        snapshot: await createFileReadSnapshot(result.content, {
          backendConnectionId, projectId: item.projectId, treeId: item.treeId, resolvedFilePath: targetPath, size: result.size, modifiedAt: result.modifiedAt,
        }),
      };
    };
    const load = async (): Promise<LoadState> => {
      try {
        if (item.sourceReferencePath) {
          try {
            return await loadPath(item.sourceReferencePath);
          } catch {
            return {
              ...await loadPath(item.filePath),
              sourceReferenceFallback: true,
            };
          }
        }
        return await loadPath(item.filePath);
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
  }, [item.filePath, item.id, item.projectId, item.treeId, item.sourceReferencePath, project?.backendConnectionId, reloadKey, updatePaneItem]);

  // Dashboard navigation may unmount this view. Retain only the reading
  // position; reopen the file normally and restore after the same revision loads.
  useLayoutEffect(() => {
    if (state.phase !== 'loaded' || !viewState) return;
    const container = contentScrollRef.current;
    if (!container) return;
    const saved = viewState.read(item, viewIdentity);
    if (saved && saved.resolvedFilePath === state.resolvedFilePath
      && saved.modifiedAt === state.modifiedAt && saved.size === state.size
      && saved.sourceLocation === sourceLocation) {
      container.scrollTop = saved.scrollTop;
      container.scrollLeft = saved.scrollLeft;
      scrolledToRef.current = sourceLocation;
    }
    const save = () => viewState.write(item, viewIdentity, {
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      resolvedFilePath: state.resolvedFilePath,
      modifiedAt: state.modifiedAt,
      size: state.size,
      sourceLocation,
    });
    container.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      container.removeEventListener('scroll', save);
    };
  }, [item, sourceLocation, state, viewIdentity, viewState]);

  // Scroll to the requested source line once per navigation request without
  // creating one DOM element per line.
  useEffect(() => {
    if (state.phase !== 'loaded' || item.viewMode !== 'source') {
      scrolledToRef.current = undefined;
      return;
    }
    const loc = sourceLocation;
    if (!loc) {
      scrolledToRef.current = undefined;
      return;
    }
    if (scrolledToRef.current === loc) return;

    const container = contentScrollRef.current;
    const pre = sourcePreRef.current;
    if (!container || !pre) return;

    let lineCount = 1;
    for (let index = state.content.indexOf('\n'); index >= 0; index = state.content.indexOf('\n', index + 1)) {
      lineCount += 1;
    }
    const targetLine = Math.min(loc.line, lineCount);
    const lineHeight = measuredLineHeight(pre);
    if (!lineHeight) return;
    const preTop = pre.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      + container.scrollTop;
    const targetTop = preTop + (targetLine - 1) * lineHeight;
    container.scrollTop = Math.max(0, targetTop - Math.max(0, (container.clientHeight - lineHeight) / 2));
    scrolledToRef.current = loc;
  }, [item.viewMode, sourceLocation, state]);

  const extension = state.phase === 'loaded'
    ? state.extension
    : (basename(item.filePath).split('.').pop()?.toLowerCase() ?? '');
  const isMarkdown = MARKDOWN_EXTS.has(extension);
  const absolutePath = useMemo(() => {
    if (project?.backendConnectionId) return null;
    if (isAbsoluteFilePath(resolvedFilePath)) return resolvedFilePath;
    return project?.cwd ? `${project.cwd.replace(/\/$/, '')}/${resolvedFilePath}` : null;
  }, [resolvedFilePath, project?.backendConnectionId, project?.cwd]);

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
        <span title={resolvedFilePath} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-md)', color: 'var(--term-mid)' }}>
          {resolvedFilePath}{sourceLocation ? `:${sourceLocation.line}${sourceLocation.column != null ? `:${sourceLocation.column}` : ''}` : ''}
        </span>
        {state.phase === 'loaded' && state.sourceReferenceFallback ? (
          <span title="The literal link path was unreadable; opened as a source reference" style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>
            source reference
          </span>
        ) : null}
        {item.diskState === 'changed' ? (
          <button type="button" onClick={() => setReloadKey((value) => value + 1)} style={{ border: '1px solid var(--term-accent)', background: 'transparent', color: 'var(--term-accent)', padding: '2px 7px', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)', cursor: 'pointer', whiteSpace: 'nowrap' }}>● Changed on disk · refresh</button>
        ) : null}
        {item.diskState === 'removed' ? <span style={{ color: 'var(--term-danger)', fontSize: 'var(--fs-xs)' }}>⚠ Deleted on disk</span> : null}
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
          key={feedbackDraftKey}
          selectionDraftKey={feedbackDraftKey}
          containerRef={contentScrollRef}
          onQuote={handleQuote}
          onBranch={handleBranch}
          onComment={handleComment}
          captureSelectionContext={captureSelectionContext}
          renderSelectionContext={renderSelectionContext}
          getSelectionSourceLabel={getSelectionSourceLabel}
        />
        {state.phase === 'loading' ? <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>loading {basename(item.filePath)}…</div> : null}
        {state.phase === 'error' ? <div style={{ color: 'var(--term-danger)', fontSize: 'var(--fs-sm)' }}>⚠ {state.message}</div> : null}
        {state.phase === 'loaded' && isMarkdown && item.viewMode === 'rendered' ? (
          <MarkdownContent text={state.content} className={`prose prose-sm max-w-none wrap-break-word${isDark ? ' prose-invert' : ''}`} style={fileProseVars} />
        ) : null}
        {state.phase === 'loaded' && state.imageMime ? (
          <img src={state.content} alt={basename(resolvedFilePath)} style={{ maxWidth: '100%', height: 'auto', objectFit: 'contain' }} />
        ) : null}
        {state.phase === 'loaded' && !state.imageMime && (!isMarkdown || item.viewMode === 'source') ? (
          // eslint-disable-next-line no-restricted-syntax -- = --fs-md; measuredLineHeight reads it back from computed style
          <pre ref={sourcePreRef} style={{ margin: 0, minWidth: 'max-content', whiteSpace: 'pre', fontFamily: 'var(--message-code-font, monospace)', fontSize: 12, lineHeight: 1.6, color: 'var(--term-mid)', tabSize: 2 }}>
            {state.content}
          </pre>
        ) : null}
      </div>
      {state.phase === 'loaded' ? (
        <div style={{ height: 24, padding: '0 12px', borderTop: '1px solid var(--term-line)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
          <span>{basename(resolvedFilePath)}</span>
          <span>{state.size < 1024 ? `${state.size} B` : `${(state.size / 1024).toFixed(1)} KB`}</span>
          <span>{new Date(state.modifiedAt).toLocaleTimeString()}</span>
        </div>
      ) : null}
    </div>
  );
}
