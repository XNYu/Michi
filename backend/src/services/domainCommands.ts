import { createHash } from 'node:crypto';
import { mergeLegacyComposerDraft, mergeWindowComposerDraft } from 'michi-shared';
import { getDb, runInTransaction } from './db';
import { DomainError } from './domainErrors';
import { assertNodePlacement } from './nodePlacement';
import { nodePlacementRepository } from './nodePlacementRepository';
import {
  deleteContext,
  deleteEdge,
  deleteTree,
  getNode,
  getWorkspace,
  listTrees,
  markNodeViewed,
  saveContext,
  saveEdge,
  saveNode,
  saveTree,
  saveWorkspace,
  type ContextRow,
  type EdgeRow,
  type NodeRow,
  type TreeRow,
  type WorkspaceRow,
} from './dbRepository';

export type WorkspaceCommandType =
  | 'workspace.upsert'
  | 'tree.upsert'
  | 'tree.delete'
  | 'node.upsert'
  | 'node.patch'
  | 'edge.upsert'
  | 'edge.delete'
  | 'context.upsert'
  | 'context.delete';

export interface WorkspaceCommand {
  type: WorkspaceCommandType;
  payload: Record<string, unknown>;
}

export interface ApplyWorkspaceCommandsInput {
  operationId: string;
  commands: readonly WorkspaceCommand[];
  ownerUserId?: string | null;
}

export interface ApplyWorkspaceCommandsResult {
  operationId: string;
  applied: Array<{ type: WorkspaceCommandType; id: string }>;
}

function readId(payload: Record<string, unknown>, label: string): string {
  const id = payload.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 160) {
    throw new DomainError('invalid_argument', 'invalid_entity_id', `${label}.id must be a non-empty string <=160 chars`);
  }
  return id;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function updatedComposerDraft(raw: string | null | undefined, payload: Record<string, unknown>): string | null {
  const draft = optionalString(payload.composer_draft);
  if (!('composer_draft_window_id' in payload)) return mergeLegacyComposerDraft(raw, draft);
  const windowId = payload.composer_draft_window_id;
  if (typeof windowId !== 'string' || !windowId || windowId.length > 160) {
    throw new DomainError('invalid_argument', 'invalid_composer_window', 'composer_draft_window_id must be a non-empty string <=160 chars');
  }
  return mergeWindowComposerDraft(raw, windowId, draft);
}

function payloadHash(workspaceId: string, commands: readonly WorkspaceCommand[]): string {
  return createHash('sha256').update(JSON.stringify({ workspaceId, commands })).digest('hex');
}

function assertOwnedWorkspace(workspaceId: string, ownerUserId?: string | null): void {
  if (process.env.MICHI_CLOUD !== '1') return;
  const workspace = getWorkspace(workspaceId);
  if (workspace && workspace.owner_user_id !== ownerUserId) throw new DomainError('not_found', 'workspace_not_found', 'workspace not found');
}

function commandEntityId(command: WorkspaceCommand): string {
  return readId(command.payload, command.type);
}

