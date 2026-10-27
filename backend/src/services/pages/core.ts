import { randomUUID } from 'node:crypto';
import { isAssistantWorkspaceSettings, isSystemWorkspaceSettings, parseChangeSource, type BlockSource, type ChangeSource } from 'michi-shared';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';

export class PageWriteError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: 'not_found' | 'invalid' | 'stale_revision' | 'proposal_stale' | 'undo_conflict' | 'tasks_need_workspace' | 'task_board_needs_workspace',
    message: string,
  ) { super(message); this.name = 'PageWriteError'; }
}

export function newPageId(prefix: 'pg' | 'db' | 'row' | 'chg' | 'batch' | 'block' | 'column' | 'view' | 'del'): string {
  return `${prefix}-${randomUUID()}`;
}

let transactionSerial = 0;
/** Savepoints compose with the content transaction and internal receipt writers. */
export function pagesTransaction<T>(fn: () => T): T {
  const db = getDb();
  const name = `pages_${++transactionSerial}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

export interface PagesWorkspace {
  id: string; name: string; owner_user_id: string | null;
  deleted_at: number | null; archived_at: number | null; purged_at: number | null; settings: string | null;
}

export function requirePagesWorkspace(workspaceId: string, ownerUserId: string, write = false): PagesWorkspace {
  const workspace = getDb().prepare('SELECT id,name,owner_user_id,deleted_at,archived_at,purged_at,settings FROM workspaces WHERE id=?').get(workspaceId) as unknown as PagesWorkspace | undefined;
  if (!workspace || workspace.deleted_at !== null || workspace.purged_at !== null ||
    !workspaceOwnerMatches(workspace.owner_user_id, ownerUserId) ||
    (isSystemWorkspaceSettings(workspace.settings) && !hostsSpacesHome(workspace.id, ownerUserId))) {
    throw new PageWriteError(404, 'not_found', 'Workspace not found');
  }
  if (write && workspace.archived_at !== null) throw new PageWriteError(409, 'invalid', 'Archived workspace is read-only');
  return workspace;
}

/**
 * A system workspace is a Pages workspace only for the owner whose Spaces Home
 * it holds, so page edits and change records work on that one page while the
 * workspace stays out of every user-facing list.
 */
function hostsSpacesHome(workspaceId: string, ownerUserId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM pages WHERE workspace_id=? AND owner_user_id=? AND role='spaces-home'").get(workspaceId, ownerUserId);
}

/** Resource views, including their ancestors, change independently of content CAS. */
export function invalidatePages(pageIds: readonly string[], now: number, actor: 'user' | 'agent'): void {
  const db = getDb();
  const seen = new Set<string>();
  const pending = [...pageIds];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = db.prepare('SELECT parent_id FROM pages WHERE id=?').get(id) as { parent_id: string | null } | undefined;
    if (!row) continue;
    db.prepare('UPDATE pages SET view_version=view_version+1,updated_at=?,updated_by=? WHERE id=?').run(now, actor, id);
    if (row.parent_id) pending.push(row.parent_id);
  }
}

export function invalidateDatabasePages(databaseId: string, now: number, actor: 'user' | 'agent'): void {
  const rows = getDb().prepare('SELECT page_id FROM page_database_refs WHERE database_id=?').all(databaseId) as unknown as { page_id: string }[];
  invalidatePages(rows.map(row => row.page_id), now, actor);
}

export type ChatChangeSource = BlockSource & { kind: 'chat' | 'helper' };

/**
 * Ordinary tools cannot choose a different execution turn, helper or workspace.
 * The one source from outside the page's workspace is the owner's Meta agent
 * chat (the assistant's hidden workspace), which edits pages in every workspace.
 */
export function requireChatChangeSource(workspaceId: string, ownerUserId: string, source: ChatChangeSource, pageId?: string): void {
  requirePagesWorkspace(workspaceId, ownerUserId, true);
  if (!parseChangeSource(source) || (source.kind !== 'chat' && source.kind !== 'helper')) {
    throw new PageWriteError(400, 'invalid', 'Invalid chat source');
  }
  const row = getDb().prepare(`SELECT n.workspace_id,n.page_id,n.kind,n.status AS node_status,n.deleted_at,n.purged_at,
    tr.archived_at,t.status,t.assistant_message_id,w.settings AS workspace_settings,w.owner_user_id AS workspace_owner
    FROM turns t JOIN nodes n ON n.id=t.node_id JOIN workspaces w ON w.id=n.workspace_id
    LEFT JOIN trees tr ON tr.id=n.tree_id WHERE t.turn_id=? AND n.id=?`).get(source.turnId, source.nodeId) as {
      workspace_id: string; page_id: string | null; kind: string; node_status: string;
      deleted_at: number | null; purged_at: number | null; archived_at: number | null; status: string; assistant_message_id: string;
      workspace_settings: string | null; workspace_owner: string | null;
    } | undefined;
  const metaAgentChat = !!row && source.kind === 'chat' && process.env.MICHI_CLOUD !== '1' &&
    isAssistantWorkspaceSettings(row.workspace_settings) && workspaceOwnerMatches(row.workspace_owner, ownerUserId);
  // An explicit Chat Home binding is owner-wide, but grants no authority to
  // other pages or databases in the selected Page's workspace.
  const chatHome = !!row && !!pageId && workspaceOwnerMatches(row.workspace_owner, ownerUserId) &&
    !!getDb().prepare(`SELECT 1 FROM home_customization h JOIN pages p ON p.id=json_extract(h.preferences,'$.pageId')
      WHERE h.owner_user_id=? AND p.id=? AND p.workspace_id=? AND p.owner_user_id=? AND p.deleted_at IS NULL`)
      .get(ownerUserId, pageId, workspaceId, ownerUserId);
  if (chatHome) requirePagesWorkspace(row!.workspace_id, ownerUserId, true);
  if (!row || (row.workspace_id !== workspaceId && !metaAgentChat && !chatHome) || row.kind !== 'chat' || row.deleted_at !== null ||
    row.purged_at !== null || row.archived_at !== null || row.node_status === 'archived' || row.status !== 'active' ||
    row.assistant_message_id !== source.assistantId || (row.page_id !== null) !== (source.kind === 'helper')) {
    throw new PageWriteError(404, 'not_found', 'Active chat source not found');
  }
}

/**
 * The conversation a change came from. A maintenance change came from the conversation it read, not from the run
 * that wrote it; one that says what its run read but cites no message (`read`) came from no single conversation.
 */
export function sourceNodeId(source: ChangeSource): string | null {
  if (source.kind === 'maintenance') return source.evidence[0]?.nodeId ?? (source.read ? null : source.nodeId);
  return source.kind === 'chat' || source.kind === 'helper' ? source.nodeId : null;
}

export function assertPageRequestSize(value: unknown): void {
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new PageWriteError(400, 'invalid', 'Invalid payload'); }
  if (!json || Buffer.byteLength(json, 'utf8') > 1_048_576) throw new PageWriteError(400, 'invalid', 'Page request exceeds 1 MB');
}
