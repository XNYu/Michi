import { randomUUID } from 'node:crypto';
import { getDb, runInTransaction } from './db';
import { getWorkspace, listNodes, listEdges, listTrees, listMessages, saveMessage, saveTree, setNodeForkProvenance } from './dbRepository';
import type { MessageRow } from './dbRepository';

/** Validate and snapshot before changing either the graph or the transcript. */
export function planNodeExtraction(workspaceId: string, nodeId: string, userId?: string) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace || (process.env.MICHI_CLOUD === '1' && (!userId || workspace.owner_user_id !== userId))) {
    throw new Error('Workspace not found');
  }
  if (workspace.deleted_at || workspace.archived_at) throw new Error('Workspace is read-only');
  const nodes = listNodes(workspaceId);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const node = byId.get(nodeId);
  if (!node || node.deleted_at) throw new Error('Node not found');
  if (node.kind !== 'chat') throw new Error('Only chat nodes can be extracted');
  const trees = listTrees(workspaceId);
  const sourceTree = trees.find(tree => tree.id === node.tree_id);
  if (!sourceTree || sourceTree.archived_at) throw new Error('Thread is unavailable or archived');
  if (!node.parent_node_id || trees.some(tree => tree.root_node_id === nodeId)) {
    throw new Error('Node is already a thread root');
  }
  const edges = listEdges(workspaceId);
  const childrenByParent = new Map<string, typeof nodes>();
  for (const candidate of nodes) {
    if (!candidate.parent_node_id) continue;
    const children = childrenByParent.get(candidate.parent_node_id) ?? [];
    children.push(candidate);
    childrenByParent.set(candidate.parent_node_id, children);
  }
  const moving = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const parentId = stack.pop()!;
    for (const child of childrenByParent.get(parentId) ?? []) {
      // Parent pointers define ownership; merge/link/digest edges are references.
      if (moving.has(child.id)) continue;
      if (child.tree_id !== sourceTree.id) throw new Error('Inconsistent subtree ownership');
      moving.add(child.id);
      stack.push(child.id);
    }
  }
  const ancestors: string[] = [];
  const segments: MessageRow[][] = [];
  const visited = new Set([nodeId]);
  let child = node;
  while (child.parent_node_id) {
    const parent = byId.get(child.parent_node_id);
    if (!parent || parent.deleted_at || parent.tree_id !== sourceTree.id || visited.has(parent.id)) {
      throw new Error('Parent history is unavailable or inconsistent');
    }
    visited.add(parent.id);
    ancestors.push(parent.id);
    const edge = edges.find(e => e.kind === 'branch' && e.source_node_id === parent.id && e.target_node_id === child.id);
    if (!edge) throw new Error('Parent branch is unavailable');
    let messages = listMessages(parent.id);
    if (edge.anchor_message_id) {
      const anchor = messages.findIndex(message => message.id === edge.anchor_message_id);
      if (anchor < 0) throw new Error('Branch anchor is missing; parent history cannot be extracted safely');
      messages = messages.slice(0, anchor + 1);
    } else if (edge.created_at != null) {
      messages = messages.filter(message => message.created_at <= edge.created_at!);
    }
    segments.unshift(messages);
    child = parent;
  }
  if (child.id !== sourceTree.root_node_id) throw new Error('Parent chain does not reach the thread root');
  const affected = [...new Set([...ancestors, ...moving])];
  for (const id of affected) {
    if (byId.get(id)?.status === 'streaming'
      || getDb().prepare("SELECT 1 FROM turns WHERE node_id = ? AND status = 'active'").get(id)) {
      throw new Error('Wait for replies to finish before extracting this branch');
    }
  }
  return { node, moving, affected, history: segments.flat() };
}

/** One transaction retains existing message/turn IDs and copies ancestor rows
 * with new IDs, so deleting the old tree cannot remove the extracted history. */
export function extractNodeTree(workspaceId: string, nodeId: string, treeId: string, userId?: string) {
  return runInTransaction(() => {
    const workspace = getWorkspace(workspaceId);
    if (!workspace || (process.env.MICHI_CLOUD === '1' && (!userId || workspace.owner_user_id !== userId))) {
      throw new Error('Workspace not found');
    }
    const existing = listTrees(workspaceId).find(tree => tree.id === treeId);
    if (existing?.root_node_id === nodeId) {
      const root = listNodes(workspaceId).find(node => node.id === nodeId);
      return {
        tree: existing,
        nodeIds: listNodes(workspaceId).filter(n => n.tree_id === treeId).map(n => n.id),
        messages: listMessages(nodeId),
        forkedFromNodeId: root?.forked_from_node_id ?? null,
        inheritedMessageCount: root?.inherited_message_count ?? 0,
        forkBoundaryMessageId: root?.fork_boundary_message_id ?? null,
      };
    }
    if (getDb().prepare('SELECT 1 FROM trees WHERE id = ?').get(treeId)) throw new Error('Tree ID already exists');
    const plan = planNodeExtraction(workspaceId, nodeId, userId);
    const forkedFromNodeId = plan.node.parent_node_id ?? null;
    const db = getDb();
    const now = Date.now();
    const tree = { id: treeId, workspace_id: workspaceId, root_node_id: nodeId,
      name: plan.node.title ?? null, created_at: now, last_active_at: now };
    saveTree(tree);
    // Shift from the end to also support databases with a unique (node, seq) index.
    for (const message of listMessages(nodeId).reverse()) {
      db.prepare('UPDATE messages SET seq = ? WHERE id = ?').run(message.seq + plan.history.length, message.id);
    }
    let forkBoundaryMessageId: string | null = null;
    plan.history.forEach((message, seq) => {
      const id = `m-${randomUUID()}`;
      if (seq === plan.history.length - 1) forkBoundaryMessageId = id;
      saveMessage({ ...message, id, node_id: nodeId, seq, rev: null });
    });
    for (const id of plan.moving) db.prepare('UPDATE nodes SET tree_id = ? WHERE id = ?').run(treeId, id);
    // Links are tree-local. Merge and digest references may cross tree boundaries.
    for (const edge of listEdges(workspaceId)) {
      if (edge.kind === 'link' && plan.moving.has(edge.source_node_id) !== plan.moving.has(edge.target_node_id)) {
        db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);
      }
    }
    db.prepare(`UPDATE nodes SET parent_node_id = NULL, acp_session_id = NULL,
      external_session_id = NULL, resume_fingerprint = NULL WHERE id = ?`).run(nodeId);
    db.prepare("DELETE FROM edges WHERE workspace_id = ? AND target_node_id = ? AND kind = 'branch'").run(workspaceId, nodeId);
    db.prepare('UPDATE workspaces SET active_tree_id = ?, updated_at = ? WHERE id = ?').run(treeId, now, workspaceId);
    setNodeForkProvenance(nodeId, {
      forkedFromNodeId,
      forkBoundaryMessageId,
      inheritedMessageCount: plan.history.length,
    });
    return {
      tree: listTrees(workspaceId).find(t => t.id === treeId)!,
      nodeIds: [...plan.moving],
      messages: listMessages(nodeId),
      forkedFromNodeId,
      inheritedMessageCount: plan.history.length,
      forkBoundaryMessageId,
    };
  });
}
