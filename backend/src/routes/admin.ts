import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../services/db';
import { getMichiDataDir } from '../services/dataDir';
import { recordAudit } from '../services/audit';
import { listUserProviderKeys } from '../services/userKeys';
import {
  exportAgentRunBackup,
  portableBackupRelativePath,
  sanitizeAgentNodeForBackup,
  sanitizePortableBackupJson,
} from '../services/agentRunBackup';
import {
  AgentRunAdministrativeLifecycle,
  type AgentOwnerCleanupResult,
  type PreparedAgentOwnerDeletion,
} from '../services/agentRunAdministrativeLifecycle';

export interface AdminRouteDeps {
  agentRunLifecycle?: AgentRunAdministrativeLifecycle;
}

export function setupAdminRoutes(deps: AdminRouteDeps = {}): Router {
const router = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

function getAuthDb(): DatabaseSync {
  const dbPath = path.join(getMichiDataDir(), 'auth.sqlite');
  // Open read-write (auth DB is always present when REQUIRE_AUTH is active).
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

function actorFromReq(req: any): { id: string | null; email: string | null } {
  return {
    id: req.user?.id ?? null,
    email: req.user?.email ?? null,
  };
}

function ipFromReq(req: any): string | null {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null;
}

function uaFromReq(req: any): string | null {
  return (req.headers['user-agent'] as string | undefined) ?? null;
}

function portableWorkspaceRow(row: Record<string, unknown>): Record<string, unknown> {
  let folders: unknown = null;
  if (typeof row.folders === 'string') {
    try {
      const parsed = JSON.parse(row.folders);
      if (Array.isArray(parsed)) {
        folders = JSON.stringify(parsed.map((folder) => {
          if (!folder || typeof folder !== 'object' || Array.isArray(folder)) return folder;
          return { ...folder, path: null };
        }));
      }
    } catch {
      folders = null;
    }
  }
  let settings: unknown = null;
  if (typeof row.settings === 'string') {
    try { settings = JSON.stringify(sanitizePortableBackupJson(JSON.parse(row.settings))); }
    catch { settings = null; }
  }
  return { ...row, cwd: null, folders, settings };
}

function portableContextRow(row: Record<string, unknown>): Record<string, unknown> {
  const filePath = typeof row.file_path === 'string' ? row.file_path : '';
  return {
    ...row,
    file_path: portableBackupRelativePath(filePath),
  };
}

function portableMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  for (const field of ['blocks', 'tool_calls', 'metadata'] as const) {
    const encoded = copy[field];
    if (typeof encoded !== 'string') continue;
    try { copy[field] = JSON.stringify(sanitizePortableBackupJson(JSON.parse(encoded))); }
    catch { copy[field] = null; }
  }
  return copy;
}

// ─── GET /api/admin/users ──────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  try {
    const authDb = getAuthDb();
    const dataDb = getDb();

    // Read all users from auth.sqlite
    const authUsers = authDb.prepare(
      'SELECT id, email, name, created_at AS createdAt FROM "user" ORDER BY created_at DESC'
    ).all() as Array<{ id: string; email: string; name: string; createdAt: number }>;
    authDb.close();

    // Build counts from data.db per owner_user_id
    const wsCounts = dataDb.prepare(
      'SELECT owner_user_id, COUNT(*) as cnt FROM workspaces WHERE deleted_at IS NULL GROUP BY owner_user_id'
    ).all() as Array<{ owner_user_id: string; cnt: number }>;

    const msgCounts = dataDb.prepare(
      `SELECT w.owner_user_id, COUNT(m.id) as cnt
       FROM messages m
       JOIN nodes n ON n.id = m.node_id
       JOIN workspaces w ON w.id = n.workspace_id
       WHERE w.deleted_at IS NULL
       GROUP BY w.owner_user_id`
    ).all() as Array<{ owner_user_id: string; cnt: number }>;

    const lastSeen = dataDb.prepare(
      `SELECT w.owner_user_id, MAX(n.created_at) as lastSeenAt
       FROM nodes n
       JOIN workspaces w ON w.id = n.workspace_id
       WHERE w.deleted_at IS NULL
       GROUP BY w.owner_user_id`
    ).all() as Array<{ owner_user_id: string; lastSeenAt: number }>;

    const wsMap = new Map(wsCounts.map((r) => [r.owner_user_id, r.cnt]));
    const msgMap = new Map(msgCounts.map((r) => [r.owner_user_id, r.cnt]));
    const seenMap = new Map(lastSeen.map((r) => [r.owner_user_id, r.lastSeenAt]));

    const users = authUsers.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      workspaceCount: wsMap.get(u.id) ?? 0,
      messageCount: msgMap.get(u.id) ?? 0,
      lastSeenAt: seenMap.get(u.id) ?? null,
    }));

    recordAudit({
      action: 'admin.users.list',
      actor: actorFromReq(req),
      ip: ipFromReq(req),
      ua: uaFromReq(req),
      metadata: { count: users.length },
    });

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/admin/workspaces ─────────────────────────────────────────────────

