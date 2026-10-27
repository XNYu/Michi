/**
 * Spaces Home and workspace home pages: the per-connection Spaces Home page,
 * one default home page per workspace, page layout rules, first-run progress,
 * the program-computed Home sections, Space activity and progress cards.
 *
 * Backend routes (mounted under /api):
 *   GET    /spaces-home                              -> SpacesHomeDto
 *   GET    /spaces-home/workspaces                   -> { items: WorkspaceHomeSummaryDto[] }
 *   GET    /spaces-home/sections                     -> SpacesHomeSectionsDto
 *   GET    /spaces-home/conversations?state=&limit=  -> HomeConversationsDto
 *   GET    /spaces-home/look                         -> SpacesHomeLookDto
 *   POST   /spaces-home/look                         -> SpacesHomeLookDto (records now)
 *   GET    /spaces-home/activity?limit=              -> { items: SpaceActivityItem[] }
 *   GET    /spaces-home/progress-cards               -> { items: ProgressCardDto[] }
 *   GET    /workspaces/:workspaceId/home             -> WorkspaceHomeDto
 *   PATCH  /workspaces/:workspaceId/home             WorkspaceHomePatchRequest -> WorkspaceHomeDto
 *   GET    /pages/:pageId/layout-rules               -> { items: PageLayoutRule[] }
 *   POST   /pages/:pageId/layout-rules               LayoutRuleCreateRequest -> PageLayoutRule (201)
 *   DELETE /pages/:pageId/layout-rules/:ruleId       -> { items: PageLayoutRule[] }
 *   GET    /pages/:pageId/layout-preferences        -> PageLayoutPreferences
 *   PUT    /pages/:pageId/layout-preferences        LayoutPreferencesWriteRequest -> PageLayoutPreferences
 *   GET    /pages/:pageId/progress-cards             -> { items: ProgressCardDto[] }
 *   POST   /progress-cards                           ProgressCardCreateRequest -> ProgressCardDto (201)
 *   POST   /progress-cards/:threadNodeId/seen        -> ProgressCardDto
 *   POST   /progress-cards/:threadNodeId/dismiss     -> ProgressCardDto
 */

import type { ChangeSource, PageDto } from './types';
import type { BranchOverviewEntry } from '../branchOverview';
import { finalizeTurnContent } from '../turnProjection';

export type HomePageRole = 'spaces-home' | 'workspace-home';

export const PAGE_LAYOUT_RULE_LIMITS = { text: 500, perPage: 50 } as const;
export const PAGE_LAYOUT_PREFERENCES_LIMIT = 8_000;

/** A page-local instruction document, independent of program-applied section limits. */
export interface PageLayoutPreferences {
  text: string;
  /** Zero means no document has been saved. Writes compare this exact revision. */
  revision: number;
  updatedAt: number | null;
  updatedBy: 'user' | 'agent' | null;
}

export interface LayoutPreferencesWriteRequest {
  text: string;
  expectedRevision: number;
}

/** The chat message a layout rule came from. */
export interface LayoutRuleSourceMessage {
  nodeId: string;
  turnId: string;
  messageId: string;
}

/**
 * The part of a layout rule the program applies to a counted Home section
 * (Spaces Home only): list only items that moved within `maxAgeDays`, and at
 * most `maxItems` of them. The section's total still counts every item, so
 * "View all" keeps the rest. Absent fields set no limit.
 */
export interface LayoutRuleSectionLimit {
  section: HomeSectionKey;
  maxAgeDays?: number;
  maxItems?: number;
}

export interface PageLayoutRule {
  id: string;
  text: string;
  sourceMessage: LayoutRuleSourceMessage | null;
  createdBy: 'user' | 'agent';
  createdAt: number;
  /** Set when the rule limits a counted section; every other rule is text the agent follows. */
  sectionLimit?: LayoutRuleSectionLimit;
}

