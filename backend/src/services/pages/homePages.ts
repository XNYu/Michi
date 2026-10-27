import { applyUserPageEdits } from './pageWrites';
import { createHash } from 'node:crypto';
import {
  PAGE_LIMITS, isSystemWorkspaceSettings, pageBlockText, parsePageBlock,
  type SpacesHomeDto, type WorkspaceHomeDto, type WorkspaceHomeSummaryDto,
} from 'michi-shared';
import { ensureAssistant } from '../../assistant/store';
import { getDb } from '../db';
import { workspaceOwnerMatches } from '../agentOwner';
import { PageWriteError, invalidatePages, pagesTransaction, requirePagesWorkspace } from './core';
import { getPage, insertHomePage, pageRecord, pendingProposalCount } from './repository';
import { parseLayoutRules } from './layoutRules';
import { getFirstRun, listFirstRuns } from './firstRun';
import { firstRunWindowDays } from '../metaAgent/firstRunHistory';

/** `settings.system` of the workspace that holds a Spaces Home where no assistant workspace can (cloud). */
export const SPACES_SYSTEM_WORKSPACE = 'spaces';
export const SPACES_HOME_TITLE = 'Home';
const SPACES_WORKSPACE_NAME = 'Spaces';

type HomeRow = { id: string; workspace_id: string; owner_user_id: string; deleted_at: number | null };
type WorkspaceRow = {
  id: string; name: string; owner_user_id: string | null; settings: string | null;
  deleted_at: number | null; archived_at: number | null; purged_at: number | null;
};

const db = () => getDb();
const isUniqueRace = (error: unknown, index: string): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed') && error.message.includes(index);

function requireOwner(ownerUserId: string): void {
  if (typeof ownerUserId !== 'string' || !ownerUserId.trim()) throw new PageWriteError(404, 'not_found', 'Resource not found');
}

function workspaceRow(workspaceId: string): WorkspaceRow | undefined {
  return db().prepare('SELECT id,name,owner_user_id,settings,deleted_at,archived_at,purged_at FROM workspaces WHERE id=?').get(workspaceId) as WorkspaceRow | undefined;
}

function liveSystemWorkspace(workspaceId: string, ownerUserId: string): boolean {
  const row = workspaceRow(workspaceId);
  return !!row && row.deleted_at === null && row.purged_at === null &&
    workspaceOwnerMatches(row.owner_user_id, ownerUserId) && isSystemWorkspaceSettings(row.settings);
}

/**
 * One per owner, with a deterministic id so concurrent first uses converge on
 * one row. The marker is server-owned: workspace writes never set or drop it
 * (mergeServerOwnedSettings), so it is written here directly.
 */
function ensureSpacesSystemWorkspace(ownerUserId: string, now: number): string {
  const id = `p-spaces-${createHash('sha256').update(ownerUserId).digest('hex').slice(0, 32)}`;
  db().prepare(`INSERT OR IGNORE INTO workspaces(id,name,created_at,updated_at,settings,owner_user_id) VALUES(?,?,?,?,?,?)`)
    .run(id, SPACES_WORKSPACE_NAME, now, now, JSON.stringify({ system: SPACES_SYSTEM_WORKSPACE }), ownerUserId);
  // A client can trash any workspace by id; the hidden one comes back on next use.
  db().prepare(`UPDATE workspaces SET deleted_at=NULL,purged_at=NULL,updated_at=? WHERE id=? AND owner_user_id=? AND (deleted_at IS NOT NULL OR purged_at IS NOT NULL)`)
    .run(now, id, ownerUserId);
  if (!liveSystemWorkspace(id, ownerUserId)) throw new PageWriteError(404, 'not_found', 'Spaces workspace not available');
  return id;
}

/** The hidden system workspace holding the owner's Spaces Home: the assistant's where one can exist, else a dedicated one. */
function spacesHomeHost(ownerUserId: string, now: number): string {
  if (process.env.MICHI_CLOUD !== '1') {
    const { workspaceId } = ensureAssistant();
    if (liveSystemWorkspace(workspaceId, ownerUserId)) return workspaceId;
  }
  return ensureSpacesSystemWorkspace(ownerUserId, now);
}

function spacesHomeRow(ownerUserId: string): HomeRow | undefined {
  return db().prepare("SELECT id,workspace_id,owner_user_id,deleted_at FROM pages WHERE owner_user_id=? AND role='spaces-home'").get(ownerUserId) as HomeRow | undefined;
}

function undelete(pageId: string): void {
  db().prepare('UPDATE pages SET deleted_at=NULL,deletion_group_id=NULL WHERE id=? AND deleted_at IS NOT NULL').run(pageId);
}