function assertEntityWorkspace(
  table: 'trees' | 'edges' | 'contexts',
  id: string,
  workspaceId: string,
): void {
  const row = getDb().prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`)
    .get(id) as { workspace_id: string } | undefined;
  if (row && row.workspace_id !== workspaceId) {
    throw new DomainError('conflict', 'entity_workspace_mismatch', `${table.slice(0, -1)} ${id} belongs to a different workspace`);
  }
}

export function applyWorkspaceCommands(
  workspaceId: string,
  input: ApplyWorkspaceCommandsInput,
): ApplyWorkspaceCommandsResult {
  if (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 200) {
    throw new DomainError('invalid_argument', 'invalid_operation_id', 'operationId must be a non-empty string <=200 chars');
  }
  if (!Array.isArray(input.commands) || input.commands.length > 500) {
    throw new DomainError('invalid_argument', 'invalid_commands', 'commands must be an array of at most 500 items');
  }
  for (const command of input.commands) {
    if (!command || typeof command !== 'object' || typeof command.type !== 'string'
      || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
      throw new DomainError('invalid_argument', 'invalid_command', 'each command must have a type and object payload');
    }
  }
  const hash = payloadHash(workspaceId, input.commands);
  return runInTransaction(() => {
    assertOwnedWorkspace(workspaceId, input.ownerUserId);
    const prior = getDb().prepare(`
      SELECT payload_hash, result_json FROM command_receipts
      WHERE workspace_id = ? AND operation_id = ?
    `).get(workspaceId, input.operationId) as { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== hash) {
        throw new DomainError('conflict', 'operation_id_reused', `operation ${input.operationId} was reused with a different payload`);
      }
      return JSON.parse(prior.result_json) as ApplyWorkspaceCommandsResult;
    }

    const applied: ApplyWorkspaceCommandsResult['applied'] = [];
    const touchedTreeIds = new Set<string>();
    for (const command of input.commands) {
      const payload = command.payload;
      const id = commandEntityId(command);
      switch (command.type) {
        case 'workspace.upsert': {
          if (id !== workspaceId) throw new DomainError('conflict', 'workspace_id_mismatch', 'workspace command id must match route workspace');
          const existing = getWorkspace(workspaceId);
          saveWorkspace({
            id,
            name: typeof payload.name === 'string' && payload.name.trim() ? payload.name : existing?.name ?? 'Untitled',
            cwd: payload.cwd === undefined ? existing?.cwd ?? null : optionalString(payload.cwd),
            folders: payload.folders === undefined ? existing?.folders ?? null : optionalString(payload.folders),
            active_tree_id: payload.active_tree_id === undefined
              ? existing?.active_tree_id ?? null
              : optionalString(payload.active_tree_id),
            created_at: optionalNumber(payload.created_at) ?? existing?.created_at ?? Date.now(),
            updated_at: optionalNumber(payload.updated_at) ?? Date.now(),
            settings: payload.settings === undefined ? existing?.settings ?? null : optionalString(payload.settings),
            deleted_at: payload.deleted_at === undefined ? existing?.deleted_at ?? null : optionalNumber(payload.deleted_at),
            archived_at: payload.archived_at === undefined ? existing?.archived_at ?? null : optionalNumber(payload.archived_at),
            pinned_at: payload.pinned_at === undefined ? existing?.pinned_at ?? null : optionalNumber(payload.pinned_at),
            backend: existing?.backend ?? 'kiro',
            owner_user_id: input.ownerUserId ?? existing?.owner_user_id ?? null,
          });
          break;
        }
        case 'tree.upsert': {
          if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'tree_workspace_mismatch', 'tree must belong to route workspace');
          assertEntityWorkspace('trees', id, workspaceId);
          touchedTreeIds.add(id);
          saveTree({
            id,
            workspace_id: workspaceId,
            root_node_id: String(payload.root_node_id ?? ''),
            name: optionalString(payload.name),
            archived_at: optionalNumber(payload.archived_at),
            pinned_at: optionalNumber(payload.pinned_at),
            last_active_at: optionalNumber(payload.last_active_at) ?? Date.now(),
            created_at: optionalNumber(payload.created_at) ?? Date.now(),
          }, input.ownerUserId ?? undefined);
          break;
        }
        case 'tree.delete':
          assertEntityWorkspace('trees', id, workspaceId);
          deleteTree(id, input.ownerUserId ?? undefined);
          break;
        case 'node.upsert': {
          if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'node_workspace_mismatch', 'node must belong to route workspace');
          const parentId = optionalString(payload.parent_node_id);
          const treeId = optionalString(payload.tree_id);
          assertNodePlacement(workspaceId, treeId, parentId, nodePlacementRepository);
          const existing = getNode(id);
          if (existing) {
            if (existing.workspace_id !== workspaceId) {
              throw new DomainError('conflict', 'node_workspace_mismatch', `node ${id} belongs to a different workspace`);
            }
          } else {
            saveNode({
              id,
              workspace_id: workspaceId,
              tree_id: treeId,
              parent_node_id: parentId,
              kind: optionalString(payload.kind) ?? 'chat',
              title: optionalString(payload.title),
              status: 'idle',
              position_x: optionalNumber(payload.position_x),
              position_y: optionalNumber(payload.position_y),
              minimized: payload.minimized ? 1 : 0,
              deleted_at: optionalNumber(payload.deleted_at),
              deletion_group_id: optionalString(payload.deletion_group_id),
              spawned_by_agent: payload.spawned_by_agent ? 1 : 0,
              current_mode_id: optionalString(payload.current_mode_id),
              pane_width: optionalNumber(payload.pane_width),
              digest: optionalString(payload.digest),
              composer_draft: updatedComposerDraft(null, payload),
              trim_snapshot: optionalString(payload.trim_snapshot),
              pinned_at: optionalNumber(payload.pinned_at),
              created_at: optionalNumber(payload.created_at) ?? Date.now(),
            }, input.ownerUserId ?? undefined);
          }
          break;
        }
        case 'node.patch': {
          const node = getNode(id);
          if ('viewed_at' in payload) {
            const viewedAt = payload.viewed_at;
            if (typeof viewedAt !== 'number' || !Number.isFinite(viewedAt) || viewedAt <= 0) {
              throw new DomainError('invalid_argument', 'invalid_viewed_at', 'viewed_at must be a positive number');
            }
            // A view mark alone never fails the batch: the node may be gone or not yet written.
            if (Object.keys(payload).every((key) => key === 'id' || key === 'viewed_at')) {
              if (node && node.workspace_id === workspaceId) markNodeViewed(id, workspaceId, viewedAt);
              break;
            }
          }
          if (!node || node.workspace_id !== workspaceId) throw new DomainError('not_found', 'node_not_found', 'node not found');
          const effectiveTreeId = 'tree_id' in payload
            ? optionalString(payload.tree_id)
            : node.tree_id ?? null;
          const effectiveParentId = 'parent_node_id' in payload
            ? optionalString(payload.parent_node_id)
            : node.parent_node_id ?? null;
          assertNodePlacement(workspaceId, effectiveTreeId, effectiveParentId, nodePlacementRepository);
          const columns: Record<string, string> = {
            tree_id: 'tree_id', parent_node_id: 'parent_node_id', kind: 'kind',
            title: 'title', current_mode_id: 'current_mode_id', pane_width: 'pane_width',
            position_x: 'position_x', position_y: 'position_y', minimized: 'minimized',
            digest: 'digest', composer_draft: 'composer_draft', deleted_at: 'deleted_at',
            deletion_group_id: 'deletion_group_id', trim_snapshot: 'trim_snapshot',
            spawned_by_agent: 'spawned_by_agent', pinned_at: 'pinned_at',
          };
          const sets: string[] = [];
          const params: any[] = [];
          for (const [key, column] of Object.entries(columns)) {
            if (!(key in payload)) continue;
            sets.push(`${column} = ?`);
            const value = key === 'composer_draft' ? updatedComposerDraft(node.composer_draft, payload) : payload[key];
            params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null);
          }
          if (sets.length > 0) {
            params.push(id);
            getDb().prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
          }
          if (typeof payload.viewed_at === 'number') markNodeViewed(id, workspaceId, payload.viewed_at);
          break;
        }
        case 'edge.upsert': {
          if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'edge_workspace_mismatch', 'edge must belong to route workspace');
          assertEntityWorkspace('edges', id, workspaceId);
          const sourceNodeId = String(payload.source_node_id ?? '');
          const targetNodeId = String(payload.target_node_id ?? '');
          const source = getNode(sourceNodeId);
          const target = getNode(targetNodeId);
          if (!source || !target || source.workspace_id !== workspaceId || target.workspace_id !== workspaceId) {
            throw new DomainError('conflict', 'edge_workspace_mismatch', 'edge endpoints must belong to the same workspace');
          }
          const kind = optionalString(payload.kind) ?? 'branch';
          if ((kind === 'branch' || kind === 'link') && source.tree_id !== target.tree_id) {
            throw new DomainError('conflict', 'edge_tree_mismatch', `${kind} edge endpoints must belong to the same tree`);
          }
          saveEdge({
            id,
            workspace_id: workspaceId,
            source_node_id: sourceNodeId,
            target_node_id: targetNodeId,
            kind,
            anchor_message_id: optionalString(payload.anchor_message_id),
            created_at: optionalNumber(payload.created_at),
          }, input.ownerUserId ?? undefined);
          break;
        }
        case 'edge.delete':
          assertEntityWorkspace('edges', id, workspaceId);
          deleteEdge(id, input.ownerUserId ?? undefined);
          break;
        case 'context.upsert': {
          if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'context_workspace_mismatch', 'context must belong to route workspace');
          assertEntityWorkspace('contexts', id, workspaceId);
          const originNodeId = optionalString(payload.origin_node_id);
          if (originNodeId) {
            const originNode = getNode(originNodeId);
            if (!originNode || originNode.workspace_id !== workspaceId) {
              throw new DomainError('conflict', 'context_origin_workspace_mismatch', 'context origin node must belong to the same workspace');
            }
          }
          const originMessageId = optionalString(payload.origin_message_id);
          if (originMessageId) {
            const originMessage = getDb().prepare(`
              SELECT n.workspace_id FROM messages m JOIN nodes n ON n.id = m.node_id WHERE m.id = ?
            `).get(originMessageId) as { workspace_id: string } | undefined;
            if (!originMessage || originMessage.workspace_id !== workspaceId) {
              throw new DomainError('conflict', 'context_origin_workspace_mismatch', 'context origin message must belong to the same workspace');
            }
          }
          saveContext({
            id,
            workspace_id: workspaceId,
            name: String(payload.name ?? ''),
            file_path: String(payload.file_path ?? ''),
            size: optionalNumber(payload.size),
            auto_inject: 0,
            source: optionalString(payload.source) ?? 'user',
            type: optionalString(payload.type),
            url: optionalString(payload.url),
            origin_node_id: originNodeId,
            origin_message_id: originMessageId,
            kind: optionalString(payload.kind),
            pinned_at: optionalNumber(payload.pinned_at),
            created_at: optionalNumber(payload.created_at) ?? Date.now(),
            updated_at: optionalNumber(payload.updated_at) ?? Date.now(),
          } as ContextRow, input.ownerUserId ?? undefined);
          break;
        }
        case 'context.delete':
          assertEntityWorkspace('contexts', id, workspaceId);
          deleteContext(id, input.ownerUserId ?? undefined);
          break;
        default:
          throw new DomainError('invalid_argument', 'unsupported_workspace_command', `unsupported workspace command ${(command as WorkspaceCommand).type}`);
      }
      applied.push({ type: command.type, id });
    }

    for (const treeId of touchedTreeIds) {
      const tree = getDb().prepare('SELECT workspace_id, root_node_id FROM trees WHERE id = ?')
        .get(treeId) as { workspace_id: string; root_node_id: string } | undefined;
      if (!tree) continue;
      const root = getNode(tree.root_node_id);
      if (
        tree.workspace_id !== workspaceId
        || !root
        || root.workspace_id !== workspaceId
        || root.tree_id !== treeId
      ) {
        throw new DomainError('conflict', 'tree_root_mismatch', `tree ${treeId} root must belong to the same workspace and tree`);
      }
    }
    const workspace = getWorkspace(workspaceId);
    if (
      workspace?.active_tree_id
      && !listTrees(workspaceId).some((tree) => tree.id === workspace.active_tree_id)
    ) {
      throw new DomainError('conflict', 'active_tree_workspace_mismatch', 'active tree must belong to the same workspace');
    }

    getDb().prepare('UPDATE workspaces SET persistence_version = 2 WHERE id = ?').run(workspaceId);
    const result: ApplyWorkspaceCommandsResult = { operationId: input.operationId, applied };
    getDb().prepare(`
      INSERT INTO command_receipts (workspace_id, operation_id, payload_hash, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workspaceId, input.operationId, hash, JSON.stringify(result), Date.now());
    return result;
  });
}
