import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { saveNode, saveTree } from '../dbRepository';
import { PageWriteError, invalidatePages, pagesTransaction } from './core';
import { pageRecord } from './repository';

export interface PageHelperDescriptor {
  workspaceId: string;
  treeId: string;
  nodeId: string;
}

function currentHelper(pageId: string): PageHelperDescriptor | null {
  const row = getDb().prepare(`
    SELECT p.workspace_id, n.tree_id, n.id AS node_id
      FROM pages p JOIN nodes n ON n.id=p.helper_node_id
      JOIN trees t ON t.id=n.tree_id AND t.workspace_id=p.workspace_id
     WHERE p.id=? AND p.deleted_at IS NULL AND n.page_id=p.id
       AND n.deleted_at IS NULL AND n.purged_at IS NULL AND n.status!='archived'
       AND t.archived_at IS NULL
  `).get(pageId) as { workspace_id: string; tree_id: string; node_id: string } | undefined;
  return row ? { workspaceId: row.workspace_id, treeId: row.tree_id, nodeId: row.node_id } : null;
}

function activeHelperForPage(pageId: string): PageHelperDescriptor | null {
  const row = getDb().prepare(`
    SELECT p.workspace_id, n.tree_id, n.id AS node_id
      FROM pages p JOIN nodes n ON n.page_id=p.id
      JOIN trees t ON t.id=n.tree_id AND t.workspace_id=p.workspace_id
     WHERE p.id=? AND p.deleted_at IS NULL AND n.deleted_at IS NULL
       AND n.purged_at IS NULL AND n.status!='archived' AND t.archived_at IS NULL
  `).get(pageId) as { workspace_id: string; tree_id: string; node_id: string } | undefined;
  return row ? { workspaceId: row.workspace_id, treeId: row.tree_id, nodeId: row.node_id } : null;
}

/** Return the page's active helper, creating one ordinary chat in its workspace when needed. */
export function ensurePageHelper(pageId: string, ownerUserId: string, now = Date.now()): PageHelperDescriptor {
  try { return pagesTransaction(() => {
    const page = pageRecord(pageId, ownerUserId, { write: true });
    // A helper chat would be created in the home page's workspace, which for the Spaces Home is the system workspace.
    if (page.role !== null) throw new PageWriteError(409, 'invalid', 'Home pages are edited through the Meta agent, not a page helper');
    const existing = currentHelper(pageId);
    if (existing) return existing;

    // Recover a valid node binding if a stale page snapshot cleared only the
    // pointer. The node column is server-owned and protected by the active
    // helper unique index.
    const orphaned = activeHelperForPage(pageId);
    if (orphaned) {
      getDb().prepare('UPDATE pages SET helper_node_id=? WHERE id=? AND deleted_at IS NULL').run(orphaned.nodeId, pageId);
      invalidatePages([pageId], now, 'user');
      return orphaned;
    }

    // Clear only stale pointers left by a separately deleted/archived helper.
    // Its chat history and tree remain under their existing lifecycle policy.
    if (page.helper_node_id !== null) {
      getDb().prepare('UPDATE nodes SET page_id=NULL WHERE id=? AND page_id=?').run(page.helper_node_id, pageId);
      getDb().prepare('UPDATE pages SET helper_node_id=NULL WHERE id=? AND helper_node_id=?').run(pageId, page.helper_node_id);
      invalidatePages([pageId], now, 'user');
    }
    // Also discard any node-side binding whose tree/node was independently
    // archived or otherwise invalid, freeing the partial unique index.
    getDb().prepare(`UPDATE nodes SET page_id=NULL WHERE page_id=? AND
      (deleted_at IS NOT NULL OR purged_at IS NOT NULL OR status='archived' OR tree_id IS NULL OR
       NOT EXISTS (SELECT 1 FROM trees t WHERE t.id=nodes.tree_id AND t.workspace_id=nodes.workspace_id AND t.archived_at IS NULL))`).run(pageId);

    const nodeId = `n-${randomUUID()}`;
    const treeId = `tree-${randomUUID()}`;
    saveTree({ id: treeId, workspace_id: page.workspace_id, root_node_id: nodeId,
      last_active_at: now, created_at: now }, ownerUserId);
    saveNode({ id: nodeId, workspace_id: page.workspace_id, tree_id: treeId,
      kind: 'chat', title: `Assistant · ${page.title}`, status: 'idle', minimized: 0,
      spawned_by_agent: 0, created_at: now }, ownerUserId);
    getDb().prepare('UPDATE nodes SET page_id=? WHERE id=? AND deleted_at IS NULL AND purged_at IS NULL').run(pageId, nodeId);
    getDb().prepare('UPDATE pages SET helper_node_id=? WHERE id=? AND deleted_at IS NULL').run(nodeId, pageId);
    invalidatePages([pageId], now, 'user');
    return { workspaceId: page.workspace_id, treeId, nodeId };
  }); } catch (error) {
    // The unique active-helper index is the cross-request/process race guard.
    // If another transaction committed the winner, return it after our
    // savepoint rolls back the losing tree/node inserts.
    if (error instanceof Error && /UNIQUE constraint failed: nodes\.page_id/.test(error.message)) {
      pageRecord(pageId, ownerUserId, { write: true });
      const winner = currentHelper(pageId);
      if (winner) return winner;
    }
    throw error;
  }
}

/** Promote the current helper to an ordinary chat while preserving its tree and history. */
export function promotePageHelper(pageId: string, ownerUserId: string, now = Date.now()): PageHelperDescriptor {
  return pagesTransaction(() => {
    const page = pageRecord(pageId, ownerUserId, { write: true });
    const descriptor = currentHelper(pageId);
    if (!descriptor) throw new PageWriteError(404, 'not_found', 'Page helper not found');
    getDb().prepare('UPDATE nodes SET page_id=NULL WHERE id=? AND page_id=?').run(descriptor.nodeId, pageId);
    getDb().prepare('UPDATE pages SET helper_node_id=NULL WHERE id=? AND helper_node_id=?').run(pageId, descriptor.nodeId);
    invalidatePages([pageId], now, 'user');
    return descriptor;
  });
}