router.get('/workspaces', async (req, res) => {
  try {
    const userId = req.query.userId as string | undefined;
    const dataDb = getDb();

    type WsRow = { id: string; name: string; ownerUserId: string; createdAt: number; updatedAt: number; messageCount: number };
    const workspaces: WsRow[] = userId
      ? (dataDb.prepare(
          `SELECT w.id, w.name, w.owner_user_id AS ownerUserId, w.created_at AS createdAt, w.updated_at AS updatedAt,
                  COUNT(DISTINCT m.id) AS messageCount
           FROM workspaces w
           LEFT JOIN nodes n ON n.workspace_id = w.id
           LEFT JOIN messages m ON m.node_id = n.id
           WHERE w.owner_user_id = ? AND w.deleted_at IS NULL
           GROUP BY w.id
           ORDER BY w.updated_at DESC`
        ).all(userId) as WsRow[])
      : (dataDb.prepare(
          `SELECT w.id, w.name, w.owner_user_id AS ownerUserId, w.created_at AS createdAt, w.updated_at AS updatedAt,
                  COUNT(DISTINCT m.id) AS messageCount
           FROM workspaces w
           LEFT JOIN nodes n ON n.workspace_id = w.id
           LEFT JOIN messages m ON m.node_id = n.id
           WHERE w.deleted_at IS NULL
           GROUP BY w.id
           ORDER BY w.updated_at DESC`
        ).all() as WsRow[]);

    // Enrich with owner email from auth.sqlite
    let emailMap = new Map<string, string>();
    if (workspaces.length > 0) {
      const authDb = getAuthDb();
      const ownerIds = [...new Set(workspaces.map((w) => w.ownerUserId).filter(Boolean))];
      if (ownerIds.length > 0) {
        const placeholders = ownerIds.map(() => '?').join(',');
        const rows = authDb.prepare(
          `SELECT id, email FROM "user" WHERE id IN (${placeholders})`
        ).all(...ownerIds) as Array<{ id: string; email: string }>;
        emailMap = new Map(rows.map((r) => [r.id, r.email]));
      }
      authDb.close();
    }

    const result = workspaces.map((w) => ({
      ...w,
      ownerEmail: emailMap.get(w.ownerUserId) ?? null,
    }));

    recordAudit({
      action: 'admin.workspaces.list',
      actor: actorFromReq(req),
      ip: ipFromReq(req),
      ua: uaFromReq(req),
      metadata: { count: result.length, userId: userId ?? null },
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── POST /api/admin/users/:id/export ─────────────────────────────────────────

router.post('/users/:id/export', async (req, res) => {
  const targetId = req.params.id;
  try {
    const dataDb = getDb();

    // User info from auth.sqlite
    const authDb = getAuthDb();
    const user = authDb.prepare('SELECT id, email, name, created_at FROM "user" WHERE id = ?').get(targetId) as
      | { id: string; email: string; name: string; created_at: number }
      | undefined;
    authDb.close();

    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const rawWorkspaces = dataDb.prepare(
      'SELECT * FROM workspaces WHERE owner_user_id = ?'
    ).all(targetId) as Array<Record<string, unknown>>;
    const workspaces = rawWorkspaces.map(portableWorkspaceRow);

    const wsIds = rawWorkspaces.map((w) => w.id as string);

    let trees: unknown[] = [];
    let nodes: unknown[] = [];
    let edges: unknown[] = [];
    let messages: unknown[] = [];
    let contexts: unknown[] = [];

    if (wsIds.length > 0) {
      const placeholders = wsIds.map(() => '?').join(',');
      trees = dataDb.prepare(`SELECT * FROM trees WHERE workspace_id IN (${placeholders})`).all(...wsIds);
      nodes = (dataDb.prepare(`SELECT * FROM nodes WHERE workspace_id IN (${placeholders})`).all(...wsIds) as Array<Record<string, unknown>>)
        .map(sanitizeAgentNodeForBackup);
      edges = dataDb.prepare(`SELECT * FROM edges WHERE workspace_id IN (${placeholders})`).all(...wsIds);
      contexts = (dataDb.prepare(`SELECT * FROM contexts WHERE workspace_id IN (${placeholders})`).all(
        ...wsIds,
      ) as Array<Record<string, unknown>>).map(portableContextRow);

      const nodeIds = (nodes as Array<{ id: string }>).map((n) => n.id);
      if (nodeIds.length > 0) {
        const nodePlaceholders = nodeIds.map(() => '?').join(',');
        messages = (dataDb.prepare(`SELECT * FROM messages WHERE node_id IN (${nodePlaceholders})`).all(
          ...nodeIds,
        ) as Array<Record<string, unknown>>).map(portableMessageRow);
      }
    }

    // User agent config
    const userAgentConfig = dataDb.prepare(
      'SELECT * FROM user_agent_configs WHERE user_id = ?'
    ).get(targetId);

    // Provider key presence (never export plaintext keys)
    const providerKeyRows = listUserProviderKeys(targetId);
    const providerKeyPresence: Record<string, boolean> = {};
    for (const row of providerKeyRows) {
      providerKeyPresence[row.provider] = true;
    }

    recordAudit({
      action: 'admin.user.export',
      actor: actorFromReq(req),
      target: { type: 'user', id: targetId },
      ip: ipFromReq(req),
      ua: uaFromReq(req),
    });

    res.json({
      user,
      workspaces,
      trees,
      nodes,
      edges,
      messages,
      contexts,
      userAgentConfig: userAgentConfig ?? null,
      providerKeyPresence,
      agents: exportAgentRunBackup(targetId, null),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── DELETE /api/admin/users/:id ──────────────────────────────────────────────

router.delete('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  let preparedAgentDeletion: PreparedAgentOwnerDeletion | null = null;
  try {
    const dataDb = getDb();
    const runCount = (dataDb.prepare(
      'SELECT COUNT(*) as cnt FROM agent_runs WHERE owner_user_id = ?'
    ).get(targetId) as { cnt: number }).cnt;
    const definitionCount = (dataDb.prepare(
      'SELECT COUNT(*) as cnt FROM agent_definitions WHERE owner_user_id = ?'
    ).get(targetId) as { cnt: number }).cnt;
    if ((runCount > 0 || definitionCount > 0) && !deps.agentRunLifecycle) {
      return res.status(503).json({ error: 'agent_run_lifecycle_required' });
    }
    if (deps.agentRunLifecycle) {
      preparedAgentDeletion = await deps.agentRunLifecycle.prepareOwnerDeletion(targetId);
    }

    // Count for response
    const wsCount = (dataDb.prepare(
      'SELECT COUNT(*) as cnt FROM workspaces WHERE owner_user_id = ?'
    ).get(targetId) as { cnt: number }).cnt;

    const nodeCount = (dataDb.prepare(
      `SELECT COUNT(*) as cnt FROM nodes n
       JOIN workspaces w ON w.id = n.workspace_id
       WHERE w.owner_user_id = ?`
    ).get(targetId) as { cnt: number }).cnt;

    const msgCount = (dataDb.prepare(
      `SELECT COUNT(*) as cnt FROM messages m
       JOIN nodes n ON n.id = m.node_id
       JOIN workspaces w ON w.id = n.workspace_id
       WHERE w.owner_user_id = ?`
    ).get(targetId) as { cnt: number }).cnt;

    const keyCount = (dataDb.prepare(
      'SELECT COUNT(*) as cnt FROM user_provider_keys WHERE user_id = ?'
    ).get(targetId) as { cnt: number }).cnt;

    // ── data.db transaction: delete all business data ──────────────────────
    dataDb.exec('BEGIN');
    try {
      if (deps.agentRunLifecycle && preparedAgentDeletion) {
        deps.agentRunLifecycle.deleteOwnerAgentRows(preparedAgentDeletion);
      }
      // Cascade order: messages → edges → nodes → contexts →
      //   workspace_permission_grants → user_agent_configs →
      //   user_provider_keys → workspaces
      // (SQLite FK cascade would handle sub-tables, but we're explicit)

      // Get workspace ids first for targeted deletes
      const wsIds = (dataDb.prepare(
        'SELECT id FROM workspaces WHERE owner_user_id = ?'
      ).all(targetId) as Array<{ id: string }>).map((r) => r.id);

      if (wsIds.length > 0) {
        const ph = wsIds.map(() => '?').join(',');
        // nodes includes a FK cascade to messages, edges, but we delete explicitly
        const nodeIds = (dataDb.prepare(
          `SELECT id FROM nodes WHERE workspace_id IN (${ph})`
        ).all(...wsIds) as Array<{ id: string }>).map((r) => r.id);

        if (nodeIds.length > 0) {
          const nph = nodeIds.map(() => '?').join(',');
          dataDb.prepare(`DELETE FROM messages WHERE node_id IN (${nph})`).run(...nodeIds);
        }

        dataDb.prepare(`DELETE FROM edges WHERE workspace_id IN (${ph})`).run(...wsIds);
        dataDb.prepare(`DELETE FROM nodes WHERE workspace_id IN (${ph})`).run(...wsIds);
        dataDb.prepare(`DELETE FROM trees WHERE workspace_id IN (${ph})`).run(...wsIds);
        dataDb.prepare(`DELETE FROM contexts WHERE workspace_id IN (${ph})`).run(...wsIds);
        dataDb.prepare(`DELETE FROM workspace_permission_grants WHERE workspace_id IN (${ph})`).run(...wsIds);
      }

      dataDb.prepare('DELETE FROM user_agent_configs WHERE user_id = ?').run(targetId);
      dataDb.prepare('DELETE FROM user_provider_keys WHERE user_id = ?').run(targetId);
      dataDb.prepare('DELETE FROM workspaces WHERE owner_user_id = ?').run(targetId);

      dataDb.exec('COMMIT');
    } catch (err) {
      dataDb.exec('ROLLBACK');
      throw err;
    }

    let agentCleanup: AgentOwnerCleanupResult = { cleanedRunIds: [], failed: [] };
    if (deps.agentRunLifecycle && preparedAgentDeletion) {
      agentCleanup = await deps.agentRunLifecycle.cleanupPreparedDeletion(preparedAgentDeletion);
    }

    // ── auth.sqlite transaction: delete session / account / user ──────────
    const authDb = getAuthDb();
    authDb.exec('BEGIN');
    try {
      authDb.prepare('DELETE FROM "session" WHERE "userId" = ?').run(targetId);
      authDb.prepare('DELETE FROM "account" WHERE "userId" = ?').run(targetId);
      authDb.prepare('DELETE FROM "user" WHERE id = ?').run(targetId);
      authDb.exec('COMMIT');
    } catch (err) {
      authDb.exec('ROLLBACK');
      authDb.close();
      throw err;
    }
    authDb.close();

    // ── fs cleanup (best-effort, post-commit) ──────────────────────────────
    const dataDir = getMichiDataDir();
    const dirsToRemove = [
      path.join(dataDir, 'uploads', targetId),
      path.join(dataDir, 'sandbox', targetId),
      path.join(dataDir, 'claude-projects', targetId),
    ];
    let filesRemoved = 0;
    for (const dir of dirsToRemove) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          filesRemoved++;
        }
      } catch {
        // best-effort
      }
    }

    recordAudit({
      action: 'admin.user.delete',
      actor: actorFromReq(req),
      target: { type: 'user', id: targetId },
      ip: ipFromReq(req),
      ua: uaFromReq(req),
      metadata: {
        workspaces: wsCount,
        nodes: nodeCount,
        messages: msgCount,
        providerKeys: keyCount,
        agentDefinitions: definitionCount,
        agentRuns: runCount,
        agentCleanupFailures: agentCleanup.failed.map((failure) => ({ ...failure, retryable: true })),
      },
    });

    if (deps.agentRunLifecycle && preparedAgentDeletion) {
      deps.agentRunLifecycle.finishOwnerDeletion(preparedAgentDeletion);
      preparedAgentDeletion = null;
    }

    res.json({
      deleted: {
        workspaces: wsCount,
        nodes: nodeCount,
        messages: msgCount,
        providerKeys: keyCount,
        agentDefinitions: definitionCount,
        agentRuns: runCount,
        agentRunFiles: agentCleanup.cleanedRunIds.length,
        files: filesRemoved,
      },
      cleanupFailures: agentCleanup.failed.map((failure) => ({ ...failure, retryable: true })),
    });
  } catch (err) {
    if (deps.agentRunLifecycle && preparedAgentDeletion) {
      deps.agentRunLifecycle.abortOwnerDeletion(preparedAgentDeletion);
    }
    const message = (err as Error).message;
    res.status(message.includes('could not be quiesced') || message.includes('deletion is already in progress')
      || message.includes('deletion lease was lost') ? 409 : 500).json({ error: message });
  }
});

return router;
}

export default setupAdminRoutes();
