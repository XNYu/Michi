import express from 'express';
import { randomUUID } from 'node:crypto';
import { getDb, runInTransaction } from '../services/db';
import {
  loadFullWorkspace, loadAllWorkspaces, saveWorkspace, saveTree,
  saveNode, saveEdge, saveMessage, saveContext,
  WorkspaceRow, TreeRow, NodeRow, EdgeRow, MessageRow, ContextRow,
} from '../services/dbRepository';
import { normalizeIncomingMessageRow } from '../services/messageSerialization';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import {
  exportAgentRunBackup,
  importAgentRunBackup,
  portableBackupRelativePath,
  sanitizeAgentNodeForBackup,
  sanitizePortableBackupJson,
} from '../services/agentRunBackup';
import { assertAgentOwnerWritable } from '../services/agentOwnerDeletionGate';
import { AgentRunContractError, type AgentRunBackupFragmentV2 } from 'michi-shared';
import { requireWorkspaceOwner } from './middleware/ownership';

export interface BackupPayload {
  version: 1 | 2;
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
  agents?: AgentRunBackupFragmentV2;
}

function agentOwnerId(req: express.Request): string {
  return process.env.MICHI_CLOUD === '1' ? req.user?.id ?? '' : LOCAL_AGENT_OWNER_ID;
}

function sanitizeWorkspace(data: BackupPayload['workspaces'][number]): BackupPayload['workspaces'][number] {
  let settings = data.workspace.settings ?? null;
  if (settings) {
    try { settings = JSON.stringify(sanitizePortableBackupJson(JSON.parse(settings))); }
    catch { settings = null; }
  }
  return {
    ...data,
    workspace: { ...data.workspace, cwd: null, folders: '[]', settings },
    nodes: data.nodes.map((node) => sanitizeAgentNodeForBackup(
      node as unknown as Record<string, unknown>,
    ) as unknown as NodeRow),
    messages: data.messages.map((message) => ({
      ...message,
      blocks: sanitizeEncodedJson(message.blocks),
      tool_calls: sanitizeEncodedJson(message.tool_calls),
      metadata: sanitizeEncodedJson(message.metadata),
    })),
    contexts: data.contexts.map((context) => ({
      ...context,
      file_path: portableBackupRelativePath(context.file_path),
      url: portableUrl(context.url),
    })),
  };
}

function sanitizeEncodedJson(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  try { return JSON.stringify(sanitizePortableBackupJson(JSON.parse(encoded))); }
  catch { return null; }
}

function portableUrl(value: string | null | undefined): string | null {
  if (!value || /^file:/i.test(value)) return null;
  const sanitized = sanitizePortableBackupJson({ url: value }) as { url?: unknown };
  if (typeof sanitized.url !== 'string' || sanitized.url === 'not-exported') return null;
  try {
    const url = new URL(sanitized.url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return sanitized.url;
  }
}

function importedId(kind: string): string {
  return `import-${kind}-${randomUUID()}`;
}

function idMap<T extends { id: string }>(rows: readonly T[], kind: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    if (result.has(row.id)) throw new Error(`Invalid backup: duplicate ${kind} ID ${row.id}`);
    result.set(row.id, importedId(kind));
  }
  return result;
}

function mapped(map: ReadonlyMap<string, string>, sourceId: string | null | undefined): string | null {
  return sourceId ? map.get(sourceId) ?? null : null;
}

function requiredMapped(map: ReadonlyMap<string, string>, sourceId: string, kind: string): string {
  const value = map.get(sourceId);
  if (!value) throw new Error(`Invalid backup: missing ${kind} reference ${sourceId}`);
  return value;
}

function remapTrimSnapshot(encoded: string | null | undefined, nodeIds: ReadonlyMap<string, string>,
  treeIds: ReadonlyMap<string, string>): string | null {
  if (!encoded) return null;
  try {
    const raw = JSON.parse(encoded) as { parentId?: string | null; childrenIds?: string[];
      wasTreeRoot?: { treeId?: string } | null };
    return JSON.stringify({
      ...raw,
      parentId: mapped(nodeIds, raw.parentId),
      childrenIds: (raw.childrenIds ?? []).map((id) => nodeIds.get(id)).filter((id): id is string => !!id),
      wasTreeRoot: raw.wasTreeRoot?.treeId && treeIds.has(raw.wasTreeRoot.treeId)
        ? { ...raw.wasTreeRoot, treeId: treeIds.get(raw.wasTreeRoot.treeId)! }
        : null,
    });
  } catch {
    return null;
  }
}