export interface LayoutRuleCreateRequest {
  text: string;
  sourceMessage?: LayoutRuleSourceMessage | null;
  sectionLimit?: LayoutRuleSectionLimit | null;
}

export interface SpacesHomeDto {
  role: 'spaces-home';
  page: PageDto;
  layoutRules: PageLayoutRule[];
}

export type FirstRunState = 'queued' | 'reading' | 'writing' | 'done' | 'failed';

export interface FirstRunProgressDto {
  workspaceId: string;
  startedAt: number;
  /** The workspace completion counter when the first run started; the incremental cursor starts here. */
  startSeq: number;
  readCount: number;
  total: number;
  state: FirstRunState;
  /** Set only while `state` is `failed`. */
  error: string | null;
  updatedAt: number;
}

export interface WorkspaceHomeDto {
  role: 'workspace-home';
  workspaceId: string;
  page: PageDto;
  layoutRules: PageLayoutRule[];
  /** Hidden from Spaces by the user; the page itself is kept. */
  hiddenAt: number | null;
  firstRun: FirstRunProgressDto | null;
  /** The days the first read looked back over; null before one is queued, absent from older backends. */
  firstRunDays?: number | null;
  /**
   * How far incremental maintenance has read the workspace's finished
   * conversations (its completion cursor), and when an agent last changed
   * this page. Null before maintenance is set up; absent from older backends.
   */
  incremental?: { readThrough: number; tidiedAt: number | null } | null;
}

export interface WorkspaceHomePatchRequest {
  hidden: boolean;
}

/** One live, unarchived workspace of the user's, whether or not its home page exists yet. */
export interface WorkspaceHomeSummaryDto {
  workspaceId: string;
  workspaceName: string;
  homePageId: string | null;
  /** The persisted home contains rendered content; empty first-run results are false. Absent from older backends. */
  hasContent?: boolean;
  hiddenAt: number | null;
  firstRun: FirstRunProgressDto | null;
  /** Suggestions waiting for review on the workspace home itself. Absent from older backends. */
  pendingProposals?: number;
}

/** The Spaces Home summary run: waits for every workspace's first read, then is due, runs and is done. */
export type SpacesHomeSummaryState = 'waiting' | 'due' | 'running' | 'done';

/**
 * Answer of the first-time generation routes: each workspace's first read and the Spaces Home summary.
 *   GET  /spaces-home/first-run        -> SpacesFirstRunStatus
 *   POST /spaces-home/first-run        -> SpacesFirstRunStatus (idempotent)
 *   POST /spaces-home/first-run/retry  { workspaceId? } -> SpacesFirstRunStatus
 */
export interface SpacesFirstRunStatus {
  requestedAt: number | null;
  workspaces: WorkspaceHomeSummaryDto[];
  summary: { state: SpacesHomeSummaryState; summarizedAt: number | null };
  /** Set while a restriction check failure stops every home run until a retry. */
  haltedReason: string | null;
  /**
   * The first run is over: every first read ended and the summary that closes
   * them settled (or the summary is off). A later due or running summary is an
   * ordinary background update, not the first run. Absent from older backends.
   */
  closed?: boolean;
}

export type HomeSectionKey = 'waiting' | 'stalled' | 'done';

/** Most items a Home section lists; `total` counts the rest. */
export const HOME_SECTION_LIMIT = 8;

export const LAYOUT_RULE_SECTION_LIMITS = { maxAgeDays: 365, maxItems: HOME_SECTION_LIMIT } as const;

export type HomeActionTarget =
  /** A Michi conversation, and the reply the row is about when it has one. */
  | { kind: 'conversation'; nodeId: string; workspaceId: string; messageId: string | null }
  /** A page change waiting for confirmation: the page and, for a block change, the block. */
  | { kind: 'page'; pageId: string; blockId: string | null; changeId: string };

export type HomeReminderAction = 'dismiss' | 'snooze' | 'restore';