/** The owner's Spaces Home page id, created on first use. Idempotent; the unique role index settles races. */
export function ensureSpacesHomePageId(ownerUserId: string, now = Date.now()): string {
  requireOwner(ownerUserId);
  const existing = spacesHomeRow(ownerUserId);
  if (existing && existing.deleted_at === null && liveSystemWorkspace(existing.workspace_id, ownerUserId)) return existing.id;
  const host = spacesHomeHost(ownerUserId, now);
  try {
    return pagesTransaction(() => {
      const current = spacesHomeRow(ownerUserId);
      if (current && current.workspace_id === host) { undelete(current.id); return current.id; }
      // Its host workspace is gone (trashed, purged, replaced): the page went with it.
      if (current) db().prepare('DELETE FROM pages WHERE id=?').run(current.id);
      return insertHomePage({ ownerUserId, workspaceId: host, title: SPACES_HOME_TITLE, role: 'spaces-home', now });
    });
  } catch (error) {
    const winner = isUniqueRace(error, 'pages.owner_user_id') ? spacesHomeRow(ownerUserId) : undefined;
    if (winner && winner.workspace_id === host) return winner.id;
    throw error;
  }
}

export function getSpacesHome(ownerUserId: string, now = Date.now()): SpacesHomeDto {
  const pageId = ensureSpacesHomePageId(ownerUserId, now);
  pagesTransaction(() => {
    const marker = `home_attention_block:${pageId}`;
    if (db().prepare('SELECT 1 FROM meta WHERE key=?').get(marker)) return;
    const page = getPage(pageId, ownerUserId);
    if (!page.blocks.some(block => block.type === 'home-section' && block.section === 'waiting')) {
      const leadEnd = page.blocks.findIndex(block => block.type !== 'heading');
      const after = page.blocks[leadEnd < 0 ? page.blocks.length - 1 : leadEnd]?.id ?? null;
      applyUserPageEdits({ pageId, ownerUserId, revision: page.revision, now, ops: [
        { op: 'insert', after, block: { type: 'home-section', section: 'waiting' } },
      ] });
    }
    db().prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(marker, '1');
  });
  return { role: 'spaces-home', page: getPage(pageId, ownerUserId), layoutRules: parseLayoutRules(pageRecord(pageId, ownerUserId).layout_rules) };
}

function requireUserWorkspace(workspaceId: string, ownerUserId: string, write = false) {
  const workspace = requirePagesWorkspace(workspaceId, ownerUserId, write);
  if (isSystemWorkspaceSettings(workspace.settings)) throw new PageWriteError(404, 'not_found', 'Workspace not found');
  return workspace;
}

function workspaceHomeRow(workspaceId: string): HomeRow | undefined {
  return db().prepare("SELECT id,workspace_id,owner_user_id,deleted_at FROM pages WHERE workspace_id=? AND role='workspace-home'").get(workspaceId) as HomeRow | undefined;
}

function homeTitle(name: string): string {
  const title = name.trim().slice(0, PAGE_LIMITS.title);
  return title || SPACES_HOME_TITLE;
}

/**
 * The workspace's default home page id, created on first use. An archived
 * workspace only reads an existing one: it cannot create a page.
 */
export function ensureWorkspaceHomePageId(workspaceId: string, ownerUserId: string, now = Date.now()): string {
  requireOwner(ownerUserId);
  const workspace = requireUserWorkspace(workspaceId, ownerUserId);
  const existing = workspaceHomeRow(workspaceId);
  if (existing && existing.owner_user_id !== ownerUserId) throw new PageWriteError(404, 'not_found', 'Workspace not found');
  if (existing && existing.deleted_at === null) return existing.id;
  requireUserWorkspace(workspaceId, ownerUserId, true);
  try {
    return pagesTransaction(() => {
      const current = workspaceHomeRow(workspaceId);
      if (current) { undelete(current.id); return current.id; }
      return insertHomePage({ ownerUserId, workspaceId, title: homeTitle(workspace.name), role: 'workspace-home', now });
    });
  } catch (error) {
    const winner = isUniqueRace(error, 'pages.workspace_id') ? workspaceHomeRow(workspaceId) : undefined;
    if (winner && winner.owner_user_id === ownerUserId) return winner.id;
    throw error;
  }
}

export function getWorkspaceHome(workspaceId: string, ownerUserId: string, now = Date.now()): WorkspaceHomeDto {
  const pageId = ensureWorkspaceHomePageId(workspaceId, ownerUserId, now);
  const record = pageRecord(pageId, ownerUserId);
  const firstRun = getFirstRun(workspaceId, ownerUserId);
  return {
    role: 'workspace-home', workspaceId, page: getPage(pageId, ownerUserId), layoutRules: parseLayoutRules(record.layout_rules),
    hiddenAt: record.hidden_at, firstRun, firstRunDays: firstRun ? firstRunWindowDays(workspaceId, ownerUserId) : null,
    incremental: incrementalReading(workspaceId, pageId, ownerUserId),
  };
}