function remapDigest(encoded: string | null | undefined, nodeIds: ReadonlyMap<string, string>): string | null {
  if (!encoded) return null;
  try {
    const raw = sanitizePortableBackupJson(JSON.parse(encoded)) as unknown as {
      sources?: string[]; sourceFingerprints?: Record<string, string>;
    };
    const sourceFingerprints: Record<string, string> = {};
    for (const [sourceId, fingerprint] of Object.entries(raw.sourceFingerprints ?? {})) {
      const remapped = nodeIds.get(sourceId);
      if (remapped) sourceFingerprints[remapped] = fingerprint;
    }
    return JSON.stringify({
      ...raw,
      sources: (raw.sources ?? []).map((id) => nodeIds.get(id)).filter((id): id is string => !!id),
      sourceFingerprints,
    });
  } catch {
    return null;
  }
}

function workspaceRowForSave(source: WorkspaceRow, id: string, ownerUserId: string | null): WorkspaceRow {
  return {
    id,
    name: source.name,
    cwd: null,
    active_tree_id: null,
    created_at: source.created_at,
    updated_at: source.updated_at,
    settings: source.settings ?? null,
    deleted_at: source.deleted_at ?? null,
    archived_at: source.archived_at ?? null,
    pinned_at: source.pinned_at ?? null,
    backend: source.backend ?? 'kiro',
    owner_user_id: ownerUserId,
    folders: '[]',
  };
}

function nodeRowForSave(source: NodeRow, overrides: Partial<NodeRow>): NodeRow {
  return {
    id: overrides.id ?? source.id,
    workspace_id: overrides.workspace_id ?? source.workspace_id,
    tree_id: overrides.tree_id ?? null,
    parent_node_id: overrides.parent_node_id ?? null,
    kind: source.kind,
    title: source.title ?? null,
    branch_overview: source.branch_overview ?? null,
    status: source.status,
    position_x: source.position_x ?? null,
    position_y: source.position_y ?? null,
    minimized: source.minimized,
    deleted_at: source.deleted_at ?? null,
    deletion_group_id: overrides.deletion_group_id ?? null,
    spawned_by_agent: source.spawned_by_agent,
    current_mode_id: source.current_mode_id ?? null,
    pane_width: source.pane_width ?? null,
    digest: overrides.digest !== undefined ? overrides.digest : source.digest ?? null,
    follow_ups: sanitizeEncodedJson(source.follow_ups),
    follow_ups_source_message_id: overrides.follow_ups_source_message_id ?? null,
    acp_session_id: null,
    runtime_id: source.runtime_id ?? null,
    provider_id: source.provider_id ?? null,
    model_id: source.model_id ?? null,
    reasoning: source.reasoning ?? null,
    resume_fingerprint: null,
    composer_draft: source.composer_draft ?? null,
    external_session_id: null,
    trim_snapshot: overrides.trim_snapshot ?? null,
    last_applied_turn_id: null,
    last_applied_seq: null,
    created_at: source.created_at,
    rev: null,
  };
}

function treeRowForSave(source: TreeRow, id: string, workspaceId: string, rootNodeId: string): TreeRow {
  return {
    id,
    workspace_id: workspaceId,
    root_node_id: rootNodeId,
    name: source.name ?? null,
    archived_at: source.archived_at ?? null,
    pinned_at: source.pinned_at ?? null,
    last_active_at: source.last_active_at,
    created_at: source.created_at,
    rev: null,
  };
}

function edgeRowForSave(source: EdgeRow, id: string, workspaceId: string, sourceNodeId: string,
  targetNodeId: string, anchorMessageId: string | null): EdgeRow {
  return {
    id,
    workspace_id: workspaceId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    kind: source.kind,
    anchor_message_id: anchorMessageId,
    created_at: source.created_at ?? null,
    rev: null,
  };
}

function contextRowForSave(source: ContextRow, id: string, workspaceId: string,
  originNodeId: string | null, originMessageId: string | null): ContextRow {
  return {
    id,
    workspace_id: workspaceId,
    name: source.name,
    file_path: portableBackupRelativePath(source.file_path),
    size: source.size ?? null,
    auto_inject: source.auto_inject,
    source: source.source,
    type: source.type ?? null,
    url: portableUrl(source.url),
    origin_node_id: originNodeId,
    origin_message_id: originMessageId,
    kind: source.kind ?? null,
    pinned_at: source.pinned_at ?? null,
    created_at: source.created_at,
    updated_at: source.updated_at,
    rev: null,
  };
}

