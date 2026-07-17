import React, { useMemo, useState } from 'react';
import { useChatStore, useChatNodesSnapshot } from '../../../state/chatStore';
import { resolveLeafForTree } from '../MobileShell';
import type { ChatNodeState, ProjectEdge, Tree } from '../../../state/chatTypes';

interface Props {
  onOpenThread: (nodeId: string) => void;
}

/**
 * Default landing page on mobile. Shows the current workspace's threads sorted
 * by lastActiveAt desc, with a search box and a "New thread" CTA at the bottom.
 *
 * Tapping a thread row resolves the most-recently-touched leaf and opens
 * ChatScreen at that node. The search field does prefix matching against the
 * tree's display name (root node title) and root user message; FTS5 search
 * lives in state/search.ts but isn't wired here yet — it requires the agent
 * search index, which is overkill for a thread filter.
 */
export default function ThreadsScreen({ onOpenThread }: Props) {
  const { activeProject, projects, createThread } = useChatStore();
  const nodes = useChatNodesSnapshot();
  const [query, setQuery] = useState('');

  const trees = useMemo<Tree[]>(() => {
    if (!activeProject) return [];
    return [...activeProject.trees]
      .filter((t) => !t.archivedAt && !nodes[t.rootNodeId]?.deletedAt)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [activeProject, nodes]);

  const filtered = useMemo(() => {
    if (!query.trim()) return trees;
    const q = query.toLowerCase();
    return trees.filter((t) => {
      const root = nodes[t.rootNodeId];
      const name = (t.name ?? root?.title ?? '').toLowerCase();
      const firstUser = root?.messages.find((m) => m.role === 'user')?.text ?? '';
      return name.includes(q) || firstUser.toLowerCase().includes(q);
    });
  }, [trees, nodes, query]);

  // Single-pass tree stats across the whole project. Doing one DFS per row
  // (the previous shape) was O(threads × edges) per snapshot tick — the
  // architect review flagged it as a streaming-time hotspot.
  const treeStats = useMemo(
    () => activeProject ? computeTreeStats(activeProject.edges, nodes, activeProject.trees.map((t) => t.rootNodeId)) : new Map<string, { streaming: boolean; nodeCount: number }>(),
    [activeProject?.edges, nodes, activeProject?.trees],
  );

  const handleNewThread = async () => {
    try {
      const newRootId = await createThread();
      if (newRootId) onOpenThread(newRootId);
    } catch {
      // The store already surfaced the allocation failure.
    }
  };

  const handleOpen = (tree: Tree) => {
    if (!activeProject) return;
    const target = resolveLeafForTree(tree.rootNodeId, activeProject.edges, nodes);
    onOpenThread(target);
  };

  if (!activeProject) {
    return (
      <div className="m-screen">
        <div className="m-screen-header">
          <span className="m-screen-title">Threads</span>
        </div>
        <div className="m-empty">
          <div className="m-empty-headline">No workspace selected</div>
          <div className="m-empty-sub">
            {projects.length === 0
              ? 'Create a workspace on desktop first — mobile only switches between existing ones.'
              : 'Tap the Spaces tab to pick a workspace.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="m-screen">
      <div className="m-workspace-bar">
        <div>
          <div className="m-workspace-bar-name">{activeProject.name}</div>
          <div className="m-workspace-bar-meta">
            {trees.length} thread{trees.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div style={{ padding: 12 }}>
        <input
          className="m-search-input"
          placeholder="Search threads…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="m-empty">
          <div className="m-empty-headline">
            {query.trim() ? 'No matches' : 'No threads yet'}
          </div>
          {!query.trim() && (
            <div className="m-empty-sub">Tap "New thread" below to start.</div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.map((t) => {
            const stats = treeStats.get(t.rootNodeId) ?? { streaming: false, nodeCount: 1 };
            return (
              <ThreadRow
                key={t.id}
                tree={t}
                root={nodes[t.rootNodeId]}
                streaming={stats.streaming}
                nodeCount={stats.nodeCount}
                onOpen={() => handleOpen(t)}
              />
            );
          })}
        </div>
      )}

      <div className="m-cta-bottom">
        <button onClick={handleNewThread}>＋ New thread</button>
      </div>
    </div>
  );
}

function ThreadRow({
  tree,
  root,
  streaming,
  nodeCount,
  onOpen,
}: {
  tree: Tree;
  root: ChatNodeState | undefined;
  streaming: boolean;
  nodeCount: number;
  onOpen: () => void;
}) {
  const name = tree.name ?? root?.title ?? 'untitled';
  const lastActive = useMemo(() => formatRelative(tree.lastActiveAt), [tree.lastActiveAt]);
  return (
    <div className="m-thread-row" onClick={onOpen}>
      <div className="m-thread-dot" data-streaming={streaming} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="m-thread-name">{name}</div>
        <div className="m-thread-meta">
          {nodeCount} node{nodeCount === 1 ? '' : 's'} · {lastActive}
        </div>
      </div>
      <span style={{ color: 'var(--term-faint)', fontSize: 14 }}>›</span>
    </div>
  );
}

/** One pass over the edges to compute, per tree root, whether any reachable
 *  node is streaming and how many live nodes the tree contains. */
function computeTreeStats(
  edges: readonly ProjectEdge[],
  nodes: Record<string, ChatNodeState>,
  roots: string[],
): Map<string, { streaming: boolean; nodeCount: number }> {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind && e.kind !== 'branch') continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  const out = new Map<string, { streaming: boolean; nodeCount: number }>();
  for (const root of roots) {
    let streaming = false;
    let nodeCount = 0;
    const visited = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const n = nodes[id];
      if (!n || n.deletedAt) continue;
      nodeCount++;
      if (n.status === 'streaming') streaming = true;
      const kids = childrenOf.get(id);
      if (kids) for (const c of kids) stack.push(c);
    }
    out.set(root, { streaming, nodeCount: Math.max(1, nodeCount) });
  }
  return out;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}
