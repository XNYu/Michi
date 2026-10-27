import { createHash } from 'node:crypto';
import { PageWriteError } from './core';
import {
  HOME_CONVERSATION_LIST_LIMITS, HOME_SECTION_LIMIT, isSystemWorkspaceSettings,
  type HomeReminderAction, type HomeConversationItem, type HomeConversationsDto, type HomeSection, type HomeSectionItem, type HomeSectionKey,
  type HomeWorkspaceCounts, type PageBlock, type SpacesHomeLookDto, type SpacesHomeSectionsDto, type TargetSnapshot, type ThreadCardItem,
  pageBlockText, pageBlockTitle,
} from 'michi-shared';
import type { ChatHub } from '../../agents/chatHub';
import { getDb } from '../db';
import { pageShownOnHome } from './homePages';
import { spacesHomeSectionLimits, type EffectiveSectionLimit } from './layoutRules';

const SUMMARY_MAX = 200;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function oneLine(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function blockLine(block: PageBlock): string {
  switch (block.type) {
    case 'heading': case 'markdown': return oneLine(block.text);
    case 'callout': return oneLine(block.title ? `${block.title}: ${block.text}` : block.text);
    case 'checklist': return oneLine([block.title, ...block.items.map((item) => item.text)].filter(Boolean).join(' · '));
    case 'metrics': return oneLine(block.items.map((item) => `${item.label} ${item.value}`).join(' · '));
    case 'next-steps': case 'timeline': return oneLine([block.title, ...block.items.map((item) => 'text' in item ? item.text : item.title)].filter(Boolean).join(' · '));
    case 'database-ref': return 'Database view';
    case 'page-link': return 'Page link';
    case 'component': return 'Component';
    default: return oneLine(catalogLines(block).join(' · '));
  }
}

/** A block's lines as the block catalog writes them; `untitled` leaves out a first line that is only its title. */
function catalogLines(block: PageBlock, untitled = false): string[] {
  const lines = pageBlockText(block).split('\n').filter((line) => line.trim());
  return untitled && lines[0]?.trim() === pageBlockTitle(block) ? lines.slice(1) : lines;
}

export function snapshotLine(snapshot: TargetSnapshot | null): string {
  if (!snapshot || !snapshot.exists) return '';
  if (snapshot.kind === 'block') return blockLine(snapshot.block);
  if (snapshot.kind === 'row') return oneLine(Object.values(snapshot.row.values).filter((value) => typeof value === 'string').join(' · '));
  return oneLine(snapshot.database.title);
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Conversations: Michi's own nodes, turns and messages ───────────────────

/** What a running conversation waits for in this process: a tool approval, or an answer to its question. */
export interface HomeLiveWait {
  kind: 'approval' | 'question';
  /** The tool's title, or the question; empty when the runtime gave none. */
  text: string;
}
export type HomeLiveWaitReader = (nodeId: string) => HomeLiveWait | null;

/** The pending permission or user-input request of the node's active turn in ChatHub. */
export function chatHubLiveWait(
  hub: Pick<ChatHub, 'getSnapshot' | 'getPendingPermission' | 'getPendingUserInput'>,
  nodeId: string,
): HomeLiveWait | null {
  const observation = hub.getSnapshot(nodeId);
  if (!observation || observation.inMemoryStatus !== 'active' || !observation.pendingInteraction.waiting) return null;
  const permission = hub.getPendingPermission(observation.chatId);
  if (permission) return { kind: 'approval', text: permission.title ?? '' };
  const input = hub.getPendingUserInput(observation.chatId);
  if (input) return { kind: 'question', text: input.questions?.[0]?.question ?? '' };
  return { kind: 'approval', text: '' };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A conversation that waits on you and has not moved for this long is Stalled instead. */
export const STALLED_AFTER_MS = 3 * DAY_MS;
/** Where Just done starts before the first look at the Spaces Home. */
export const FIRST_LOOK_WINDOW_MS = DAY_MS;
const TITLE_MAX = 120;

/** Turns that completed without finishing their work: Just done names why instead of the cut-off reply. */
const ENDED_EARLY: Record<string, string> = {
  max_tokens: 'Stopped early: it reached its output limit',
  max_turn_requests: 'Stopped early: it reached its step limit',
  refusal: 'Stopped: the agent declined to continue',
};

type ConversationRow = {
  turn_id: string | null; node_id: string; workspace_id: string; title: string | null; first_user: string | null; node_created_at: number;
  workspace_name: string; workspace_owner: string | null; workspace_settings: string | null;
  turn_status: string | null; stop_reason: string | null; error: string | null;
  started_at: number | null; updated_at: number | null; completed_at: number | null;
  reply_id: string | null; reply: string | null; replied: number; last_message_at: number | null; viewed_at: number | null;
};

const TRAILING_QUESTION_SQL = "substr(rtrim(COALESCE(a.content,''),' '||char(9)||char(10)||char(13)),-1) IN ('?','？')";
const SCHEDULED_SQL = "COALESCE(json_extract(CASE WHEN json_valid(um.metadata) THEN um.metadata ELSE '{}' END,'$.scheduledJobId'),'')";

/**
 * The conversations the Home may name, each with its latest turn. Left out:
 * background maintenance chats, conversations whose latest turn is a
 * scheduled-job run, archived and trashed conversations, archived or trashed
 * workspaces and workspaces hidden from Spaces. Callers also drop the hidden
 * system workspaces (the Meta agent's and the assistant's) by their settings.
 */
/** The workspace is the owner's (on a local backend, the local user owns them all). Params: owner, owner, MICHI_CLOUD. */
const OWNER_SQL = "(w.owner_user_id=? OR (?='local-user' AND ?<>'1'))";

/** A conversation and its latest turn: what classifying one reads. Joins n (node), w (workspace), t (latest turn), a (its reply). */
const CONVERSATION_COLUMNS = `t.turn_id,n.id AS node_id,n.workspace_id,n.title,n.created_at AS node_created_at,n.viewed_at,
      CASE WHEN trim(COALESCE(n.title,''))='' THEN (SELECT f.content FROM messages f WHERE f.node_id=n.id AND f.role='user'
        AND trim(f.content)<>'' ORDER BY f.seq LIMIT 1) END AS first_user,
      w.name AS workspace_name,w.owner_user_id AS workspace_owner,w.settings AS workspace_settings,
      t.status AS turn_status,t.stop_reason,t.error,t.started_at,t.updated_at,t.completed_at,
      a.id AS reply_id,a.content AS reply,
      EXISTS(SELECT 1 FROM messages r WHERE r.node_id=n.id AND r.role='user' AND r.id IS NOT t.user_message_id
        AND r.created_at>COALESCE(t.completed_at,t.updated_at)) AS replied,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.node_id=n.id) AS last_message_at`;

const LATEST_TURN_JOIN = `LEFT JOIN turns t ON t.turn_id=(SELECT l.turn_id FROM turns l WHERE l.node_id=n.id ORDER BY l.started_at DESC,l.rowid DESC LIMIT 1)
    LEFT JOIN messages a ON a.id=t.assistant_message_id AND a.node_id=n.id`;

const CONVERSATIONS_FROM = `FROM nodes n JOIN workspaces w ON w.id=n.workspace_id
    LEFT JOIN trees tr ON tr.id=n.tree_id
    LEFT JOIN pages hp ON hp.workspace_id=n.workspace_id AND hp.role='workspace-home' AND hp.owner_user_id=? AND hp.deleted_at IS NULL
    ${LATEST_TURN_JOIN}
    LEFT JOIN messages um ON um.id=t.user_message_id AND um.node_id=n.id
    WHERE n.kind='chat' AND n.deleted_at IS NULL AND n.purged_at IS NULL AND n.status<>'archived' AND n.maintenance_job_id IS NULL
      AND tr.archived_at IS NULL AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL AND hp.hidden_at IS NULL
      AND ${OWNER_SQL}
      AND (t.turn_id IS NOT NULL OR EXISTS(SELECT 1 FROM messages e WHERE e.node_id=n.id))
      AND ${SCHEDULED_SQL}=''`;

const ownerParams = (ownerUserId: string): string[] => [ownerUserId, ownerUserId, ownerUserId, process.env.MICHI_CLOUD ?? ''];

/**
 * With `candidatesSince`, only conversations that can be in a section: a
 * running turn, a failed one, a reply ending in a question, or one that
 * completed after that time.
 */
function conversationRows(ownerUserId: string, candidatesSince: number | null): ConversationRow[] {
  const candidates = candidatesSince === null ? '' : `AND (t.status IN ('active','error')
      OR (t.status='completed' AND (${TRAILING_QUESTION_SQL} OR t.completed_at>?)))`;
  const sql = `SELECT ${CONVERSATION_COLUMNS}
    ${CONVERSATIONS_FROM} ${candidates}`;
  const params: Array<string | number> = ownerParams(ownerUserId);
  if (candidatesSince !== null) params.push(candidatesSince);
  return (getDb().prepare(sql).all(...params) as unknown as ConversationRow[])
    .filter((row) => !isSystemWorkspaceSettings(row.workspace_settings));
}

/** The last question of a reply, on one line: the sentence its final `?` ends. */
export function lastQuestion(reply: string): string {
  const lines = reply.trimEnd().split('\n').map((line) => line.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] ?? '').replace(/^(?:[#>*-]+|\d+[.)])\s*/, '');
  // A Latin full stop ends a sentence only before a space, so paths and versions stay whole.
  const sentences = last.split(/(?<=[.!?])\s+|(?<=[。！？])/).map((part) => part.trim()).filter(Boolean);
  return oneLine(sentences[sentences.length - 1] ?? last);
}

/** The first non-empty line of a text, on one line. */
function firstLine(text: string): string {
  return oneLine(text.split('\n').find((line) => line.trim()) ?? '');
}

function conversationTitle(row: ConversationRow): string {
  const title = row.title?.trim();
  if (title) return title;
  const line = (row.first_user ?? '').trim().split('\n')[0]?.trim() ?? '';
  return line ? oneLine(line, TITLE_MAX) : 'Untitled conversation';
}

/** Why a conversation waits on you, and since when; null when it does not. */
function waitingFor(row: ConversationRow, live: HomeLiveWaitReader): { summary: string; at: number } | null {
  if (row.turn_status === 'active') {
    const wait = live(row.node_id);
    if (!wait) return null;
    const at = row.updated_at ?? row.started_at ?? row.node_created_at;
    if (wait.kind === 'approval') return { summary: wait.text ? `Waiting for your approval: ${oneLine(wait.text)}` : 'Waiting for your approval', at };
    return { summary: wait.text ? `Asked: ${oneLine(wait.text)}` : 'Waiting for your answer', at };
  }
  if (row.replied) return null;
  const at = row.completed_at ?? row.updated_at ?? row.started_at ?? row.node_created_at;
  if (row.turn_status === 'error') {
    if (row.error === 'backend_restarted') return { summary: 'Interrupted: Michi stopped while it was running', at };
    const line = row.error ? firstLine(row.error) : '';
    return { summary: line ? `Failed: ${line}` : 'Failed', at };
  }
  if (row.turn_status !== 'completed') return null;
  const reply = row.reply ?? '';
  if (/[?？]$/.test(reply.trimEnd())) return { summary: `Asked: ${lastQuestion(reply)}`, at };
  return null;
}

function conversationItem(row: ConversationRow, at: number | null, summary: string): HomeSectionItem {
  return {
    reminderVersion: createHash('sha256').update(JSON.stringify([row.turn_id, row.reply_id, at, summary])).digest('hex'),
    id: `conversation:${row.node_id}`, kind: 'conversation', workspaceId: row.workspace_id, workspaceName: row.workspace_name,
    title: conversationTitle(row), at, summary, agentClaim: false,
    target: { kind: 'conversation', nodeId: row.node_id, workspaceId: row.workspace_id, messageId: row.reply_id },
  };
}

/** Which section a conversation is in, if any, and the row it shows there. */
function classify(row: ConversationRow, live: HomeLiveWaitReader, since: number, now: number): { state: HomeSectionKey | null; item: HomeSectionItem } {
  const wait = waitingFor(row, live);
  if (wait) return { state: now - wait.at >= STALLED_AFTER_MS ? 'stalled' : 'waiting', item: conversationItem(row, wait.at, wait.summary) };
  // A message written after it completed, or having it on screen since, means the user was there since.
  if (row.turn_status === 'completed' && !row.replied && row.completed_at !== null && row.completed_at > since
    && !(row.viewed_at !== null && row.viewed_at >= row.completed_at)) {
    const early = row.stop_reason ? ENDED_EARLY[row.stop_reason] : undefined;
    return { state: 'done', item: conversationItem(row, row.completed_at, early ?? firstLine(row.reply ?? '')) };
  }
  const at = Math.max(row.completed_at ?? 0, row.updated_at ?? 0, row.last_message_at ?? 0) || row.node_created_at;
  return { state: null, item: conversationItem(row, at, '') };
}

// ── The Spaces Home look ────────────────────────────────────────────────────

const lookKey = (ownerUserId: string) => `spaces_home_looked_at:${ownerUserId}`;

export function getSpacesHomeLook(ownerUserId: string): SpacesHomeLookDto {
  const row = getDb().prepare('SELECT value FROM meta WHERE key=?').get(lookKey(ownerUserId)) as { value: string } | undefined;
  const value = row ? Number(row.value) : NaN;
  return { lookedAt: Number.isSafeInteger(value) && value > 0 ? value : null };
}

/** Leaving the Spaces Home counts as a look; Just done lists what completed after the last one. */
export function markSpacesHomeLooked(ownerUserId: string, now = Date.now()): SpacesHomeLookDto {
  getDb().prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(lookKey(ownerUserId), String(now));
  return { lookedAt: now };
}

// ── Pending page proposals ──────────────────────────────────────────────────

type ProposalRow = {
  id: string; op: string; page_id: string | null; database_id: string | null; target: string; after_json: string | null; before_json: string | null;
  created_at: number; workspace_id: string; workspace_name: string; workspace_owner: string | null; workspace_settings: string | null;
  workspace_deleted_at: number | null; workspace_archived_at: number | null; workspace_purged_at: number | null;
  resolved_page_id: string | null; page_title: string | null; page_role: string | null; page_deleted_at: number | null; page_owner: string | null;
};

/** A database change shows on the first live page that embeds the database. */
const PROPOSALS_SQL = `SELECT c.id,c.op,c.page_id,c.database_id,c.target,c.after_json,c.before_json,c.created_at,c.workspace_id,
    w.name AS workspace_name,w.owner_user_id AS workspace_owner,w.settings AS workspace_settings,
    w.deleted_at AS workspace_deleted_at,w.archived_at AS workspace_archived_at,w.purged_at AS workspace_purged_at,
    p.id AS resolved_page_id,p.title AS page_title,p.role AS page_role,p.deleted_at AS page_deleted_at,p.owner_user_id AS page_owner
  FROM page_changes c JOIN workspaces w ON w.id=c.workspace_id
  LEFT JOIN pages p ON p.id=COALESCE(c.page_id,(SELECT r.page_id FROM page_database_refs r JOIN pages rp ON rp.id=r.page_id
      WHERE r.database_id=c.database_id AND rp.deleted_at IS NULL ORDER BY rp.position,rp.id LIMIT 1))
  LEFT JOIN page_databases d ON d.id=c.database_id
  WHERE c.owner_user_id=? AND c.proposal_state='pending' AND (c.database_id IS NULL OR d.deleted_at IS NULL)
    AND w.deleted_at IS NULL AND w.purged_at IS NULL AND w.archived_at IS NULL
  ORDER BY c.created_at DESC,c.seq DESC`;

function shownProposals(ownerUserId: string): ProposalRow[] {
  return (getDb().prepare(PROPOSALS_SQL).all(ownerUserId) as unknown as ProposalRow[]).filter((row) =>
    row.resolved_page_id !== null && row.page_owner !== null && pageShownOnHome(
      { role: row.page_role, deleted_at: row.page_deleted_at, owner_user_id: row.page_owner },
      { owner_user_id: row.workspace_owner, settings: row.workspace_settings, deleted_at: row.workspace_deleted_at,
        archived_at: row.workspace_archived_at, purged_at: row.workspace_purged_at },
      ownerUserId));
}

/** A block's own title (a heading line, a callout or list title); '' for a plain paragraph. */
function blockTitle(block: PageBlock): string {
  switch (block.type) {
    case 'heading': return oneLine(block.text);
    case 'markdown': {
      const first = block.text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
      return /^#{1,6}\s/.test(first) ? oneLine(first.replace(/^#{1,6}\s+/, '')) : '';
    }
    case 'callout': case 'checklist': case 'next-steps': case 'timeline': return oneLine(block.title ?? '');
    case 'metrics': case 'database-ref': case 'page-link': case 'component': return '';
    default: return oneLine(pageBlockTitle(block));
  }
}

/** What a block says without its title. */
function blockBody(block: PageBlock): string {
  if (block.type === 'heading') return '';
  if (block.type === 'markdown' && blockTitle(block)) {
    const lines = block.text.split('\n');
    return oneLine(lines.slice(lines.findIndex((line) => line.trim()) + 1).join('\n'));
  }
  if (block.type === 'callout') return oneLine(block.text);
  if (['checklist', 'metrics', 'next-steps', 'timeline', 'database-ref', 'page-link', 'component'].includes(block.type)) return blockLine(block);
  return oneLine(catalogLines(block, true).join(' · '));
}

/** The row of a suggestion: what kind of change, to which section, and the suggested text. */
function proposalSummary(row: ProposalRow): string {
  const before = parseJson(row.before_json) as TargetSnapshot | null;
  const after = parseJson(row.after_json) as TargetSnapshot | null;
  const beforeBlock = before?.exists && before.kind === 'block' ? before.block : null;
  const afterBlock = after?.exists && after.kind === 'block' ? after.block : null;
  if (!beforeBlock && !afterBlock) return snapshotLine(after ?? before);
  const title = (beforeBlock && blockTitle(beforeBlock)) || (afterBlock && blockTitle(afterBlock)) || '';
  const of = title ? ` of “${title}”` : '';
  if (row.op === 'delete' || !afterBlock) return `Suggested removal${of}`;
  const body = blockBody(afterBlock);
  const kind = row.op === 'insert' ? 'Suggested addition'
    : row.op === 'update' && ['markdown', 'callout', 'heading'].includes(afterBlock.type) ? `Suggested rewrite${of}` : `Suggested change${of}`;
  return body ? `${kind}: ${body}` : kind;
}

function proposalItem(row: ProposalRow): HomeSectionItem {
  const target = parseJson(row.target);
  const blockId = isObject(target) && target.kind === 'block' && typeof target.blockId === 'string' ? target.blockId : null;
  const system = isSystemWorkspaceSettings(row.workspace_settings);
  return {
    reminderVersion: row.id,
    id: `change:${row.id}`, kind: 'proposal',
    // The Spaces Home belongs to no workspace as far as the user sees.
    workspaceId: system ? null : row.workspace_id, workspaceName: system ? '' : row.workspace_name,
    title: row.page_title ?? '', at: row.created_at, summary: proposalSummary(row), agentClaim: false,
    target: { kind: 'page', pageId: row.resolved_page_id!, blockId, changeId: row.id },
  };
}

// ── Sections ────────────────────────────────────────────────────────────────

/**
 * At most HOME_SECTION_LIMIT items, narrowed by the Spaces Home's layout
 * rules. `total` still counts every item: what a rule leaves out stays
 * behind "View all". Age counts whole days, as the rows show it ("quiet 3d"
 * is within "the last 3 days"); an item with no known time is left out.
 */
function section(items: HomeSectionItem[], total: number, limit: EffectiveSectionLimit | undefined, now: number): HomeSection {
  if (!limit) return { items: items.slice(0, HOME_SECTION_LIMIT), total };
  const kept = limit.maxAgeDays === null ? items
    : items.filter((item) => item.at !== null && Math.floor(Math.max(0, now - item.at) / DAY_MS) <= limit.maxAgeDays!);
  return { items: kept.slice(0, Math.min(HOME_SECTION_LIMIT, limit.maxItems ?? HOME_SECTION_LIMIT)), total, ruleIds: limit.ruleIds };
}

const newestFirst = (a: HomeSectionItem, b: HomeSectionItem): number => (b.at ?? -Infinity) - (a.at ?? -Infinity);

export interface HomeSectionsInput {
  ownerUserId: string;
  /** The start of Just done; default: the last look at the Spaces Home, else the last 24 hours. */
  since?: number;
  /** What ages and the stalled cut-off count back from. */
  now?: number;
  /** Pending approvals and questions of running turns; none without it. */
  live?: HomeLiveWaitReader;
}

const noLiveWait: HomeLiveWaitReader = () => null;
let configuredLiveWait: HomeLiveWaitReader = noLiveWait;
/** server.ts reads live waits from ChatHub for the readers no route hands them to: agent tools. */
export function configureHomeLiveWait(reader: HomeLiveWaitReader | null): void { configuredLiveWait = reader ?? noLiveWait; }
/** The configured reader, looked up on every call. */
export const serverLiveWait: HomeLiveWaitReader = (nodeId) => configuredLiveWait(nodeId);

function classified(input: HomeSectionsInput, every: boolean, includeHidden = false) {
  const now = input.now ?? Date.now();
  const since = input.since ?? getSpacesHomeLook(input.ownerUserId).lookedAt ?? now - FIRST_LOOK_WINDOW_MS;
  const live = input.live ?? noLiveWait;
  const rows = conversationRows(input.ownerUserId, every ? null : since);
  const hidden = reminderFilter(input.ownerUserId, now);
  return { now, since, list: rows.map((row) => {
    const entry = classify(row, live, since, now);
    return !includeHidden && hidden(entry.item) ? { ...entry, state: null } : entry;
  }) };
}

/** How many conversations All threads lists. */
export function conversationCount(ownerUserId: string): number {
  const rows = getDb().prepare(`SELECT w.settings,COUNT(*) AS n ${CONVERSATIONS_FROM} GROUP BY w.id`)
    .all(...ownerParams(ownerUserId)) as unknown as Array<{ settings: string | null; n: number }>;
  return rows.reduce((sum, row) => (isSystemWorkspaceSettings(row.settings) ? sum : sum + row.n), 0);
}

/**
 * Waiting / Stalled / Just done, computed by the program from Michi's own
 * conversations: their latest turn, its reply and, for a running turn, what
 * it waits for in ChatHub. Waiting adds page proposals that wait for
 * confirmation. The Spaces Home's structured layout rules narrow what each
 * one lists. Just done leaves out a conversation the user had on screen
 * after it completed (`nodes.viewed_at`); the client also drops the ones this
 * window opened since its last read.
 */
export function homeSections(input: HomeSectionsInput): SpacesHomeSectionsDto {
  const { now, since, list } = classified(input, false);
  const by: Record<HomeSectionKey, HomeSectionItem[]> = { waiting: [], stalled: [], done: [] };
  for (const entry of list) if (entry.state) by[entry.state].push(entry.item);
  const hidden = reminderFilter(input.ownerUserId, now);
  const proposals = shownProposals(input.ownerUserId).map(proposalItem).filter(item => !hidden(item));
  const counts: Record<string, HomeWorkspaceCounts> = {};
  const count = (item: HomeSectionItem, key: keyof HomeWorkspaceCounts) => {
    if (!item.workspaceId) return;
    (counts[item.workspaceId] ??= { waiting: 0, stalled: 0 })[key] += 1;
  };
  for (const item of [...by.waiting, ...proposals]) count(item, 'waiting');
  for (const item of by.stalled) count(item, 'stalled');
  const limits = spacesHomeSectionLimits(input.ownerUserId);
  const waiting = [...by.waiting, ...proposals].sort(newestFirst);
  return {
    waiting: section(waiting, waiting.length, limits.waiting, now),
    stalled: section(by.stalled.sort(newestFirst), by.stalled.length, limits.stalled, now),
    done: section(by.done.sort(newestFirst), by.done.length, limits.done, now),
    conversations: { available: true },
    byWorkspace: counts,
    conversationTotal: conversationCount(input.ownerUserId),
    doneSince: since,
  };
}

export interface HomeConversationsInput extends HomeSectionsInput {
  state?: HomeSectionKey | null;
  limit?: number;
  /** Only this workspace's conversations: a task's Link picker. */
  workspaceId?: string;
}

/** All threads: every conversation the Home may name, or those in one section, newest first. */
export function homeConversations(input: HomeConversationsInput): HomeConversationsDto {
  const limit = input.limit ?? HOME_CONVERSATION_LIST_LIMITS.default;
  const state = input.state ?? null;
  const { list } = classified(input, state === null);
  const items: HomeConversationItem[] = list
    .filter((entry) => state === null || entry.state === state)
    .filter((entry) => input.workspaceId === undefined || entry.item.workspaceId === input.workspaceId)
    .map((entry) => ({ ...entry.item, state: entry.state }))
    .sort(newestFirst);
  return { items: items.slice(0, limit), total: items.length };
}

export interface ThreadCardsInput {
  ownerUserId: string;
  /** The page's workspace: a card shows a conversation only while it is there. */
  workspaceId: string;
  nodeIds: readonly string[];
  now?: number;
  live?: HomeLiveWaitReader;
}

/**
 * The conversations a page's thread cards name, each as it stands now, read
 * from its latest turn: waiting on the person (stalled after days of it),
 * running, done, or idle before its first turn. Unlike the Home's sections
 * this ignores what the person has seen, and shows archived conversations and
 * maintenance and scheduled runs too. One deleted, or moved to another
 * workspace since, is left out, so its card says it is gone.
 */
export function threadCards(input: ThreadCardsInput): ThreadCardItem[] {
  return conversationCards(input.nodeIds, input.ownerUserId, input.workspaceId, input.now, input.live);
}

export interface ThreadStatesInput {
  ownerUserId: string;
  nodeIds: readonly string[];
  now?: number;
  live?: HomeLiveWaitReader;
}

/**
 * The named conversations as each stands now, wherever they are, read as
 * thread cards read them. One deleted, or not the person's, is left out; one
 * in another workspace says which, so a task board can say it is no longer here.
 */
export function threadStates(input: ThreadStatesInput): ThreadCardItem[] {
  return conversationCards(input.nodeIds, input.ownerUserId, null, input.now, input.live);
}

function conversationCards(nodeIds: readonly string[], ownerUserId: string, workspaceId: string | null, at: number | undefined, reader: HomeLiveWaitReader | undefined): ThreadCardItem[] {
  if (!nodeIds.length) return [];
  const now = at ?? Date.now();
  const live = reader ?? noLiveWait;
  const scope = workspaceId === null ? ' AND w.deleted_at IS NULL AND w.purged_at IS NULL' : ' AND n.workspace_id=?';
  const rows = getDb().prepare(`SELECT ${CONVERSATION_COLUMNS}
    FROM nodes n JOIN workspaces w ON w.id=n.workspace_id
    ${LATEST_TURN_JOIN}
    WHERE n.id IN (${nodeIds.map(() => '?').join(',')})${scope} AND n.kind='chat'
      AND n.deleted_at IS NULL AND n.purged_at IS NULL AND ${OWNER_SQL}`)
    .all(...nodeIds, ...(workspaceId === null ? [] : [workspaceId]), ownerUserId, ownerUserId, process.env.MICHI_CLOUD ?? '') as unknown as ConversationRow[];
  return rows.map((row): ThreadCardItem => {
    const card = { nodeId: row.node_id, workspaceId: row.workspace_id, title: conversationTitle(row), messageId: row.reply_id };
    const wait = waitingFor(row, live);
    if (wait) return { ...card, state: now - wait.at >= STALLED_AFTER_MS ? 'stalled' : 'waiting', summary: wait.summary, at: wait.at };
    const at = Math.max(row.completed_at ?? 0, row.updated_at ?? 0, row.last_message_at ?? 0) || row.node_created_at;
    if (!row.turn_status) return { ...card, state: 'idle', summary: '', at };
    if (row.turn_status === 'active') return { ...card, state: 'running', summary: firstLine(row.reply ?? ''), at };
    const early = row.turn_status === 'cancelled' ? 'Stopped before it finished' : row.stop_reason ? ENDED_EARLY[row.stop_reason] : undefined;
    return { ...card, state: 'done', summary: early ?? firstLine(row.reply ?? ''), at };
  });
}

/** User attention choices do not change a conversation, task, or pending proposal. */
function reminderFilter(ownerUserId: string, now: number) {
  const rows = getDb().prepare('SELECT item_id,version,until_at FROM home_reminders WHERE owner_user_id=?').all(ownerUserId) as unknown as Array<{ item_id: string; version: string; until_at: number | null }>;
  const hidden = new Map(rows.map(row => [row.item_id, row]));
  return (item: HomeSectionItem): boolean => {
    const row = hidden.get(item.id);
    return !!row && row.version === item.reminderVersion && (row.until_at === null || row.until_at > now);
  };
}

export function actOnHomeReminder(input: HomeSectionsInput & { itemId: string; version: string; action: HomeReminderAction }): void {
  const now = input.now ?? Date.now();
  const entry = classified(input, true, true).list.find(entry => entry.item.id === input.itemId);
  const item = entry?.item ?? shownProposals(input.ownerUserId).map(proposalItem).find(item => item.id === input.itemId);
  if (!item) throw new PageWriteError(404, 'not_found', 'Reminder not found');
  if (item.reminderVersion !== input.version) throw new PageWriteError(409, 'stale_revision', 'This reminder changed. Refresh Home and try again.');
  if (input.action === 'restore') {
    getDb().prepare('DELETE FROM home_reminders WHERE owner_user_id=? AND item_id=? AND version=?').run(input.ownerUserId, item.id, input.version);
    return;
  }
  if (entry && entry.state !== 'waiting' && entry.state !== 'stalled') throw new PageWriteError(409, 'stale_revision', 'This conversation no longer needs attention.');
  getDb().prepare(`INSERT INTO home_reminders(owner_user_id,item_id,version,until_at) VALUES(?,?,?,?)
    ON CONFLICT(owner_user_id,item_id) DO UPDATE SET version=excluded.version,until_at=excluded.until_at`)
    .run(input.ownerUserId, item.id, input.version, input.action === 'snooze' ? now + DAY_MS : null);
}
