import React, { useState } from 'react';
import { useChatStore, useChatNodesSnapshot } from '../../state/chatStore';
import {
  estimateMergePreambleTokens,
  MERGE_PREAMBLE_TOKEN_WARN,
} from '../../state/mergePreamble';

export default function MergeBanner({ nodeId }: { nodeId: string }) {
  const { activeProject } = useChatStore();
  const nodes = useChatNodesSnapshot();
  const [dismissed, setDismissed] = useState(false);

  const node = nodes[nodeId];
  if (!node || !node.mergeSources || node.mergeSources.length === 0) return null;
  if (node.messages.length > 0) return null;
  if (dismissed) return null;
  if (!activeProject) return null;

  const isAlive = (id: string) => !nodes[id]?.deletedAt;
  const tokens = estimateMergePreambleTokens(
    node.mergeSources,
    nodes,
    activeProject.edges,
    isAlive,
  );
  if (tokens <= MERGE_PREAMBLE_TOKEN_WARN) return null;

  const sourceTitles = node.mergeSources
    .map((s) => nodes[s]?.title ?? 'Untitled')
    .join(' + ');

  return (
    <div
      role="alert"
      style={{
        padding: '8px 12px',
        background: 'var(--term-alt)',
        borderBottom: '1px solid var(--term-line)',
        color: 'var(--term-fg)',
        fontSize: 11,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span>⚠</span>
      <span style={{ flex: 1 }}>
        Merging from {sourceTitles}. Will inject ~{tokens.toLocaleString()} tokens. May exceed model context.
      </span>
      <button
        role="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          cursor: 'pointer',
          color: 'var(--term-muted)',
          background: 'none',
          border: 'none',
          padding: '0 2px',
          font: 'inherit',
          fontSize: 11,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
