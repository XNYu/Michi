import { createHash, randomUUID } from 'node:crypto';
import {
  AgentDefinitionStatus,
  parseAgentDefinitionDtoV1,
  type AgentDefinitionDtoV1,
  type CreateAgentDefinitionRequestV1,
  type UpdateAgentDefinitionRequestV1,
} from 'michi-shared';
import { getDb, runInTransaction } from './db';
import { workspaceOwnerMatches } from './agentOwner';
import type { AgentCapabilityCatalog } from './agentCapabilityCatalog';
import { assertAgentOwnerWritable } from './agentOwnerDeletionGate';

export interface AgentDefinitionRepositoryDeps {
  now?: () => number;
  createId?: () => string;
  capabilityCatalog?: AgentCapabilityCatalog;
}

type DefinitionRow = {
  id: string; owner_user_id: string; scope: 'global' | 'workspace'; workspace_id: string | null;
  name: string; description: string; instructions: string; runtime_profile: string;
  fallback_chain: string; tool_refs: string; skill_refs: string; mcp_server_refs: string;
  permission_policy: string | null; context_policy: string; default_run_ttl_ms: number | null;
  status: AgentDefinitionStatus; revision: number; created_at: number; updated_at: number;
};

function requireOwner(ownerUserId: string): void {
  if (!ownerUserId?.trim()) throw new Error('ownerUserId is required');
}

function encodeList(values: readonly string[]): string {
  return JSON.stringify({ version: 1, values });
}

function decodeList(value: string): string[] {
  const parsed = JSON.parse(value) as { values?: unknown };
  return Array.isArray(parsed.values) ? parsed.values.filter((item): item is string => typeof item === 'string') : [];
}

