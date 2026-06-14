import React from 'react';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

interface Props {
  node: ChatNodeState;
  project: Project;
  nodes: Record<string, ChatNodeState>;
  onMenuClick: () => void;
  onBack: () => void;
  onNavigateNode: (id: string) => void;
  onBranchesClick: () => void;
}

/**
 * Top bar of the chat screen. Layout, left → right:
 *   ☰  ‹  parent ▸ current title …  ◀ 1/3 ▶  ⑂2
 *
 * Sibling nav and branch button only render when relevant. Tap on the parent
 * crumb jumps to the parent. Tap on the title is a no-op (you're already
 * looking at it).
 */
export default function ChatHeader({
  node,
  project,
  nodes,
  onMenuClick,
  onBack,
  onNavigateNode,
  onBranchesClick,
}: Props) {
  const parentId = node.parentNodeId;
  const parent = parentId ? nodes[parentId] : null;
  const title = node.title || firstUserText(node) || 'untitled';

  // Compute siblings: live children of the parent, in edge order.
  const siblings = React.useMemo(() => {
    if (!parentId) return [];
    return project.edges
      .filter((e) => (!e.kind || e.kind === 'branch') && e.source === parentId)
      .map((e) => e.target)
      .filter((id) => !nodes[id]?.deletedAt);
  }, [parentId, project.edges, nodes]);

  const sibIndex = siblings.indexOf(node.nodeId);
  const showSiblings = siblings.length > 1 && sibIndex >= 0;

  // Compute children count for the branch button.
  const childCount = React.useMemo(() => {
    return project.edges.filter(
      (e) =>
        (!e.kind || e.kind === 'branch')
        && e.source === node.nodeId
        && !nodes[e.target]?.deletedAt,
    ).length;
  }, [project.edges, node.nodeId, nodes]);

  const goSibling = (delta: number) => {
    if (!showSiblings) return;
    const next = (sibIndex + delta + siblings.length) % siblings.length;
    onNavigateNode(siblings[next]);
  };

  return (
    <div className="m-chat-header">
      <button onClick={onMenuClick} aria-label="Open structure" title="Structure">
        <span style={{ fontSize: 16 }}>☰</span>
      </button>
      <button onClick={onBack} aria-label="Back to threads" title="Back">
        <span style={{ fontSize: 18 }}>‹</span>
      </button>
      <div className="m-chat-crumb">
        {parent && (
          <>
            <span
              className="m-chat-crumb-parent"
              onClick={() => onNavigateNode(parent.nodeId)}
            >
              {parent.title || firstUserText(parent) || 'parent'}
            </span>
            <span className="m-chat-crumb-sep">›</span>
          </>
        )}
        <span className="m-chat-crumb-current">{title}</span>
        {node.status === 'streaming' && (
          <span style={{ marginLeft: 4, color: 'var(--term-accent)', fontSize: 12 }}>•</span>
        )}
      </div>
      {showSiblings && (
        <div className="m-sibling-nav">
          <button
            onClick={() => goSibling(-1)}
            aria-label="Previous sibling"
            style={{ padding: 4 }}
          >
            ◀
          </button>
          <span>
            {sibIndex + 1}/{siblings.length}
          </span>
          <button
            onClick={() => goSibling(1)}
            aria-label="Next sibling"
            style={{ padding: 4 }}
          >
            ▶
          </button>
        </div>
      )}
      {childCount > 0 && (
        <button
          className="m-branch-btn"
          onClick={onBranchesClick}
          aria-label={`${childCount} branches`}
        >
          ⑂ {childCount}
        </button>
      )}
    </div>
  );
}

function firstUserText(node: ChatNodeState): string | undefined {
  const m = node.messages.find((x) => x.role === 'user');
  if (!m) return undefined;
  return m.text.split('\n')[0].slice(0, 40);
}
