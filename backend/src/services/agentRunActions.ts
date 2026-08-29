import { createHash, randomUUID } from 'node:crypto';
import {
  AgentDefinitionStatus,
  type AgentDefinitionDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
  type CreateAgentDefinitionRequestV1,
} from 'michi-shared';
import { runInTransaction, getDb } from './db';
import { AgentRunsRepository } from './agentRunsRepository';
import { AgentDefinitionService } from './agentDefinitionService';
import { workspaceOwnerMatches } from './agentOwner';

export type AgentRunContinueFallback = 'error' | 'new_thread';

export interface ContinueAgentRunRequestV1 {
  version: 1;
  workspaceId: string;
  includeTask: boolean;
  includeResult: boolean;
  includeTranscript: boolean;
  fallback: AgentRunContinueFallback;
}

export interface ContinueAgentRunResultV1 {
  version: 1;
  runId: string;
  workspaceId: string;
  nodeId: string;
  treeId: string;
  parentNodeId: string | null;
  mode: 'branch' | 'new_thread';
  imported: { task: boolean; result: boolean; transcript: boolean };
}

export interface SaveAgentRunAsDefinitionRequestV1 {
  version: 1;
  workspaceId: string;
  name?: string;
}

export interface SaveAgentRunAsDefinitionResultV1 {
  version: 1;
  runId: string;
  definition: AgentDefinitionDtoV1;
}

export class AgentRunActionError extends Error {
  constructor(readonly code: 'not_found' | 'parent_unavailable' | 'invalid_action', message: string) {
    super(message);
    this.name = 'AgentRunActionError';
  }
}

interface RunSource {
  getRun(ownerUserId: string, runId: string): AgentRunDtoV1 | null;
  listEvents(ownerUserId: string, runId: string, afterSeq?: number, limit?: number): AgentRunEventV1[];
}

interface DefinitionCreator {
  create(ownerUserId: string, request: CreateAgentDefinitionRequestV1, operationId?: string): Promise<AgentDefinitionDtoV1>;
}

export interface AgentRunActionsDeps {
  runs?: RunSource;
  definitions?: DefinitionCreator;
  now?: () => number;
  nextId?: (kind: 'node' | 'tree' | 'edge') => string;
}

export class AgentRunActionsService {
  private readonly runs: RunSource;
  private readonly definitions: DefinitionCreator;
  private readonly now: () => number;
  private readonly nextId: (kind: 'node' | 'tree' | 'edge') => string;

  constructor(deps: AgentRunActionsDeps = {}) {
    this.runs = deps.runs ?? new AgentRunsRepository();
    this.definitions = deps.definitions ?? new AgentDefinitionService();
    this.now = deps.now ?? Date.now;
    this.nextId = deps.nextId ?? ((kind) => `${kind[0]}-${randomUUID()}`);
  }