function replaceWorkspaceInTransaction(workspaceId: string, userId?: string): void {
  const db = getDb();
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const owned = db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?')
      .get(workspaceId, userId);
    if (!owned) return;
  }
  const now = Date.now();
  db.prepare('UPDATE workspaces SET purged_at = ? WHERE id = ? AND purged_at IS NULL').run(now, workspaceId);
  db.prepare('UPDATE nodes SET purged_at = ? WHERE workspace_id = ? AND purged_at IS NULL').run(now, workspaceId);
  db.prepare('DELETE FROM messages WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ?)').run(workspaceId);
  db.prepare('DELETE FROM edges WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM trees WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM contexts WHERE workspace_id = ?').run(workspaceId);
}

function validateWorkspaceGraph(workspace: BackupPayload['workspaces'][number]): void {
  const workspaceId = workspace.workspace.id;
  const treeIds = new Set(workspace.trees.map((tree) => tree.id));
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  const messageIds = new Set(workspace.messages.map((message) => message.id));
  const requireLocal = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(`Invalid backup: ${message}`);
  };
  if (workspace.workspace.active_tree_id) {
    requireLocal(treeIds.has(workspace.workspace.active_tree_id),
      `Workspace ${workspaceId} references a foreign active Tree`);
  }
  for (const tree of workspace.trees) {
    requireLocal(tree.workspace_id === workspaceId, `Tree ${tree.id} belongs to a different Workspace`);
    requireLocal(nodeIds.has(tree.root_node_id), `Tree ${tree.id} references a foreign root Node`);
  }
  for (const node of workspace.nodes) {
    requireLocal(node.workspace_id === workspaceId, `Node ${node.id} belongs to a different Workspace`);
    requireLocal(!node.tree_id || treeIds.has(node.tree_id), `Node ${node.id} references a foreign Tree`);
    requireLocal(!node.parent_node_id || nodeIds.has(node.parent_node_id),
      `Node ${node.id} references a foreign Parent`);
    requireLocal(!node.follow_ups_source_message_id || messageIds.has(node.follow_ups_source_message_id),
      `Node ${node.id} references a foreign follow-up Message`);
  }
  for (const edge of workspace.edges) {
    requireLocal(edge.workspace_id === workspaceId, `Edge ${edge.id} belongs to a different Workspace`);
    requireLocal(nodeIds.has(edge.source_node_id) && nodeIds.has(edge.target_node_id),
      `Edge ${edge.id} crosses a Workspace boundary`);
    requireLocal(!edge.anchor_message_id || messageIds.has(edge.anchor_message_id),
      `Edge ${edge.id} references a foreign Message`);
  }
  for (const message of workspace.messages) {
    requireLocal(nodeIds.has(message.node_id), `Message ${message.id} references a foreign Node`);
  }
  for (const context of workspace.contexts) {
    requireLocal(context.workspace_id === workspaceId, `Context ${context.id} belongs to a different Workspace`);
    requireLocal(!context.origin_node_id || nodeIds.has(context.origin_node_id),
      `Context ${context.id} references a foreign origin Node`);
    requireLocal(!context.origin_message_id || messageIds.has(context.origin_message_id),
      `Context ${context.id} references a foreign origin Message`);
  }
}

