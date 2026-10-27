import { parseWorkflowRunDto, type WorkflowRunDtoV1 } from 'michi-shared';
import { getDb } from './db';
import { workspaceOwnerMatches } from './agentOwner';

/**
 * Durable workflow-run snapshots. Every query is scoped by owner; listing
 * also checks the workspace belongs to the owner.
 */
export interface WorkflowRunRecord {
  ownerUserId: string;
  run: WorkflowRunDtoV1;
}

export interface WorkflowRunStore {
  upsert(ownerUserId: string, run: WorkflowRunDtoV1): void;
  get(ownerUserId: string, id: string): WorkflowRunDtoV1 | null;
  list(ownerUserId: string, workspaceId: string, limit: number): WorkflowRunDtoV1[];
  /**
   * Runs a previous process still drove (the runtime that drove them is
   * gone): open ones, and finished ones stored with actions or approvals.
   */
  listOpen(): WorkflowRunRecord[];
  workspaceOwnedBy(ownerUserId: string, workspaceId: string): boolean;
  workspaceOfNode(nodeId: string): string | null;
}

function parseRow(row: { run_json: string } | undefined): WorkflowRunDtoV1 | null {
  if (!row) return null;
  try { return parseWorkflowRunDto(JSON.parse(row.run_json)); } catch { return null; }
}

export class SqliteWorkflowRunStore implements WorkflowRunStore {
  upsert(ownerUserId: string, run: WorkflowRunDtoV1): void {
    getDb().prepare(`
      INSERT INTO workflow_runs (id, owner_user_id, workspace_id, node_id, runtime, native_id, status, run_json, started_at, updated_at)
      VALUES (?, ?, ?, (SELECT id FROM nodes WHERE id = ?), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        run_json = excluded.run_json,
        node_id = COALESCE(excluded.node_id, workflow_runs.node_id),
        updated_at = excluded.updated_at
      WHERE workflow_runs.owner_user_id = excluded.owner_user_id
    `).run(
      run.id, ownerUserId, run.workspaceId, run.nodeId, run.runtime, run.nativeId, run.status,
      JSON.stringify(run), run.startedAt, run.updatedAt,
    );
  }

  get(ownerUserId: string, id: string): WorkflowRunDtoV1 | null {
    return parseRow(getDb().prepare('SELECT run_json FROM workflow_runs WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId) as { run_json: string } | undefined);
  }

  list(ownerUserId: string, workspaceId: string, limit: number): WorkflowRunDtoV1[] {
    const rows = getDb().prepare(`
      SELECT run_json FROM workflow_runs
      WHERE owner_user_id = ? AND workspace_id = ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(ownerUserId, workspaceId, Math.max(1, Math.min(limit, 500))) as Array<{ run_json: string }>;
    return rows.flatMap((row) => { const run = parseRow(row); return run ? [run] : []; });
  }

  listOpen(): WorkflowRunRecord[] {
    // json_valid guards the JSON reads: one malformed row must not make the
    // whole query throw (and recovery skip every run).
    const rows = getDb().prepare(`
      SELECT owner_user_id, run_json FROM workflow_runs
      WHERE status IN ('running', 'paused')
         OR CASE WHEN json_valid(run_json)
              THEN COALESCE(json_array_length(run_json, '$.actions'), 0)
                 + COALESCE(json_array_length(run_json, '$.approvals'), 0)
              ELSE 0 END > 0
    `).all() as Array<{ owner_user_id: string; run_json: string }>;
    return rows.flatMap((row) => {
      const run = parseRow(row);
      return run ? [{ ownerUserId: row.owner_user_id, run }] : [];
    });
  }

  workspaceOwnedBy(ownerUserId: string, workspaceId: string): boolean {
    const row = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId) as { owner_user_id: string | null } | undefined;
    return !!row && workspaceOwnerMatches(row.owner_user_id, ownerUserId);
  }

  workspaceOfNode(nodeId: string): string | null {
    const row = getDb().prepare('SELECT workspace_id FROM nodes WHERE id = ?').get(nodeId) as { workspace_id: string } | undefined;
    return row?.workspace_id ?? null;
  }
}