  continueAsBranch(ownerUserId: string, runId: string, request: ContinueAgentRunRequestV1,
    operationId: string): ContinueAgentRunResultV1 {
    const run = this.requireRun(ownerUserId, runId, request.workspaceId);
    if (!request.includeTask && !request.includeResult && !request.includeTranscript) {
      throw new AgentRunActionError('invalid_action', 'Select at least one Run context item to import.');
    }
    const parent = this.resolveParent(ownerUserId, run);
    if (!parent && request.fallback === 'error') {
      throw new AgentRunActionError('parent_unavailable',
        'The Parent conversation is unavailable. Continue as a new thread instead.');
    }
    const events = request.includeTranscript ? this.runs.listEvents(ownerUserId, runId, -1, 1_000) : [];
    const prompt = buildContinuationPrompt(run, events, request);
    const receiptOperationId = `agent-run-action:continue:${operationId}`;
    const receiptPayload = { runId, request };
    return runInTransaction(() => {
      const replay = readReceipt<ContinueAgentRunResultV1>(request.workspaceId, receiptOperationId, receiptPayload);
      if (replay) return replay;
      const workspace = ownedWorkspace(ownerUserId, request.workspaceId);
      const now = this.now();
      const nodeId = this.nextId('node');
      const treeId = parent?.treeId ?? this.nextId('tree');
      const edgeId = parent ? this.nextId('edge') : null;
      if (!parent) {
        getDb().prepare(`INSERT INTO trees (id, workspace_id, root_node_id, name, last_active_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(treeId, workspace.id, nodeId, `Run · ${run.effectiveDefinition.name}`, now, now);
      }
      getDb().prepare(`INSERT INTO nodes (
        id, workspace_id, tree_id, parent_node_id, kind, title, status, minimized,
        spawned_by_agent, composer_draft, created_at
      ) VALUES (?, ?, ?, ?, 'chat', ?, 'idle', 0, 0, ?, ?)`).run(
        nodeId, workspace.id, treeId, parent?.nodeId ?? null,
        `Continue · ${run.effectiveDefinition.name}`,
        JSON.stringify({ value: prompt, mentions: [] }), now,
      );
      if (parent && edgeId) {
        getDb().prepare(`INSERT INTO edges (
          id, workspace_id, source_node_id, target_node_id, kind, anchor_message_id, created_at
        ) VALUES (?, ?, ?, ?, 'branch', ?, ?)`).run(
          edgeId, workspace.id, parent.nodeId, nodeId, run.parentMessageId, now,
        );
      }
      getDb().prepare('UPDATE trees SET last_active_at = ? WHERE id = ? AND workspace_id = ?')
        .run(now, treeId, workspace.id);
      getDb().prepare('UPDATE workspaces SET active_tree_id = ?, persistence_version = 2 WHERE id = ?')
        .run(treeId, workspace.id);
      const result: ContinueAgentRunResultV1 = {
        version: 1, runId, workspaceId: workspace.id, nodeId, treeId,
        parentNodeId: parent?.nodeId ?? null, mode: parent ? 'branch' : 'new_thread',
        imported: { task: request.includeTask, result: request.includeResult, transcript: request.includeTranscript },
      };
      writeReceipt(workspace.id, receiptOperationId, receiptPayload, result, now);
      return result;
    });
  }

  async saveAsAgent(ownerUserId: string, runId: string, request: SaveAgentRunAsDefinitionRequestV1,
    operationId: string): Promise<SaveAgentRunAsDefinitionResultV1> {
    const run = this.requireRun(ownerUserId, runId, request.workspaceId);
    if (run.definitionId !== null) {
      throw new AgentRunActionError('invalid_action', 'Only an ephemeral Run can be saved as a new Custom Agent Draft.');
    }
    const snapshot = structuredClone(run.effectiveDefinition);
    const refs = snapshot.capabilitySnapshot.entries;
    const createRequest: CreateAgentDefinitionRequestV1 = {
      version: 1,
      scope: 'workspace',
      workspaceId: request.workspaceId,
      name: request.name?.trim() || snapshot.name,
      description: snapshot.description,
      instructions: snapshot.instructions,
      runtimeProfile: snapshot.runtimeProfile,
      fallbackChain: snapshot.fallbackChain,
      toolRefs: refs.filter((entry) => entry.kind === 'tool').map((entry) => entry.id),
      skillRefs: refs.filter((entry) => entry.kind === 'skill').map((entry) => entry.id),
      mcpServerRefs: refs.filter((entry) => entry.kind === 'mcp_server').map((entry) => entry.id),
      permissionPolicy: snapshot.permissionPolicy,
      contextPolicy: snapshot.contextPolicy,
      defaultRunTtlMs: null,
    };
    const definition = await this.definitions.create(ownerUserId, createRequest,
      `agent-run-action:save:${runId}:${operationId}`);
    if (definition.status !== AgentDefinitionStatus.Draft) {
      throw new Error('Save-as-Agent must create a Draft Definition');
    }
    return { version: 1, runId, definition };
  }

  private requireRun(ownerUserId: string, runId: string, workspaceId: string): AgentRunDtoV1 {
    const run = this.runs.getRun(ownerUserId, runId);
    if (!run || run.workspaceId !== workspaceId || !ownedWorkspaceOrNull(ownerUserId, workspaceId)) {
      throw new AgentRunActionError('not_found', 'Agent Run not found.');
    }
    return run;
  }

  private resolveParent(ownerUserId: string, initial: AgentRunDtoV1): { nodeId: string; treeId: string } | null {
    let run: AgentRunDtoV1 | null = initial;
    const seen = new Set<string>();
    while (run && !seen.has(run.id)) {
      seen.add(run.id);
      if (run.parentNodeId) {
        const row = getDb().prepare(`SELECT n.id, n.tree_id, w.owner_user_id FROM nodes n
          JOIN workspaces w ON w.id = n.workspace_id
          JOIN trees t ON t.id = n.tree_id AND t.workspace_id = n.workspace_id
          WHERE n.id = ? AND n.workspace_id = ? AND n.deleted_at IS NULL
            AND n.purged_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL
            AND t.archived_at IS NULL`).get(
          run.parentNodeId, initial.workspaceId,
        ) as { id: string; tree_id: string | null; owner_user_id: string | null } | undefined;
        if (row?.tree_id && workspaceOwnerMatches(row.owner_user_id, ownerUserId)) {
          return { nodeId: row.id, treeId: row.tree_id };
        }
        return null;
      }
      run = run.parentRunId ? this.runs.getRun(ownerUserId, run.parentRunId) : null;
    }
    return null;
  }
}

function ownedWorkspaceOrNull(ownerUserId: string, workspaceId: string): { id: string } | null {
  const row = getDb().prepare('SELECT id, owner_user_id FROM workspaces WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL')
    .get(workspaceId) as { id: string; owner_user_id: string | null } | undefined;
  if (!row) return null;
  if (!workspaceOwnerMatches(row.owner_user_id, ownerUserId)) return null;
  return { id: row.id };
}

function ownedWorkspace(ownerUserId: string, workspaceId: string): { id: string } {
  const workspace = ownedWorkspaceOrNull(ownerUserId, workspaceId);
  if (!workspace) throw new AgentRunActionError('not_found', 'Workspace not found.');
  return workspace;
}

function buildContinuationPrompt(run: AgentRunDtoV1, events: AgentRunEventV1[], request: ContinueAgentRunRequestV1): string {
  const sections = [
    `Continue from durable Agent Run ${run.id} (${run.effectiveDefinition.name}).`,
    'This is a separate ordinary conversation branch. Use the selected material below as reference; do not imply that the Run transcript became Branch history.',
  ];
  if (request.includeTask) sections.push(`## Selected Run task\n${run.task}`);
  if (request.includeResult) sections.push(`## Selected Result Bundle\n${run.resultBundle ? JSON.stringify(run.resultBundle) : `No Result Bundle was recorded. Run status: ${run.status}.`}`);
  if (request.includeTranscript) {
    const transcript = events.map((event) => `[${event.seq} ${event.type}] ${JSON.stringify(event.payload)}`).join('\n').slice(0, 32_000);
    sections.push(`## Selected Run transcript\n${transcript || 'No transcript events were recorded.'}`);
  }
  return sections.join('\n\n');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function receiptHash(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function readReceipt<T>(workspaceId: string, operationId: string, payload: unknown): T | null {
  const row = getDb().prepare('SELECT payload_hash, result_json FROM command_receipts WHERE workspace_id = ? AND operation_id = ?')
    .get(workspaceId, operationId) as { payload_hash: string; result_json: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== receiptHash(payload)) throw new Error(`operation ${operationId} was reused with a different payload`);
  return JSON.parse(row.result_json) as T;
}

function writeReceipt(workspaceId: string, operationId: string, payload: unknown, result: unknown, now: number): void {
  getDb().prepare(`INSERT INTO command_receipts (workspace_id, operation_id, payload_hash, result_json, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(workspaceId, operationId, receiptHash(payload), JSON.stringify(result), now);
}
