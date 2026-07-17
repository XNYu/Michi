import express from 'express';
import { randomUUID } from 'node:crypto';
import { log } from '../services/logger';
import { getDb, runInTransaction } from '../services/db';
import {
  listWorkspaces, getWorkspace, saveWorkspace, deleteWorkspace,
  listTrees, saveTree, listNodes, saveNode, updateNodeTitle,
  listEdges, saveEdge, listMessages, saveMessage, getMessageCount,
  listContexts, saveContext, loadFullWorkspace, loadAllWorkspaces,
  loadAllWorkspacesMeta, loadTreeMessages,
  deleteEdge, deleteTree, moveTreeToWorkspace, softDeleteNode, restoreNode, deleteContext,
  getAiGlobalContext, setAiGlobalContext,
  emptyWorkspaceTrash, purgeWorkspaceNodes,
  trimNode, restoreTrimmedNode,
  WorkspaceRow,
} from '../services/dbRepository';
import { normalizeIncomingMessageRow } from '../services/messageSerialization';
import { requireWorkspaceOwner, requireNodeOwner } from './middleware/ownership';
import { ensureDurableGraphNode } from '../services/graphCommands';
import { applyWorkspaceCommands } from '../services/domainCommands';

export function setupPersistenceRoutes(): express.Router {
  const router = express.Router();

  router.get('/persistence/capabilities', (_req, res) => {
    res.json({
      protocolVersion: 2,
      authoritativeTurnPersistence: true,
      durableNodePrerequisite: true,
      explicitCommands: true,
      backgroundWorkspaceSync: false,
      legacySyncAccepted: false,
    });
  });

  // Backend-owned node identity allocation. This intentionally does not write
  // SQLite: an unused allocation is harmless, while the existing graph command
  // path remains authoritative for creating the node/tree/edge rows.
  router.post('/node-ids/allocate', (req, res) => {
    const rawCount = req.body?.count ?? 1;
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 100) {
      return res.status(400).json({ error: 'count must be an integer between 1 and 100' });
    }
    res.json({ nodeIds: Array.from({ length: rawCount }, () => `n-${randomUUID()}`) });
  });

  // List all workspaces (lightweight, no messages)
  router.get('/workspaces', (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const workspaces = listWorkspaces(userId);
      res.json({ workspaces });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Bulk-load all workspaces in a single request.
  //   ?meta=1 → structure + per-node message_count, NO message bodies (the
  //             lazy-load hydration payload; bodies come per-tree below).
  //   (default) → full snapshot including every message body (legacy path).
  router.get('/workspaces/all', (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const meta = req.query.meta === '1' || req.query.meta === 'true';
      const data = meta ? loadAllWorkspacesMeta(userId) : loadAllWorkspaces(userId);
      res.json({ workspaces: data });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Lazy-load: all message bodies for ONE tree. Fetched when a tree is
  // activated / opened and its nodes are still unloaded placeholders.
  router.get('/workspaces/:id/trees/:treeId/messages', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const messages = loadTreeMessages(req.params.id, req.params.treeId, userId);
      res.json({ messages });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get full workspace with all nested data
  router.get('/workspaces/:id', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const data = loadFullWorkspace(req.params.id, userId);
      if (!data) return res.status(404).json({ error: 'Workspace not found' });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Backend-first graph prerequisite. Creates only the workspace/tree/node
  // slice required by one chat-capable node; safe to retry with the same IDs.
  router.post('/workspaces/:id/graph/nodes/ensure', (req, res, next) => {
    if (process.env.MICHI_CLOUD === '1' && getWorkspace(req.params.id)) {
      return requireWorkspaceOwner(req, res, next);
    }
    next();
  }, (req, res) => {
    try {
      if (!req.body?.workspace || req.body.workspace.id !== req.params.id || !req.body?.node) {
        return res.status(400).json({ error: 'workspace and node are required and workspace.id must match the route' });
      }
      const result = ensureDurableGraphNode({
        ...req.body,
        ownerUserId: process.env.MICHI_CLOUD === '1' ? (req.user?.id ?? null) : null,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      const status = /not found/i.test(message) ? 404 : /must|different|same workspace|same tree/i.test(message) ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  router.post('/workspaces/:id/commands', (req, res, next) => {
    if (process.env.MICHI_CLOUD === '1' && getWorkspace(req.params.id)) {
      return requireWorkspaceOwner(req, res, next);
    }
    next();
  }, (req, res) => {
    try {
      const result = applyWorkspaceCommands(req.params.id, {
        operationId: String(req.body?.operationId ?? ''),
        commands: Array.isArray(req.body?.commands) ? req.body.commands : [],
        ownerUserId: process.env.MICHI_CLOUD === '1' ? (req.user?.id ?? null) : null,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      const status = /not found/i.test(message) ? 404 : /must|different|same workspace|same tree|reused/i.test(message) ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // Create or update workspace.
  // In cloud mode: on INSERT, stamp owner_user_id = req.user.id.
  //                on UPDATE, verify ownership via requireWorkspaceOwner
  //                           (middleware no-ops when row doesn't exist yet,
  //                            which is the create path).
  router.put('/workspaces/:id', (req, res, next) => {
    // For updates (row already exists) enforce ownership in cloud mode.
    // For inserts (new workspace) skip the check — we'll stamp the owner below.
    if (process.env.MICHI_CLOUD === '1') {
      const existing = getWorkspace(req.params.id);
      if (existing) {
        return requireWorkspaceOwner(req, res, next);
      }
    }
    next();
  }, (req, res) => {
    try {
      const existed = !!getWorkspace(req.params.id);
      const ws: WorkspaceRow = {
        id: req.params.id,
        name: req.body.name || 'Untitled',
        cwd: req.body.cwd ?? null,
        active_tree_id: req.body.active_tree_id ?? null,
        created_at: req.body.created_at ?? Date.now(),
        updated_at: Date.now(),
        settings: req.body.settings ? JSON.stringify(req.body.settings) : null,
        deleted_at: req.body.deleted_at ?? null,
        archived_at: req.body.archived_at ?? null,
        // In cloud mode, stamp owner on INSERT; COALESCE in saveWorkspace
        // preserves the existing owner on UPDATE so this null is fine there.
        owner_user_id: process.env.MICHI_CLOUD === '1' ? (req.user?.id ?? null) : null,
      };
      saveWorkspace(ws);
      log.info('workspace', existed ? 'updated' : 'created', { id: ws.id, name: ws.name, cwd: ws.cwd ?? undefined });
      res.json({ ok: true });
    } catch (err) {
      log.error('workspace', 'save failed', { id: req.params.id, err: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete workspace (cascade)
  router.delete('/workspaces/:id', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      deleteWorkspace(req.params.id, userId);
      log.info('workspace', 'deleted', { id: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('workspace', 'delete failed', { id: req.params.id, err: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Permanently empty a workspace's trash: physically delete every node with
  // deleted_at IS NOT NULL (along with their cascaded edges/messages and any
  // newly-orphaned trees). Returns the row count actually purged so the
  // frontend can show a confirmation and skip its own state update if zero.
  //
  // The frontend awaits this BEFORE clearing local state so an in-flight
  // POST /sync carrying the pre-purge snapshot cannot revive the nodes by
  // re-inserting them: with the rows physically gone server-side and the
  // sync pause-flag held until our local state catches up, no stale snapshot
  // can write them back in the same tab.
  router.post('/workspaces/:id/trash/empty', requireWorkspaceOwner, (req, res) => {
    try {
      const purged = emptyWorkspaceTrash(req.params.id);
      log.info('workspace', 'trash emptied', { id: req.params.id, purged });
      res.json({ ok: true, purged });
    } catch (err) {
      log.error('workspace', 'empty trash failed', {
        id: req.params.id, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Permanently purge a specific list of nodes from a workspace. Used by the
  // single-group "delete permanently" action in Trash. Body: { nodeIds: string[] }.
  // Same cascade behaviour as /trash/empty. Empty array is a no-op (200).
  router.delete('/workspaces/:id/nodes', requireWorkspaceOwner, (req, res) => {
    try {
      const nodeIds: string[] = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : [];
      if (nodeIds.length === 0) return res.json({ ok: true, purged: 0 });
      const purged = purgeWorkspaceNodes(req.params.id, nodeIds);
      log.info('workspace', 'nodes purged', { id: req.params.id, requested: nodeIds.length, purged });
      res.json({ ok: true, purged });
    } catch (err) {
      log.error('workspace', 'purge nodes failed', {
        id: req.params.id, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Move a tree (with its nodes and intra-tree edges) to another workspace.
  router.post('/trees/:treeId/move', (req, res) => {
    try {
      const { treeId } = req.params;
      const fromWorkspaceId = String(req.body?.fromWorkspaceId ?? '');
      const toWorkspaceId = String(req.body?.toWorkspaceId ?? '');
      if (!fromWorkspaceId || !toWorkspaceId) {
        return res.status(400).json({ error: 'fromWorkspaceId and toWorkspaceId required' });
      }
      // Cloud-mode: caller must own BOTH source and target workspaces.
      if (process.env.MICHI_CLOUD === '1') {
        const userId = req.user?.id;
        const src = getWorkspace(fromWorkspaceId);
        const dst = getWorkspace(toWorkspaceId);
        if (!src || src.owner_user_id !== userId) return res.status(404).json({ error: 'not_found' });
        if (!dst || dst.owner_user_id !== userId) return res.status(404).json({ error: 'not_found' });
      }
      if (fromWorkspaceId === toWorkspaceId) {
        return res.json({ ok: true, movedNodes: 0, movedEdges: 0, droppedEdges: 0 });
      }
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const result = moveTreeToWorkspace(treeId, fromWorkspaceId, toWorkspaceId, userId);
      log.info('tree', 'moved', { treeId, fromWorkspaceId, toWorkspaceId, ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = (err as Error).message;
      log.error('tree', 'move failed', { treeId: req.params.treeId, err: msg });
      res.status(/not found/.test(msg) ? 404 : 500).json({ error: msg });
    }
  });

  // Save a single message to a node
  router.post('/nodes/:nodeId/messages', requireNodeOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      saveMessage(normalizeIncomingMessageRow(
        req.body ?? {},
        req.params.nodeId,
        req.body.seq ?? getMessageCount(req.params.nodeId, userId),
      ), userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update node fields (title, position, etc.)
  router.patch('/nodes/:nodeId', requireNodeOwner, (req, res) => {
    try {
      const { title, position_x, position_y, status, minimized, pane_width } = req.body;
      const db = getDb();
      const sets: string[] = [];
      const params: any[] = [];
      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (position_x !== undefined) { sets.push('position_x = ?'); params.push(position_x); }
      if (position_y !== undefined) { sets.push('position_y = ?'); params.push(position_y); }
      if (status !== undefined) { sets.push('status = ?'); params.push(status); }
      if (minimized !== undefined) { sets.push('minimized = ?'); params.push(minimized); }
      if (pane_width !== undefined) { sets.push('pane_width = ?'); params.push(pane_width); }
      if (sets.length === 0) return res.json({ ok: true });
      params.push(req.params.nodeId);
      db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Single-node trim: send the node to trash AND reparent its children up.
  // Body { deletedAt: number, groupId: string } so the timestamp/group come
  // from the client (which is the source of truth for the trash UI). Returns
  // { trimmed: 1 } on success, { trimmed: 0 } if the node was not found in
  // the given workspace (e.g. already purged via a sibling tab).
  router.post('/workspaces/:id/nodes/:nodeId/trim', requireWorkspaceOwner, (req, res) => {
    try {
      const deletedAt = Number(req.body?.deletedAt);
      const groupId = String(req.body?.groupId ?? '');
      if (!Number.isFinite(deletedAt) || !groupId) {
        return res.status(400).json({ error: 'deletedAt (number) and groupId (string) required' });
      }
      const result = trimNode(req.params.id, req.params.nodeId, deletedAt, groupId);
      log.info('workspace', 'node trimmed', { workspaceId: req.params.id, nodeId: req.params.nodeId, ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error('workspace', 'node trim failed', {
        workspaceId: req.params.id, nodeId: req.params.nodeId, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Restore a previously-trimmed node. Returns { restored: false } if the
  // node has no trim_snapshot (caller should fall back to /restore for
  // subtree-deleted nodes — that path is handled in chatStore today and
  // doesn't need its own backend hook).
  router.post('/workspaces/:id/nodes/:nodeId/restore-trim', requireWorkspaceOwner, (req, res) => {
    try {
      const result = restoreTrimmedNode(req.params.id, req.params.nodeId);
      log.info('workspace', 'node trim restored', { workspaceId: req.params.id, nodeId: req.params.nodeId, ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error('workspace', 'node restore-trim failed', {
        workspaceId: req.params.id, nodeId: req.params.nodeId, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Per-workspace toggle: AI global context (list_threads / search_messages / read_node tools).
  // Stored inside workspaces.settings JSON. Default ON.
  router.get('/workspaces/:id/ai-global-context', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const enabled = getAiGlobalContext(req.params.id, userId);
      res.json({ enabled });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:id/ai-global-context', requireWorkspaceOwner, (req, res) => {
    const { id } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      setAiGlobalContext(id, enabled, userId);
      res.json({ ok: true, enabled });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── User preferences (persisted to ~/.michi/config.json) ────────────────
  router.get('/prefs', (req, res) => {
    try {
      const db = getDb();
      const row = db.prepare("SELECT value FROM meta WHERE key = 'user_prefs'").get() as { value: string } | undefined;
      if (!row) return res.json({ prefs: null });
      res.json({ prefs: JSON.parse(row.value) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/prefs', (req, res) => {
    try {
      const db = getDb();
      const json = JSON.stringify(req.body);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('user_prefs', ?)").run(json);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
