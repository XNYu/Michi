import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useChatStore, useChatNode, useChatActions, ChatNodeStoreContext } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import MarkdownContent from '../MarkdownContent';
import SelectionActions from '../SelectionActions';
import { fetchArtifactContent } from '../../services/api';
import { getElectron } from '../../lib/electronBridge';
import { formatQuotedMessage } from '../../lib/quoteFormat';

const PROSE_CLASSES =
  'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg) [&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) [&_a]:text-(--term-accent)';

/** Renderable extensions — show MarkdownContent for these; source view for everything else. */
const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

function Breadcrumb({ filePath }: { filePath: string }) {
  const parts = filePath.split('/');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--term-muted)',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minWidth: 0,
        flex: 1,
      }}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span style={{ color: 'var(--term-faint)', margin: '0 2px' }}>›</span>
          )}
          <span
            style={{
              color: i === parts.length - 1 ? 'var(--term-fg)' : undefined,
              fontWeight: i === parts.length - 1 ? 600 : undefined,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

export default function ArtifactPane({
  nodeId,
  contentMaxWidth,
}: {
  nodeId: string;
  contentMaxWidth?: number | null;
}) {
  const { activeProject, focusPane, setFocusedNodeId, focusedNodeId } = useChatStore();
  const { dispatch, createChildChat, addPendingComment, setComposerDraft } = useChatActions();
  const nodeStore = useContext(ChatNodeStoreContext)!;
  const n = useChatNode(nodeId);
  const paneShellStyle = usePaneShellStyle(nodeId);
  const contentScrollRef = useRef<HTMLDivElement>(null);

  // Track the last focused chat pane so selection actions route there even
  // while the artifact pane itself is focused (for reading).
  const lastFocusedChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedNodeId && focusedNodeId !== nodeId) {
      const target = nodeStore.getNode(focusedNodeId);
      if (target && target.kind === 'chat') {
        lastFocusedChatRef.current = focusedNodeId;
      }
    }
  }, [focusedNodeId, nodeId, nodeStore]);

  /** Resolve the target chat node for quote/comment/branch routing. */
  const getTargetChatNodeId = useCallback((): string | null => {
    // Prefer the currently focused node if it's a chat
    if (focusedNodeId && focusedNodeId !== nodeId) {
      const target = nodeStore.getNode(focusedNodeId);
      if (target && target.kind === 'chat') return focusedNodeId;
    }
    // Fall back to the last known focused chat pane
    return lastFocusedChatRef.current;
  }, [focusedNodeId, nodeId, nodeStore]);

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
        formatQuotedMessage(quoted, prompt),
        { quotedText: quoted, displayText: prompt },
      ).catch(() => {});
    },
    [getTargetChatNodeId, createChildChat],
  );

  const handleComment = useCallback(
    (quoted: string, body: string) => {
      const targetId = getTargetChatNodeId();
      if (!targetId) return;
      addPendingComment(targetId, quoted, body);
    },
    [getTargetChatNodeId, addPendingComment],
  );

  const artifact = n?.artifact;
  const filePath = artifact?.filePath ?? '';
  const workspaceId = activeProject?.id;

  // Fetch file content on mount (or when filePath changes)
  useEffect(() => {
    if (!artifact || !workspaceId || !filePath) return;
    // Only fetch once: skip if already loaded, currently loading, or previously errored
    if (artifact.content !== null || artifact.status === 'loading' || artifact.status === 'error') return;
    dispatch({ type: 'artifact-loading', nodeId });
    fetchArtifactContent(workspaceId, filePath)
      .then((result) => {
        dispatch({
          type: 'artifact-loaded',
          nodeId,
          content: result.content,
          basename: result.basename,
          extension: result.extension,
          size: result.size,
          modifiedAt: result.modifiedAt,
        });
      })
      .catch((err) => {
        dispatch({ type: 'artifact-error', nodeId, error: (err as Error).message });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, workspaceId, nodeId]);

  const toggleView = useCallback(() => {
    if (!artifact) return;
    dispatch({
      type: 'artifact-set-view',
      nodeId,
      viewMode: artifact.viewMode === 'rendered' ? 'source' : 'rendered',
    });
  }, [artifact, nodeId, dispatch]);

  const openInEditor = useCallback(() => {
    const electron = getElectron();
    if (!electron?.openPath || !activeProject?.cwd) return;
    const abs = filePath.startsWith('/')
      ? filePath
      : `${activeProject.cwd.replace(/\/$/, '')}/${filePath}`;
    void electron.openPath(abs);
  }, [filePath, activeProject?.cwd]);

  const isMarkdown = useMemo(
    () => MARKDOWN_EXTS.has(artifact?.extension ?? ''),
    [artifact?.extension],
  );

  if (!n || n.kind !== 'artifact' || !artifact) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 11,
        }}
      >
        — empty artifact pane —
      </div>
    );
  }

  const innerWrap: React.CSSProperties =
    contentMaxWidth != null
      ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto', width: '100%' }
      : { width: '100%' };

  return (
    <div
      data-node-id={nodeId}
      data-pane-kind="artifact"
      className="terminal-pane"
      onMouseDown={() => {
        focusPane(nodeId);
        setFocusedNodeId(nodeId);
      }}
      style={paneShellStyle}
    >
      {/* Header: breadcrumb + toolbar */}
      <div
        style={{
          padding: '6px 14px',
          background: 'var(--term-surface)',
          borderBottom: '1px solid var(--term-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          fontSize: 11,
        }}
      >
        {/* File icon */}
        <span style={{ color: 'var(--term-accent)', fontSize: 13 }}>📄</span>
        {/* Breadcrumb */}
        <Breadcrumb filePath={filePath} />
        {/* View source toggle */}
        {isMarkdown && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleView(); }}
            style={{
              padding: '2px 8px',
              border: '1px solid var(--term-line)',
              background: artifact.viewMode === 'source' ? 'var(--term-alt)' : 'transparent',
              color: 'var(--term-mid)',
              fontSize: 10,
              cursor: 'pointer',
              fontFamily: 'var(--ui-font)',
              whiteSpace: 'nowrap',
            }}
            title={artifact.viewMode === 'rendered' ? 'Show source' : 'Show rendered'}
          >
            {artifact.viewMode === 'rendered' ? 'View source' : 'Rendered'}
          </button>
        )}
        {/* Open in editor */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); openInEditor(); }}
          style={{
            padding: '2px 8px',
            border: '1px solid var(--term-line)',
            background: 'transparent',
            color: 'var(--term-mid)',
            fontSize: 10,
            cursor: 'pointer',
            fontFamily: 'var(--ui-font)',
            whiteSpace: 'nowrap',
          }}
          title="Open in external editor"
        >
          ↗ Open
        </button>
      </div>

      {/* Content area */}
      <div
        ref={contentScrollRef}
        className="term-scrollbar"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 22px 24px',
          color: 'var(--term-fg)',
          fontSize: 13,
          lineHeight: 1.7,
          position: 'relative',
        }}
      >
        <SelectionActions
          containerRef={contentScrollRef}
          onQuote={handleQuote}
          onBranch={handleBranch}
          onComment={handleComment}
        />
        <div style={innerWrap}>
          {artifact.status === 'loading' && (
            <div style={{ color: 'var(--term-muted)', fontSize: 12 }}>
              Loading {artifact.basename || filePath}…
            </div>
          )}

          {artifact.status === 'error' && (
            <div style={{ color: 'var(--term-error, #e53e3e)', fontSize: 12 }}>
              ⚠ {artifact.error || 'Failed to load file'}
            </div>
          )}

          {artifact.content !== null && artifact.status === 'idle' && (
            <>
              {isMarkdown && artifact.viewMode === 'rendered' ? (
                <MarkdownContent text={artifact.content} className={PROSE_CLASSES} />
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    fontFamily: 'var(--mono-font, ui-monospace, SFMono-Regular, monospace)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--term-mid)',
                    background: 'var(--term-alt)',
                    padding: '12px 14px',
                    border: '1px solid var(--term-line)',
                    borderRadius: 2,
                    overflow: 'auto',
                  }}
                >
                  {artifact.content}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Footer: file info */}
      {artifact.basename && (
        <div
          style={{
            padding: '4px 14px',
            borderTop: '1px solid var(--term-line)',
            fontSize: 10,
            color: 'var(--term-muted)',
            display: 'flex',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <span>{artifact.basename}</span>
          {artifact.size != null && (
            <span>{artifact.size < 1024 ? `${artifact.size} B` : `${(artifact.size / 1024).toFixed(1)} KB`}</span>
          )}
          {artifact.extension && <span>.{artifact.extension}</span>}
        </div>
      )}
    </div>
  );
}