export interface HomeSectionItem {
  /** Version of this reminder; actions never hide a newer turn. */
  reminderVersion?: string;
  /** Stable within a section: `conversation:<nodeId>` or `change:<changeId>`. */
  id: string;
  kind: 'conversation' | 'proposal';
  workspaceId: string | null;
  workspaceName: string;
  /** Conversation title, or the page title for a proposal. */
  title: string;
  /** When it last moved (ms); null when the source does not know. */
  at: number | null;
  summary: string;
  /** Done because the agent said so; the user has not confirmed it. */
  agentClaim: boolean;
  target: HomeActionTarget;
}

export interface HomeSection {
  items: HomeSectionItem[];
  total: number;
  /** The Spaces Home layout rules that limited `items`, oldest first. Absent from older backends. */
  ruleIds?: string[];
}

export type HomeConversationSource =
  | { available: true }
  /** Conversation state could not be read from the selected Michi backend. */
  | { available: false; reason: string };

/** Waiting (conversations and page suggestions) and Stalled counts of one workspace. */
export interface HomeWorkspaceCounts {
  waiting: number;
  stalled: number;
}

export interface SpacesHomeSectionsDto {
  waiting: HomeSection;
  stalled: HomeSection;
  done: HomeSection;
  conversations: HomeConversationSource;
  /** Per workspace id, across every item, not just the listed ones. Absent from older backends. */
  byWorkspace?: Record<string, HomeWorkspaceCounts>;
  /** Every Michi conversation All threads lists. Absent from older backends. */
  conversationTotal?: number;
  /** Where Just done starts: the last look at the Spaces Home. Absent from older backends. */
  doneSince?: number;
}

export const HOME_CONVERSATION_LIST_LIMITS = { default: 200, max: 500 } as const;

/** Conversations one thread-states read takes: a task board's worth. */
export const THREAD_STATE_LIMITS = { nodeIds: 500 } as const;

/** A row of All threads: a Michi conversation and the section it is in, if any. */
export interface HomeConversationItem extends HomeSectionItem {
  state: HomeSectionKey | null;
}

export interface HomeConversationsDto {
  /** Newest first, at most the requested limit. */
  items: HomeConversationItem[];
  /** Every conversation in the requested state (every conversation without one). */
  total: number;
}

/**
 * Where a conversation a page's thread cards name stands now: waiting on the
 * person (stalled once that has gone on for days), running, done, or idle
 * before its first turn.
 */
export type ThreadCardState = 'waiting' | 'stalled' | 'running' | 'done' | 'idle';

/** One thread card: a conversation of the page's workspace, as it stands now. */
export interface ThreadCardItem {
  nodeId: string;
  workspaceId: string;
  title: string;
  state: ThreadCardState;
  /** What it says now: what it waits for, or the first line of its latest reply; '' before one. */
  summary: string;
  /** When it last moved (ms). */
  at: number;
  /** The reply the card is about, to open the conversation at; null before one. */
  messageId: string | null;
}

/** The named conversations still in the workspace; one deleted or moved away is not among them. */
export interface ThreadCardsDto {
  items: ThreadCardItem[];
}

/** When the owner last left the Spaces Home; null before the first time. */
export interface SpacesHomeLookDto {
  lookedAt: number | null;
}

export const SPACE_ACTIVITY_LIMITS = { default: 20, max: 50 } as const;

/**
 * What one Space activity group did, for its short label: who, what happened,
 * and to which blocks or rows.
 */
export interface SpaceActivityDetail {
  /** The person; the Meta agent (its runs and its chat window); or the conversation the change came from. */
  by: { kind: 'user' } | { kind: 'meta-agent' } | { kind: 'conversation'; title: string } | { kind: 'agent' };
  /**
   * `suggested`: nothing applied and something waits for review; `accepted` /
   * `dismissed`: the person reviewed every one. Otherwise what the applied
   * changes did; beside changes still waiting that is `updated`.
   */
  action: 'added' | 'removed' | 'rewrote' | 'updated' | 'suggested' | 'accepted' | 'dismissed';
  /** Names of the changed blocks or rows, oldest first, at most three; `targets` counts them all. */
  names: string[];
  targets: number;
  /** One block whose only changed value is this one: its name and the value before and after. */
  value?: { name: string; from: string; to: string };
  /** One list block (a timeline, checklist, next steps) that only gained or only lost entries. */
  entries?: { added: number; removed: number };
  /** Every applied change was undone since. */
  undone: boolean;
}

