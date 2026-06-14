import express from 'express';
import { runInTransaction } from '../services/db';
import {
  loadFullWorkspace, loadAllWorkspaces, saveWorkspace, saveTree,
  saveNode, saveEdge, saveMessage, saveContext, deleteWorkspace,
  WorkspaceRow, TreeRow, NodeRow, EdgeRow, MessageRow, ContextRow,
} from '../services/dbRepository';
import { normalizeIncomingMessageRow } from '../services/messageSerialization';
import { requireWorkspaceOwner } from './middleware/ownership';

interface BackupPayload {
  version: number;
  exportedAt: number;
  app: string;
  workspaces: Array<{
    workspace: WorkspaceRow;
    trees: TreeRow[];
    nodes: NodeRow[];
    edges: EdgeRow[];
    messages: MessageRow[];
    contexts: ContextRow[];
  }>;
}

export function setupBackupRoutes(): express.Router {
  const router = express.Router();

  // Export all workspaces — in cloud mode, scoped to the authenticated user only.
  router.get('/backup/export', (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const workspaces = loadAllWorkspaces(userId);
      const payload: BackupPayload = {
        version: 1,
        exportedAt: Date.now(),
        app: 'michi',
        workspaces,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Export single workspace — already protected by requireWorkspaceOwner (P1.3).
  // Also pass userId for repo-layer defense in depth.
  router.get('/backup/export/:workspaceId', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const data = loadFullWorkspace(req.params.workspaceId, userId);
      if (!data) return res.status(404).json({ error: 'Workspace not found' });
      const payload: BackupPayload = {
        version: 1,
        exportedAt: Date.now(),
        app: 'michi',
        workspaces: [data],
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Import backup
  router.post('/backup/import', (req, res) => {
    try {
      const body = req.body as BackupPayload;
      if (!body || body.app !== 'michi') {
        return res.status(400).json({ error: 'Invalid backup file: missing or wrong app field' });
      }
      if (!body.version || body.version > 1) {
        return res.status(400).json({ error: 'Unsupported backup version' });
      }
      if (!Array.isArray(body.workspaces)) {
        return res.status(400).json({ error: 'Invalid backup: workspaces must be an array' });
      }

      const mode = (req.query.mode as string) || 'merge';
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      let workspaceCount = 0;

      runInTransaction(() => {
        for (const ws of body.workspaces) {
          if (mode === 'replace') {
            deleteWorkspace(ws.workspace.id, userId);
          }
          // In cloud mode, stamp owner_user_id for imported workspaces.
          const wsRow: WorkspaceRow = userId
            ? { ...ws.workspace, owner_user_id: userId }
            : ws.workspace;
          saveWorkspace(wsRow);
          workspaceCount++;
          for (const t of ws.trees) saveTree(t, userId);
          for (const n of ws.nodes) saveNode(n, userId);
          for (const e of ws.edges) saveEdge(e, userId);
          for (let i = 0; i < ws.messages.length; i++) {
            const m = ws.messages[i];
            saveMessage(normalizeIncomingMessageRow(m as unknown as Record<string, unknown>, m.node_id, i), userId);
          }
          for (const c of ws.contexts) saveContext(c, userId);
        }
      });
      res.json({ imported: true, workspaceCount });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