function rowToDto(row: DefinitionRow): AgentDefinitionDtoV1 {
  return parseAgentDefinitionDtoV1({
    version: 1, id: row.id, ownerUserId: row.owner_user_id, scope: row.scope,
    workspaceId: row.workspace_id, name: row.name, description: row.description,
    instructions: row.instructions, runtimeProfile: JSON.parse(row.runtime_profile),
    fallbackChain: (JSON.parse(row.fallback_chain) as { profiles?: unknown[] }).profiles ?? [],
    toolRefs: decodeList(row.tool_refs), skillRefs: decodeList(row.skill_refs),
    mcpServerRefs: decodeList(row.mcp_server_refs),
    permissionPolicy: row.permission_policy ? JSON.parse(row.permission_policy) : null,
    contextPolicy: JSON.parse(row.context_policy), defaultRunTtlMs: row.default_run_ttl_ms,
    status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function operationHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class AgentDefinitionsRepository {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly catalog?: AgentCapabilityCatalog;

  constructor(deps: AgentDefinitionRepositoryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? (() => `agent-${randomUUID()}`);
    this.catalog = deps.capabilityCatalog;
  }

  private assertWorkspaceOwner(ownerUserId: string, workspaceId: string | null): void {
    if (workspaceId === null) return;
    const row = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId) as { owner_user_id: string | null } | undefined;
    if (!row || !workspaceOwnerMatches(row.owner_user_id, ownerUserId)) throw new Error('workspace not found');
  }

  private idempotent<T>(ownerUserId: string, workspaceId: string | null, operationId: string, payload: unknown, fn: () => T): T {
    if (!operationId?.trim()) throw new Error('operationId is required');
    const ledgerWorkspace = workspaceId ?? `__agent_global__:${ownerUserId}`;
    const key = `agent-definition:${operationId}`;
    const hash = operationHash(payload);
    const prior = getDb().prepare('SELECT payload_hash, result_json FROM command_receipts WHERE workspace_id = ? AND operation_id = ?')
      .get(ledgerWorkspace, key) as { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== hash) throw new Error(`operation ${operationId} was reused with a different payload`);
      return JSON.parse(prior.result_json) as T;
    }
    const result = fn();
    getDb().prepare('INSERT INTO command_receipts (workspace_id, operation_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ledgerWorkspace, key, hash, JSON.stringify(result), this.now());
    return result;
  }

  create(ownerUserId: string, request: CreateAgentDefinitionRequestV1, operationId: string): AgentDefinitionDtoV1 {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      assertAgentOwnerWritable(ownerUserId, this.now());
      this.assertWorkspaceOwner(ownerUserId, request.workspaceId);
      return this.idempotent(ownerUserId, request.workspaceId, operationId, request, () => {
      const now = this.now();
      const dto = parseAgentDefinitionDtoV1({
        ...request, id: this.createId(), ownerUserId, status: AgentDefinitionStatus.Draft,
        revision: 1, createdAt: now, updatedAt: now,
      });
      getDb().prepare(`INSERT INTO agent_definitions (
        id, owner_user_id, scope, workspace_id, name, description, instructions,
        runtime_profile, fallback_chain, tool_refs, skill_refs, mcp_server_refs,
        permission_policy, context_policy, default_run_ttl_ms, status, revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        dto.id, dto.ownerUserId, dto.scope, dto.workspaceId, dto.name, dto.description,
        dto.instructions, JSON.stringify(dto.runtimeProfile), JSON.stringify({ version: 1, profiles: dto.fallbackChain }),
        encodeList(dto.toolRefs), encodeList(dto.skillRefs), encodeList(dto.mcpServerRefs),
        dto.permissionPolicy ? JSON.stringify(dto.permissionPolicy) : null, JSON.stringify(dto.contextPolicy),
        dto.defaultRunTtlMs, dto.status, dto.revision, dto.createdAt, dto.updatedAt,
      );
        return dto;
      });
    });
  }

  get(ownerUserId: string, id: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    const row = getDb().prepare('SELECT * FROM agent_definitions WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId) as DefinitionRow | undefined;
    return row ? rowToDto(row) : null;
  }

  list(ownerUserId: string, workspaceId: string | null, enabledOnly = false): AgentDefinitionDtoV1[] {
    requireOwner(ownerUserId);
    this.assertWorkspaceOwner(ownerUserId, workspaceId);
    const rows = getDb().prepare(`SELECT * FROM agent_definitions
      WHERE owner_user_id = ? AND (workspace_id IS NULL OR workspace_id = ?)
        AND (? = 0 OR status = 'enabled') ORDER BY scope, name COLLATE NOCASE, id`)
      .all(ownerUserId, workspaceId, enabledOnly ? 1 : 0) as DefinitionRow[];
    return rows.map(rowToDto);
  }

  update(ownerUserId: string, id: string, request: UpdateAgentDefinitionRequestV1, operationId: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      assertAgentOwnerWritable(ownerUserId, this.now());
      return this.idempotent(ownerUserId, null, operationId, { id, request }, () => {
      const current = this.get(ownerUserId, id);
      if (!current) return null;
      if (current.revision !== request.expectedRevision) throw new Error('definition revision conflict');
      const candidate = parseAgentDefinitionDtoV1({
        ...current, ...request, version: 1, id, ownerUserId, status: current.status,
        revision: current.revision + 1, createdAt: current.createdAt, updatedAt: this.now(),
      });
      this.assertWorkspaceOwner(ownerUserId, candidate.workspaceId);
      const result = getDb().prepare(`UPDATE agent_definitions SET
        scope = ?, workspace_id = ?, name = ?, description = ?, instructions = ?,
        runtime_profile = ?, fallback_chain = ?, tool_refs = ?, skill_refs = ?,
        mcp_server_refs = ?, permission_policy = ?, context_policy = ?,
        default_run_ttl_ms = ?, revision = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND revision = ?`).run(
        candidate.scope, candidate.workspaceId, candidate.name, candidate.description,
        candidate.instructions, JSON.stringify(candidate.runtimeProfile),
        JSON.stringify({ version: 1, profiles: candidate.fallbackChain }), encodeList(candidate.toolRefs),
        encodeList(candidate.skillRefs), encodeList(candidate.mcpServerRefs),
        candidate.permissionPolicy ? JSON.stringify(candidate.permissionPolicy) : null,
        JSON.stringify(candidate.contextPolicy), candidate.defaultRunTtlMs, candidate.revision,
        candidate.updatedAt, id, ownerUserId, request.expectedRevision,
      );
      if (Number(result.changes) !== 1) throw new Error('definition revision conflict');
      return candidate;
      });
    });
  }

  setStatus(ownerUserId: string, id: string, status: AgentDefinitionStatus, expectedRevision: number, operationId: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    if (status === AgentDefinitionStatus.Draft) throw new Error('published status can only be enabled or disabled');
    return runInTransaction(() => {
      assertAgentOwnerWritable(ownerUserId, this.now());
      return this.idempotent(ownerUserId, null, operationId, { id, status, expectedRevision }, () => {
      const current = this.get(ownerUserId, id);
      if (!current) return null;
      if (current.revision !== expectedRevision) throw new Error('definition revision conflict');
      if (status === AgentDefinitionStatus.Enabled) {
        if (!this.catalog) throw new Error('capability catalog is required to enable a definition');
        this.catalog.assertRuntimeReady(current.runtimeProfile.runtimeId);
        this.catalog.resolve({
          ownerUserId, workspaceId: current.workspaceId, definitionScope: current.scope,
          toolRefs: current.toolRefs, skillRefs: current.skillRefs, mcpServerRefs: current.mcpServerRefs,
        });
      }
      const updatedAt = this.now();
      const result = getDb().prepare(`UPDATE agent_definitions SET status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND revision = ?`).run(status, updatedAt, id, ownerUserId, expectedRevision);
      if (Number(result.changes) !== 1) throw new Error('definition revision conflict');
      return this.get(ownerUserId, id)!;
      });
    });
  }

  enable(ownerUserId: string, id: string, expectedRevision: number, operationId: string): AgentDefinitionDtoV1 | null {
    return this.setStatus(ownerUserId, id, AgentDefinitionStatus.Enabled, expectedRevision, operationId);
  }

  disable(ownerUserId: string, id: string, expectedRevision: number, operationId: string): AgentDefinitionDtoV1 | null {
    return this.setStatus(ownerUserId, id, AgentDefinitionStatus.Disabled, expectedRevision, operationId);
  }

  duplicate(ownerUserId: string, id: string, workspaceId: string | null, operationId: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    const source = this.get(ownerUserId, id);
    if (!source) return null;
    return this.create(ownerUserId, {
      version: 1, scope: workspaceId === null ? 'global' : 'workspace', workspaceId,
      name: source.name, description: source.description, instructions: source.instructions,
      runtimeProfile: source.runtimeProfile, fallbackChain: source.fallbackChain,
      toolRefs: source.toolRefs, skillRefs: source.skillRefs, mcpServerRefs: source.mcpServerRefs,
      permissionPolicy: source.permissionPolicy, contextPolicy: source.contextPolicy,
      defaultRunTtlMs: source.defaultRunTtlMs,
    }, `duplicate:${operationId}`);
  }

  delete(ownerUserId: string, id: string, operationId: string): boolean {
    requireOwner(ownerUserId);
    return runInTransaction(() => {
      assertAgentOwnerWritable(ownerUserId, this.now());
      return this.idempotent(ownerUserId, null, operationId, { id }, () =>
        Number(getDb().prepare('DELETE FROM agent_definitions WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId).changes) === 1);
    });
  }
}