export type SpaceActivityItem =
  | {
    kind: 'page-change';
    /** The newest write in the group. */
    batchId: string;
    pageId: string;
    pageTitle: string;
    workspaceId: string;
    workspaceName: string;
    at: number;
    /** Changes in the group, and how many of them wait for confirmation. */
    count: number;
    pending: number;
    ops: string[];
    summary: string;
    actor: 'user' | 'agent';
    sourceKind: ChangeSource['kind'];
    sourceNodeId: string | null;
    /** Absent from older backends. */
    detail?: SpaceActivityDetail;
    /** Newer than the owner's last look at the Spaces Home, and not their own doing. Absent from older backends. */
    fresh?: boolean;
  }
  | {
    kind: 'conversation';
    threadNodeId: string;
    title: string;
    workspaceId: string;
    workspaceName: string;
    startedFromPageId: string;
    startedFromPageTitle: string | null;
    at: number;
    /** Started after the owner's last look at the Spaces Home. Absent from older backends. */
    fresh?: boolean;
  };

export const PROGRESS_CARD_TTL_MS = 24 * 60 * 60 * 1000;

export type ProgressCardStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

/** A running conversation waits for you: a tool approval, or an answer to its question. */
export type ProgressCardAwaiting = 'approval' | 'question';

/** Status, title and summary are read from the thread node on every request. */
export interface ProgressCardDto {
  threadNodeId: string;
  startedFromPageId: string;
  workspaceId: string;
  workspaceName: string;
  treeId: string | null;
  /** The thread's title, else the first line of its first message. */
  title: string;
  runtimeId: string | null;
  /** `done` only when the latest turn ended normally; `failed` for an error or an abnormal stop, `cancelled` when stopped. */
  status: ProgressCardStatus;
  /** Once it is not running: the summary its latest turn ended with (`progressTurnSummary`), else what its last reply concluded (`progressReplyConclusion`). */
  summary: string | null;
  /** Why a failed conversation stopped: the first line of its error. Absent from older backends. */
  error?: string | null;
  /** When the latest turn ended; null while it runs. Absent from older backends. */
  finishedAt?: number | null;
  /** What a running conversation is doing, from its live turn ("Running tests…"); never message text. Null when not running. */
  statusLine?: string | null;
  awaiting?: ProgressCardAwaiting | null;
  /** What it waits for: the request's title, or the question it asks. Absent from older backends. */
  awaitingDetail?: string | null;
  createdAt: number;
  seenAt: number | null;
  dismissedAt: number | null;
  /** When the card stops showing: 24 hours after it was seen. */
  expiresAt: number | null;
}

/** The parts of a reply the status line looks at: a durable message or a chat message in the window. */
export interface ProgressReplyShape {
  text?: string;
  content?: string;
  blocks?: ReadonlyArray<{ kind: string }>;
  toolCalls: ReadonlyArray<{ status: string; kind?: string; title: string }>;
  plan?: ReadonlyArray<{ status: string }>;
}

const RUNNING_TOOL = new Set(['pending', 'in_progress', 'running']);

function toolStatusLine(tool: { kind?: string; title: string }): string {
  const kind = tool.kind ?? '';
  if (kind === 'execute') return /\btest/i.test(tool.title) ? 'Running tests…' : 'Running a command…';
  if (kind === 'read') return 'Reading code…';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'Editing files…';
  if (kind === 'search') return 'Searching…';
  if (kind === 'fetch') return 'Reading a web page…';
  if (kind === 'think') return 'Thinking…';
  return 'Working…';
}

