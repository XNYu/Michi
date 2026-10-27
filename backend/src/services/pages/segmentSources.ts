import { pageSegmentSources, type BlockSource, type PageBlockContent } from 'michi-shared';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError } from './core';

const key = (source: BlockSource) => JSON.stringify([source.nodeId, source.turnId, source.assistantId]);

/** Validate citations before planning writes; existing evidence stays readable even if its conversation later disappears. */
export function validateSegmentSourceReferences(workspaceId: string, ownerUserId: string, blocks: readonly PageBlockContent[], previous: readonly PageBlockContent[] = []): void {
  const known = new Set(previous.flatMap(pageSegmentSources).map(key));
  const find = getDb().prepare(`SELECT n.workspace_id,n.kind,n.deleted_at,n.purged_at,w.owner_user_id,w.deleted_at AS workspace_deleted,w.purged_at AS workspace_purged
    FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
    JOIN messages m ON m.id=t.assistant_message_id AND m.node_id=n.id AND m.role='assistant'
    WHERE t.turn_id=? AND n.id=? AND t.assistant_message_id=?`);
  for (const source of blocks.flatMap(pageSegmentSources)) {
    const identity = key(source);
    if (known.has(identity)) continue;
    const row = find.get(source.turnId, source.nodeId, source.assistantId) as {
      workspace_id: string; kind: string; deleted_at: number | null; purged_at: number | null;
      owner_user_id: string | null; workspace_deleted: number | null; workspace_purged: number | null;
    } | undefined;
    if (!row || row.workspace_id !== workspaceId || !workspaceOwnerMatches(row.owner_user_id, ownerUserId) || row.kind !== 'chat' ||
      row.deleted_at !== null || row.purged_at !== null || row.workspace_deleted !== null || row.workspace_purged !== null) {
      throw new PageWriteError(400, 'invalid', 'A segment source must identify an available assistant message in this page workspace');
    }
    known.add(identity);
  }
}

/** A scheduled incremental write may add only the evidence it acknowledged; retained page citations remain valid. */
export function validateMaintenanceSegmentSourceReferences(workspaceId: string, ownerUserId: string, blocks: readonly PageBlockContent[], previous: readonly PageBlockContent[], evidence: BlockSource): void {
  validateSegmentSourceReferences(workspaceId, ownerUserId, blocks, previous);
  const allowed = new Set([...previous.flatMap(pageSegmentSources), evidence].map(key));
  if (blocks.flatMap(pageSegmentSources).some(source => !allowed.has(key(source)))) {
    throw new PageWriteError(400, 'invalid', 'Maintenance segment sources must come from the acknowledged source or existing page evidence');
  }
}
