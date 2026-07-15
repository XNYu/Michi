import express from 'express';
import { log } from '../services/logger';
import { getDb, runInTransaction } from '../services/db';
import {
  listWorkspaces, getWorkspace, saveWorkspace, deleteWorkspace,
  listTrees, saveTree, listNodes, saveNode, updateNodeTitle,
  listEdges, saveEdge, listMessages, saveMessage, getMessageCount,
  listContexts, saveContext, loadFullWorkspace, loadAllWorkspaces,
  deleteEdge, deleteTree, moveTreeToWorkspace, softDeleteNode, restoreNode, deleteContext,
  getAiGlobalContext, setAiGlobalContext,
  emptyWorkspaceTrash, purgeWorkspaceNodes,
  trimNode, restoreTrimmedNode,
  syncWorkspaceState, syncWorkspaceDelta, SyncResult,
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
      legacySyncAccepted: process.env.MICHI_LEGACY_SYNC_ACCEPTED !== '0',
    });
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

  // Bulk-load all workspaces in a single request
  router.get('/workspaces/all', (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const data = loadAllWorkspaces(userId);
      res.json({ workspaces: data });
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

  // Bulk sync workspace state from frontend.
  //
  // Cloud-mode INSERT semantics: sync is the *only* write path the frontend
  // exercises today (PUT /workspaces/:id is unused). When the row doesn't
  // exist yet — typical for a freshly created workspace — we must let the
  // request through and stamp owner_user_id from req.user.id below. Otherwise
  // requireWorkspaceOwner would 404 the very first sync, leaving the row
  // unwritten forever and breaking downstream /uploads, /chats,
  // /ensure-session for that workspace.
  router.post('/workspaces/:id/sync', (req, res, next) => {
    if (process.env.MICHI_CLOUD === '1') {
      const existing = getWorkspace(req.params.id);
      if (existing) return requireWorkspaceOwner(req, res, next);
    }
    next();
  }, (req, res) => {
    try {
      const workspaceId = req.params.id;
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      if (process.env.MICHI_LEGACY_SYNC_ACCEPTED === '0') {
        return res.status(410).json({ error: 'legacy_workspace_sync_disabled', reloadRequired: true });
      }
      const existingWorkspace = getWorkspace(workspaceId, userId);
      if ((existingWorkspace?.persistence_version ?? 1) >= 2) {
        return res.status(409).json({
          error: 'persistence_v2_reload_required',
          reloadRequired: true,
          protocolVersion: 2,
        });
      }
      log.warn('workspace', 'legacy sync accepted', { id: workspaceId, deprecated: true });

      // Two write shapes on the same endpoint, routed by `mode`:
      //   - mode === 'delta' → incremental: apply upserts + explicit deletes
      //     + per-dirty-node message reconcile (syncWorkspaceDelta).
      //   - anything else (absent / 'full') → full-snapshot reconcile
      //     (syncWorkspaceState): upsert payload rows, then delete only rows
      //     present in the DB but absent from the payload.
      // Both own the workspace-tombstone short-circuit (anti-revival) and
      // return { tombstoned: true } when the workspace is tombstoned, so we
      // report the no-op without resurrecting anything. On a live workspace
      // they return the bumped newRev + any stale-write conflicts.
      //
      // Kill switch: set MICHI_SYNC_CONFLICTS=0 to disable L2 optimistic-
      // concurrency rejection and fall back to L1b accept-all behaviour.
      // Rev is still bumped and stamped, so re-enabling is seamless.
      let result: SyncResult;
      if (req.body.mode === 'delta') {
        const { workspace, upserts, deletes, messageReconcileNodeIds, baseRevs } = req.body;
        result = syncWorkspaceDelta(
          workspaceId,
          { workspace, upserts, deletes, messageReconcileNodeIds, baseRevs },
          userId,
        );
      } else {
        const { workspace, trees, nodes, edges, messages, contexts, baseRevs, baseSyncRev } = req.body;
        result = syncWorkspaceState(
          workspaceId,
          { workspace, trees, nodes, edges, messages, contexts, baseRevs, baseSyncRev },
          userId,
        );
      }
      if (result.tombstoned) {
        return res.json({ ok: true, ignored: 'workspace tombstoned' });
      }
      // Server-authoritative rev + any rejected (stale) rows so the client can
      // advance its local revs and resolve conflicts. See sync L2 design.
      res.json({ ok: true, newRev: result.newRev, conflicts: result.conflicts });
    } catch (err) {
      log.error('workspace', 'sync failed', {
        id: req.params.id,
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
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

  // One-time localStorage migration
  // One-time localStorage migration — desktop-only in practice.
  // In cloud mode, stamp owner_user_id so migrated workspaces are visible.
  router.post('/migrate', (req, res) => {
    try {
      const { version, projects, nodes: frontendNodes } = req.body;
      if (!projects || !Array.isArray(projects)) {
        return res.status(400).json({ error: 'Invalid migration data' });
      }
      const migrateUserId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      let workspaceCount = 0;
      let nodeCount = 0;
      let messageCount = 0;

      runInTransaction(() => {
        for (const project of projects) {
          const now = Date.now();
          saveWorkspace({
            id: project.id,
            name: project.name || 'Untitled',
            cwd: project.cwd ?? null,
            active_tree_id: project.activeTreeId ?? null,
            created_at: project.createdAt ?? now,
            updated_at: now,
            settings: null,
            owner_user_id: migrateUserId ?? null,
          });
          workspaceCount++;

          if (Array.isArray(project.trees)) {
            for (const tree of project.trees) {
              saveTree({
                id: tree.id,
                workspace_id: project.id,
                root_node_id: tree.rootNodeId,
                name: tree.name ?? null,
                archived_at: tree.archivedAt ?? null,
                last_active_at: tree.lastActiveAt ?? now,
                created_at: tree.createdAt ?? now,
              }, migrateUserId);
            }
          }

          if (Array.isArray(project.contexts)) {
            for (const ctx of project.contexts) {
              if (typeof ctx?.name !== 'string' || typeof ctx?.filePath !== 'string') continue;
              saveContext({
                id: ctx.id || `${project.id}-${ctx.name}`,
                workspace_id: project.id,
                name: ctx.name,
                file_path: ctx.filePath,
                size: typeof ctx.size === 'number' ? ctx.size : null,
                auto_inject: ctx.autoInject ? 1 : 0,
                source: ctx.source ?? 'user',
                created_at: ctx.createdAt ?? now,
                updated_at: ctx.updatedAt ?? now,
              }, migrateUserId);
            }
          }
        }

        // Nodes are stored flat in the frontend state
        if (frontendNodes && typeof frontendNodes === 'object') {
          for (const [nodeId, nodeData] of Object.entries(frontendNodes)) {
            const n = nodeData as any;
            saveNode({
              id: nodeId,
              workspace_id: n.workspaceId ?? n.projectId ?? '',
              tree_id: n.treeId ?? null,
              parent_node_id: n.parentNodeId ?? null,
              kind: n.kind ?? 'chat',
              title: n.title ?? null,
              branch_overview: n.branchOverview ?? null,
              status: n.status ?? 'idle',
              position_x: n.position?.x ?? null,
              position_y: n.position?.y ?? null,
              minimized: n.minimized ? 1 : 0,
              deleted_at: n.deletedAt ?? null,
              deletion_group_id: n.deletionGroupId ?? null,
              spawned_by_agent: n.spawnedByAgent ? 1 : 0,
              current_mode_id: n.currentModeId ?? null,
              pane_width: n.paneWidth ?? null,
              digest: n.digest ? JSON.stringify({ ...n.digest, status: 'idle', error: undefined }) : null,
              acp_session_id: n.chatId ?? null,
              runtime_id: n.runtimeId ?? null,
              provider_id: n.providerId ?? null,
              model_id: n.modelId ?? null,
              reasoning: n.reasoning ?? null,
              resume_fingerprint: n.resumeFingerprint ?? null,
              composer_draft: n.composerDraft ? JSON.stringify(n.composerDraft) : null,
              created_at: n.createdAt ?? Date.now(),
            }, migrateUserId);
            nodeCount++;

            if (Array.isArray(n.messages)) {
              for (let seq = 0; seq < n.messages.length; seq++) {
                saveMessage(normalizeIncomingMessageRow(n.messages[seq], nodeId, seq), migrateUserId);
                messageCount++;
              }
            }
          }
        }

        for (const project of projects) {
          if (!Array.isArray(project.edges)) continue;
          for (const edge of project.edges) {
            saveEdge({
              id: edge.id ?? `${edge.kind ?? 'branch'}-${edge.source}-${edge.target}`,
              workspace_id: project.id,
              source_node_id: edge.source,
              target_node_id: edge.target,
              kind: edge.kind ?? 'branch',
            }, migrateUserId);
          }
        }
      });
      res.json({ migrated: true, workspaceCount, nodeCount, messageCount });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── User preferences (survives port changes across restarts) ─────────────
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