/** The one line a progress card shows for a running conversation, from its newest reply. */
export function progressCardStatusLine(input: { awaiting: ProgressCardAwaiting | null; activity?: string | null; reply: ProgressReplyShape | null | undefined }): string {
  if (input.awaiting === 'approval') return 'Waiting for your approval…';
  if (input.awaiting === 'question') return 'Waiting for your answer…';
  if (input.activity) return `${input.activity}…`;
  const reply = input.reply;
  if (!reply || (!reply.blocks?.length && !reply.text && !reply.content && reply.toolCalls.length === 0)) return 'Starting…';
  const tool = [...reply.toolCalls].reverse().find((call) => RUNNING_TOOL.has(call.status));
  if (tool) return toolStatusLine(tool);
  if (reply.plan?.some((entry) => entry.status === 'in_progress')) return 'Working through its plan…';
  const tail = reply.blocks?.[reply.blocks.length - 1];
  if (tail?.kind === 'thinking') return 'Thinking…';
  if (tail?.kind === 'answer') return 'Writing the reply…';
  return 'Working…';
}

export const PROGRESS_SUMMARY_MAX = 240;
/** A closing offer or question to the user ("Want me to go on?") says nothing about the result on its own. */
const SIGN_OFF = /[?？]\s*$|^(let me know|tell me|if you('d| would)? (like|want)|如果(你|您)|需要我|要不要我)/i;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The summary the latest turn ended with: the overview entry the agent
 * recorded for it (at or after the turn started), or null when it left none.
 */
export function progressTurnSummary(entries: readonly BranchOverviewEntry[], turnStartedAt: number | null | undefined, max = PROGRESS_SUMMARY_MAX): string | null {
  if (!turnStartedAt) return null;
  let latest: BranchOverviewEntry | undefined;
  for (const entry of entries) if (entry.at >= turnStartedAt && (!latest || entry.at >= latest.at)) latest = entry;
  const text = latest?.text.replace(/\s+/g, ' ').trim();
  return text ? cut(text, max) : null;
}

function plainParagraph(paragraph: string): string {
  return paragraph.split('\n')
    .map((line) => line.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, '').replace(/\*\*|__|`/g, ''))
    .join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * A reply's answer text, with a paragraph break where a tool call or thinking
 * split it, so its last segment (what the turn ends with) stands alone.
 * Michi's metadata sentinels ([TITLE: …], [BRANCH-OVERVIEW: …]) are not text.
 */
export function progressReplyText(input: { blocks?: ReadonlyArray<{ kind: string; rawText?: unknown }> | null; text?: string | null }): string {
  let text = '';
  let split = false;
  for (const block of input.blocks ?? []) {
    if (block.kind !== 'answer') { split = text.length > 0; continue; }
    if (typeof block.rawText !== 'string') continue;
    text += (split ? '\n\n' : '') + block.rawText;
    split = false;
  }
  return finalizeTurnContent(text.trim() ? text : input.text ?? '');
}

/**
 * What a finished reply concluded, on one line: its last paragraph (with the
 * one before when the last only asks or offers something), without code,
 * headings or list markers. A reply's first paragraph is usually working notes
 * ("I'll look into…"), so a card never shows that.
 */
export function progressReplyConclusion(text: string, max = PROGRESS_SUMMARY_MAX): string | null {
  const paragraphs = text.replace(/```[\s\S]*?(?:```|$)/g, '\n\n').split(/\n\s*\n/)
    .filter((paragraph) => !/^\s*#{1,6}\s[^\n]*$/.test(paragraph) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(paragraph))
    .map(plainParagraph).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1];
  if (!last) return null;
  const before = paragraphs[paragraphs.length - 2];
  const conclusion = before && SIGN_OFF.test(last) ? `${before} ${last}` : last;
  return cut(conclusion, max);
}

export interface ProgressCardCreateRequest {
  threadNodeId: string;
  startedFromPageId: string;
}