/** The maintenance cursor, and the last change an agent (not a person) made to the home page. */
function incrementalReading(workspaceId: string, pageId: string, ownerUserId: string): WorkspaceHomeDto['incremental'] {
  const config = db().prepare('SELECT completion_cursor FROM page_maintenance_configs WHERE workspace_id=? AND owner_user_id=?')
    .get(workspaceId, ownerUserId) as { completion_cursor: number } | undefined;
  if (!config) return null;
  const change = db().prepare(`SELECT MAX(created_at) AS at FROM page_changes WHERE page_id=? AND owner_user_id=?
    AND json_extract(source,'$.kind') IN ('maintenance','chat','helper')`).get(pageId, ownerUserId) as { at: number | null };
  return { readThrough: config.completion_cursor, tidiedAt: change.at };
}

/** Hides the workspace from Spaces (or shows it again). Home pages are never deleted through the page path. */
export function setWorkspaceHomeHidden(workspaceId: string, ownerUserId: string, hidden: boolean, now = Date.now()): WorkspaceHomeDto {
  if (typeof hidden !== 'boolean') throw new PageWriteError(400, 'invalid', 'hidden must be true or false');
  const pageId = ensureWorkspaceHomePageId(workspaceId, ownerUserId, now);
  pagesTransaction(() => {
    requireUserWorkspace(workspaceId, ownerUserId, true);
    const changed = hidden
      ? db().prepare('UPDATE pages SET hidden_at=? WHERE id=? AND hidden_at IS NULL').run(now, pageId)
      : db().prepare('UPDATE pages SET hidden_at=NULL WHERE id=? AND hidden_at IS NOT NULL').run(pageId);
    if (Number(changed.changes)) invalidatePages([pageId], now, 'user');
  });
  return getWorkspaceHome(workspaceId, ownerUserId, now);
}

/** Empty editor blocks and successful no-change runs do not make a home worth listing. */
function homeHasContent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const blocks: unknown = JSON.parse(raw);
    // Unexpected stored content should stay reachable for inspection or repair.
    if (!Array.isArray(blocks)) return true;
    return blocks.some((value) => {
      const block = parsePageBlock(value);
      return !block || pageBlockText(block).trim().length > 0;
    });
  } catch { return true; }
}

/** Every live, unarchived user workspace of the owner's, with its home page when one exists. */
export function listWorkspaceHomes(ownerUserId: string): WorkspaceHomeSummaryDto[] {
  requireOwner(ownerUserId);
  const rows = db().prepare(`SELECT w.id,w.name,w.owner_user_id,w.settings,p.id AS home_id,p.blocks AS home_blocks,p.hidden_at,p.deleted_at AS home_deleted_at
    FROM workspaces w LEFT JOIN pages p ON p.workspace_id=w.id AND p.role='workspace-home' AND p.owner_user_id=?
    WHERE w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL AND (w.owner_user_id=? OR (?='local-user' AND ?<>'1'))
    ORDER BY w.created_at,w.id`).all(ownerUserId, ownerUserId, ownerUserId, process.env.MICHI_CLOUD ?? '') as unknown as Array<{
      id: string; name: string; owner_user_id: string | null; settings: string | null;
      home_id: string | null; home_blocks: string | null; hidden_at: number | null; home_deleted_at: number | null;
    }>;
  const runs = new Map(listFirstRuns(ownerUserId).map((run) => [run.workspaceId, run]));
  return rows
    .filter((row) => workspaceOwnerMatches(row.owner_user_id, ownerUserId) && !isSystemWorkspaceSettings(row.settings))
    .map((row) => {
      const home = row.home_id !== null && row.home_deleted_at === null;
      return { workspaceId: row.id, workspaceName: row.name, homePageId: home ? row.home_id : null,
        hasContent: home && homeHasContent(row.home_blocks), hiddenAt: home ? row.hidden_at : null, firstRun: runs.get(row.id) ?? null, pendingProposals: home ? pendingProposalCount([row.home_id!]) : 0 };
    });
}

/**
 * Whether a page may appear in the owner's Home lists: a live page in a live,
 * unarchived user workspace, or the owner's own Spaces Home.
 */
export function pageShownOnHome(
  page: { role: string | null; deleted_at: number | null; owner_user_id: string },
  workspace: Pick<WorkspaceRow, 'owner_user_id' | 'settings' | 'deleted_at' | 'archived_at' | 'purged_at'>,
  ownerUserId: string,
): boolean {
  if (page.deleted_at !== null || page.owner_user_id !== ownerUserId) return false;
  if (workspace.deleted_at !== null || workspace.purged_at !== null || workspace.archived_at !== null) return false;
  if (!workspaceOwnerMatches(workspace.owner_user_id, ownerUserId)) return false;
  return !isSystemWorkspaceSettings(workspace.settings) || page.role === 'spaces-home';
}
