import type { ChatNodeState, Project } from '../../../state/chatTypes';

export interface HeaderCounts {
  chats: number;
  contexts: number;
  branches: number;
  lastActiveAt: number;
}

export type TreeRow =
  | { kind: 'label'; treeId: string; title: string; lastActiveAt: number }
  | { kind: 'root'; treeId: string; nodeId: string; node: ChatNodeState; branchCount: number; pinned: boolean }
  | { kind: 'branch'; treeId: string; nodeId: string; node: ChatNodeState; isLast: boolean }
  | { kind: 'overflow'; treeId: string; rootNodeId: string; count: number };

export interface DigestSummary {
  nodeId: string;
  title: string;
  excerpt: string;
  sourceCount: number;
  updatedAt: number;
}

const EXCERPT_LEN = 200;

function isLiveChatNode(node: ChatNodeState | undefined): boolean {
  return !!node && node.kind === 'chat' && !node.deletedAt;
}

export function deriveHeaderCounts(
  project: Project,
  nodes: Record<string, ChatNodeState>,
): HeaderCounts {
  const chats = project.chatIds.reduce((acc, id) => {
    const node = nodes[id];
    return acc + (isLiveChatNode(node) ? 1 : 0);
  }, 0);
  const contexts = project.contexts?.length ?? 0;
  const branches = project.edges.filter((e) => (e.kind ?? 'branch') === 'branch').length;
  const lastActiveAt = project.trees.reduce((acc, t) => Math.max(acc, t.lastActiveAt), 0);
  return { chats, contexts, branches, lastActiveAt };
}

export function deriveTreeRows(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  filter: string,
): TreeRow[] {
  if (project.trees.length === 0) return [];

  const childrenOf = new Map<string, string[]>();
  for (const edge of project.edges) {
    if ((edge.kind ?? 'branch') !== 'branch') continue;
    const list = childrenOf.get(edge.source) ?? [];
    list.push(edge.target);
    childrenOf.set(edge.source, list);
  }

  const norm = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  // Pinned threads sort to the top (most recently pinned first); the rest
  // sort by recent activity (lastActiveAt DESC), matching sidebar behavior.
  const orderedTrees = [...project.trees].sort((a, b) => {
    const ap = a.pinnedAt ?? 0;
    const bp = b.pinnedAt ?? 0;
    if (ap !== bp) return bp - ap;
    const aRecent = a.lastActiveAt ?? a.createdAt ?? 0;
    const bRecent = b.lastActiveAt ?? b.createdAt ?? 0;
    return bRecent - aRecent;
  });

  for (const tree of orderedTrees) {
    if (tree.archivedAt) continue;
    const rootNode = nodes[tree.rootNodeId];
    if (!rootNode || rootNode.deletedAt) continue;

    const directBranchIds = (childrenOf.get(tree.rootNodeId) ?? []).filter((id) => {
      const n = nodes[id];
      return n && !n.deletedAt && n.kind === 'chat';
    });

    let deeperCount = 0;
    for (const branchId of directBranchIds) {
      const grandKids = childrenOf.get(branchId) ?? [];
      for (const gid of grandKids) {
        const gn = nodes[gid];
        if (gn && !gn.deletedAt && gn.kind === 'chat') deeperCount += 1;
      }
    }
    if (deeperCount > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[WorkspaceManage] tree ${tree.id} has ${deeperCount} depth-2+ branches; rendering overflow row only`,
      );
    }

    if (norm) {
      const titles: string[] = [rootNode.title ?? ''];
      for (const id of directBranchIds) titles.push(nodes[id]?.title ?? '');
      const matched = titles.some((t) => t.toLowerCase().includes(norm));
      if (!matched) continue;
    }

    rows.push({
      kind: 'label',
      treeId: tree.id,
      title: (tree.name?.trim() || rootNode.title || 'Untitled') as string,
      lastActiveAt: tree.lastActiveAt,
    });
    rows.push({
      kind: 'root',
      treeId: tree.id,
      nodeId: rootNode.nodeId,
      node: rootNode,
      branchCount: directBranchIds.length,
      pinned: !!tree.pinnedAt,
    });
    directBranchIds.forEach((id, idx) => {
      const n = nodes[id]!;
      rows.push({
        kind: 'branch',
        treeId: tree.id,
        nodeId: id,
        node: n,
        isLast: idx === directBranchIds.length - 1,
      });
    });
    if (deeperCount > 0) {
      rows.push({
        kind: 'overflow',
        treeId: tree.id,
        rootNodeId: rootNode.nodeId,
        count: deeperCount,
      });
    }
  }
  return rows;
}

export function deriveArchivedTreeRows(
  project: Project,
  nodes: Record<string, ChatNodeState>,
  filter: string,
): TreeRow[] {
  if (project.trees.length === 0) return [];

  const norm = filter.trim().toLowerCase();
  const rows: TreeRow[] = [];

  const archivedTrees = [...project.trees]
    .filter((t) => !!t.archivedAt)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

  for (const tree of archivedTrees) {
    const rootNode = nodes[tree.rootNodeId];
    if (!rootNode || rootNode.deletedAt) continue;

    if (norm) {
      const title = (tree.name?.trim() || rootNode.title || '').toLowerCase();
      if (!title.includes(norm)) continue;
    }

    rows.push({
      kind: 'label',
      treeId: tree.id,
      title: (tree.name?.trim() || rootNode.title || 'Untitled') as string,
      lastActiveAt: tree.lastActiveAt,
    });
    rows.push({
      kind: 'root',
      treeId: tree.id,
      nodeId: rootNode.nodeId,
      node: rootNode,
      branchCount: 0,
      pinned: false,
    });
  }
  return rows;
}

export function deriveDigests(
  project: Project,
  nodes: Record<string, ChatNodeState>,
): DigestSummary[] {
  const out: DigestSummary[] = [];
  for (const id of project.chatIds) {
    const node = nodes[id];
    if (!node || node.deletedAt) continue;
    if (node.kind !== 'digest') continue;
    const digest = (
      node as ChatNodeState & {
        digest?: { content?: string; sourceCount?: number; generatedAt?: number };
      }
    ).digest;
    const content = digest?.content?.trim() ?? '';
    const excerpt = content.replace(/\s+/g, ' ').slice(0, EXCERPT_LEN);
    out.push({
      nodeId: id,
      title: node.title?.trim() || 'Untitled digest',
      excerpt,
      sourceCount: digest?.sourceCount ?? 0,
      updatedAt: digest?.generatedAt ?? 0,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function firstUserSnippet(node: ChatNodeState): string {
  const first = node.messages.find((m) => m.role === 'user');
  if (!first) return '';
  return first.text.replace(/\s+/g, ' ').trim();
}