export function setupBackupRoutes(): express.Router {
  const router = express.Router();

  // Export all workspaces — in cloud mode, scoped to the authenticated user only.
  router.get('/backup/export', (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const ownerUserId = agentOwnerId(req);
      if (!ownerUserId) return res.status(401).json({ error: 'authentication_required' });
      const workspaces = loadAllWorkspaces(userId).map(sanitizeWorkspace);
      const payload: BackupPayload = {
        version: 2,
        exportedAt: Date.now(),
        app: 'michi',
        workspaces,
        agents: exportAgentRunBackup(ownerUserId, null, {
          workspaceIds: new Set(workspaces.map(({ workspace }) => workspace.id)),
        }),
      };
      res.json(payload);
    } catch (err) {
      const message = (err as Error).message;
      res.status(err instanceof AgentRunContractError || message.startsWith('Invalid backup:') ? 400
        : message === 'Agent owner data is being deleted' ? 409 : 500).json({ error: message });
    }
  });

  // Export single workspace — already protected by requireWorkspaceOwner (P1.3).
  // Also pass userId for repo-layer defense in depth.
  router.get('/backup/export/:workspaceId', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const ownerUserId = agentOwnerId(req);
      if (!ownerUserId) return res.status(401).json({ error: 'authentication_required' });
      const data = loadFullWorkspace(req.params.workspaceId, userId);
      if (!data) return res.status(404).json({ error: 'Workspace not found' });
      const payload: BackupPayload = {
        version: 2,
        exportedAt: Date.now(),
        app: 'michi',
        workspaces: [sanitizeWorkspace(data)],
        agents: exportAgentRunBackup(ownerUserId, req.params.workspaceId),
      };
      res.json(payload);
    } catch (err) {
      const message = (err as Error).message;
      res.status(err instanceof AgentRunContractError ? 400
        : message === 'Agent owner data is being deleted' ? 409 : 500).json({ error: message });
    }
  });

  // Import backup
  router.post('/backup/import', (req, res) => {
    try {
      const body = req.body as BackupPayload;
      if (!body || body.app !== 'michi') {
        return res.status(400).json({ error: 'Invalid backup file: missing or wrong app field' });
      }
      if (body.version !== 1 && body.version !== 2) {
        return res.status(400).json({ error: 'Unsupported backup version' });
      }
      if (!Array.isArray(body.workspaces)) {
        return res.status(400).json({ error: 'Invalid backup: workspaces must be an array' });
      }

      const mode = (req.query.mode as string) || 'merge';
      if (mode !== 'merge' && mode !== 'replace') {
        return res.status(400).json({ error: 'Invalid backup import mode' });
      }
      const userId: string | undefined = process.env.MICHI_CLOUD === '1' ? req.user?.id : undefined;
      const ownerUserId = agentOwnerId(req);
      if (!ownerUserId) return res.status(401).json({ error: 'authentication_required' });
      if (body.version === 2 && !body.agents) {
        return res.status(400).json({ error: 'Invalid backup: version 2 requires an agents fragment' });
      }
      let workspaceCount = 0;
      let importedDefinitions = 0;
      let importedRuns = 0;
      const portableWorkspaces = body.workspaces.map(sanitizeWorkspace);
      portableWorkspaces.forEach(validateWorkspaceGraph);
      const allTrees = portableWorkspaces.flatMap((workspace) => workspace.trees);
      const allNodes = portableWorkspaces.flatMap((workspace) => workspace.nodes);
      const allEdges = portableWorkspaces.flatMap((workspace) => workspace.edges);
      const allMessages = portableWorkspaces.flatMap((workspace) => workspace.messages);
      const allContexts = portableWorkspaces.flatMap((workspace) => workspace.contexts);
      const workspaceIdMap = idMap(portableWorkspaces.map(({ workspace }) => workspace), 'workspace');
      const treeIdMap = idMap(allTrees, 'tree');
      const nodeIdMap = idMap(allNodes, 'node');
      const edgeIdMap = idMap(allEdges, 'edge');
      const messageIdMap = idMap(allMessages, 'message');
      const contextIdMap = idMap(allContexts, 'context');
      const deletionGroupIdMap = new Map<string, string>();
      for (const node of allNodes) {
        if (node.deletion_group_id && !deletionGroupIdMap.has(node.deletion_group_id)) {
          deletionGroupIdMap.set(node.deletion_group_id, importedId('deletion-group'));
        }
      }

      runInTransaction(() => {
        assertAgentOwnerWritable(ownerUserId);
        for (const ws of portableWorkspaces) {
          if (mode === 'replace') replaceWorkspaceInTransaction(ws.workspace.id, userId);
          const workspaceId = requiredMapped(workspaceIdMap, ws.workspace.id, 'Workspace');
          const wsRow = workspaceRowForSave(ws.workspace, workspaceId, userId ?? null);
          saveWorkspace(wsRow);
          workspaceCount++;

          // Create Nodes without graph FKs first, then bind the graph after
          // Messages and Trees have their remapped identities.
          for (const n of ws.nodes) {
            const sanitizedNode = sanitizeAgentNodeForBackup(
              n as unknown as Record<string, unknown>,
            ) as unknown as NodeRow;
            saveNode(nodeRowForSave(sanitizedNode, {
              id: requiredMapped(nodeIdMap, n.id, 'Node'),
              workspace_id: workspaceId,
              tree_id: null,
              parent_node_id: null,
              follow_ups_source_message_id: null,
              digest: remapDigest(n.digest, nodeIdMap),
              deletion_group_id: mapped(deletionGroupIdMap, n.deletion_group_id),
              trim_snapshot: null,
              last_applied_turn_id: null,
              last_applied_seq: null,
            }), userId);
          }
          for (let i = 0; i < ws.messages.length; i++) {
            const m = ws.messages[i];
            const remappedMessage = normalizeIncomingMessageRow({
              ...m,
              id: requiredMapped(messageIdMap, m.id, 'Message'),
              node_id: requiredMapped(nodeIdMap, m.node_id, 'Message Node'),
            } as unknown as Record<string, unknown>, requiredMapped(nodeIdMap, m.node_id, 'Message Node'), i);
            saveMessage(remappedMessage, userId);
          }
          for (const t of ws.trees) {
            saveTree(treeRowForSave(t, requiredMapped(treeIdMap, t.id, 'Tree'), workspaceId,
              requiredMapped(nodeIdMap, t.root_node_id, 'Tree root Node')), userId);
          }
          for (const n of ws.nodes) {
            const sanitizedNode = sanitizeAgentNodeForBackup(
              n as unknown as Record<string, unknown>,
            ) as unknown as NodeRow;
            saveNode(nodeRowForSave(sanitizedNode, {
              id: requiredMapped(nodeIdMap, n.id, 'Node'),
              workspace_id: workspaceId,
              tree_id: mapped(treeIdMap, n.tree_id),
              parent_node_id: mapped(nodeIdMap, n.parent_node_id),
              follow_ups_source_message_id: mapped(messageIdMap, n.follow_ups_source_message_id),
              digest: remapDigest(n.digest, nodeIdMap),
              deletion_group_id: mapped(deletionGroupIdMap, n.deletion_group_id),
              trim_snapshot: remapTrimSnapshot(n.trim_snapshot, nodeIdMap, treeIdMap),
              last_applied_turn_id: null,
              last_applied_seq: null,
            }), userId);
          }
          for (const e of ws.edges) {
            saveEdge(edgeRowForSave(e, requiredMapped(edgeIdMap, e.id, 'Edge'), workspaceId,
              requiredMapped(nodeIdMap, e.source_node_id, 'Edge source Node'),
              requiredMapped(nodeIdMap, e.target_node_id, 'Edge target Node'),
              mapped(messageIdMap, e.anchor_message_id)), userId);
          }
          for (const c of ws.contexts) {
            saveContext(contextRowForSave(c, requiredMapped(contextIdMap, c.id, 'Context'), workspaceId,
              mapped(nodeIdMap, c.origin_node_id), mapped(messageIdMap, c.origin_message_id)), userId);
          }
          const activeTreeId = mapped(treeIdMap, ws.workspace.active_tree_id);
          getDb().prepare('UPDATE workspaces SET active_tree_id = ? WHERE id = ?')
            .run(activeTreeId, workspaceId);
        }
        if (body.version === 2 && body.agents) {
          const imported = importAgentRunBackup({
            ownerUserId,
            fragment: body.agents,
            workspaceIdMap,
            nodeIdMap,
            withinTransaction: true,
          });
          importedDefinitions = imported.importedDefinitions;
          importedRuns = imported.importedRuns;
          for (const workspace of portableWorkspaces) {
            for (const rawNode of workspace.nodes) {
              const node = sanitizeAgentNodeForBackup(
                rawNode as unknown as Record<string, unknown>,
              );
              const sourceDefinitionId = typeof node.agent_definition_id === 'string'
                ? node.agent_definition_id
                : null;
              const definitionId = sourceDefinitionId
                ? imported.definitionIds.get(sourceDefinitionId) ?? null
                : null;
              const effectiveDefinition = typeof node.agent_effective_definition === 'string'
                ? node.agent_effective_definition
                : null;
              getDb().prepare(`UPDATE nodes SET agent_definition_id = ?, agent_definition_revision = ?,
                agent_effective_definition = ? WHERE id = ? AND workspace_id = ?`)
                .run(definitionId, definitionId ? node.agent_definition_revision as number | null : null,
                  effectiveDefinition, requiredMapped(nodeIdMap, rawNode.id, 'Node'),
                  requiredMapped(workspaceIdMap, rawNode.workspace_id, 'Workspace'));
            }
          }
        }
      });
      res.json({ imported: true, workspaceCount, importedDefinitions, importedRuns,
        workspaceIds: Object.fromEntries(workspaceIdMap) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(err instanceof AgentRunContractError || message.startsWith('Invalid backup:') ? 400
        : message === 'Agent owner data is being deleted' ? 409 : 500).json({ error: message });
    }
  });

  return router;
}
