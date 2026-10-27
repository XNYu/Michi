import { createHash } from 'node:crypto';
import type { PageBlock } from 'michi-shared';
import { ensureAssistant } from '../../assistant/store';
import { getDb } from '../db';
import { saveMessage } from '../dbRepository';
import { log } from '../logger';
import { getPage } from '../pages/repository';
import { listWorkspaceHomes } from '../pages/homePages';
import { extractCardsJson } from './homeCardsGenerator';
import { firstRunWindowDays } from './firstRunHistory';
import { getHomeState } from './firstRunStore';
import { resolveMetaAgentBehaviour } from './settings';

/**
 * The first run's messages in the Meta agent's window conversation: what it
 * reads at the start, one line per workspace home, and at the end what it
 * wrote with one question. They are stored as assistant messages of that
 * conversation under ids derived from the run, so a restart or a second
 * caller never posts one twice. No model call: the lines come from what the
 * run already holds, the end from the Spaces Home summary's own reply.
 */

/** Message metadata key; the window reads its options from here. */
export const NARRATION_KEY = 'metaAgentNarration';
export const FIRST_RUN_POLL_SECONDS = 60;

export interface NarrationOption {
  label: string;
  /** Opens this conversation with `draft` in its composer instead of answering. */
  open?: { nodeId: string; workspaceId: string; draft: string };
}

export interface Narration {
  kind: 'start' | 'workspace' | 'end' | 'notice';
  workspaceId?: string;
  options?: NarrationOption[];
}

const LINE_MAX = 240;
const OPTION_MAX = 60;
const DRAFT_MAX = 2_000;
const TEXT_MAX = 600;

const startId = (requestedAt: number) => `mna-start-${requestedAt}`;
const endId = (requestedAt: number) => `mna-end-${requestedAt}`;
const workspaceLineId = (workspaceId: string, startedAt: number, state: string) =>
  `mna-ws-${createHash('sha256').update(workspaceId).digest('hex').slice(0, 16)}-${startedAt}-${state}`;

interface WindowConversation { nodeId: string; workspaceId: string }

/** The window's conversation; none on a cloud backend, which has no assistant. */
function windowConversation(): WindowConversation | null {
  if (process.env.MICHI_CLOUD === '1') return null;
  try {
    const info = ensureAssistant();
    return { nodeId: info.nodeId, workspaceId: info.workspaceId };
  } catch (error) {
    log.warn('scheduler', 'Meta agent narration has no conversation', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function posted(id: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM messages WHERE id=?').get(id);
}

/** Appends one assistant message; false when it is already there. Options become the conversation's follow-up rows. */
function post(conversation: WindowConversation, id: string, text: string, narration: Narration, now: number): boolean {
  if (posted(id)) return false;
  const seq = (getDb().prepare('SELECT COALESCE(MAX(seq), -1) AS seq FROM messages WHERE node_id=?').get(conversation.nodeId) as { seq: number }).seq + 1;
  saveMessage({ id, node_id: conversation.nodeId, role: 'assistant', content: text, seq, created_at: now,
    metadata: JSON.stringify({ [NARRATION_KEY]: narration }) });
  if (narration.options?.length) {
    getDb().prepare('UPDATE nodes SET follow_ups=?, follow_ups_source_message_id=? WHERE id=?')
      .run(JSON.stringify(narration.options.map((option) => option.label)), id, conversation.nodeId);
  }
  return true;
}

const label = (value: string) => value.replace(/[[\]\n]/g, ' ').trim() || 'Untitled';

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function homeLink(home: { workspaceName: string; homePageId: string | null }): string {
  return home.homePageId ? `[${label(home.workspaceName)}](michi://page/${home.homePageId})` : `**${label(home.workspaceName)}**`;
}

/** The one sentence on where the workspace stands, as the first run wrote it; '' when the home has no blocks. */
function standing(homePageId: string | null, ownerUserId: string): string | null {
  if (!homePageId) return null;
  try {
    const blocks = getPage(homePageId, ownerUserId).blocks as PageBlock[];
    if (!blocks.length) return '';
    const callout = blocks.find((block) => block.type === 'callout' && !block.edit) as { text?: string } | undefined;
    return callout?.text?.trim() ? clip(callout.text, LINE_MAX) : null;
  } catch {
    return null;
  }
}

function shownHomes(ownerUserId: string) {
  return listWorkspaceHomes(ownerUserId).filter((home) => home.hiddenAt === null && home.firstRun);
}

function startText(ownerUserId: string): string | null {
  const homes = shownHomes(ownerUserId).filter((home) => home.firstRun!.total > 0);
  if (!homes.length) return null;
  const total = homes.reduce((sum, home) => sum + home.firstRun!.total, 0);
  const days = Math.max(...homes.map((home) => firstRunWindowDays(home.workspaceId, ownerUserId)));
  const summary = resolveMetaAgentBehaviour(ownerUserId).maintainSpacesHome
    ? ' Then I read those homes, not the conversations, and write the global part of the Spaces Home.' : '';
  return [
    `First time in Spaces: I'm reading the last ${days} days of history, ${total} conversation${total === 1 ? '' : 's'} in ${homes.length} workspace${homes.length === 1 ? '' : 's'}, and writing a home for each workspace.${summary}`,
    `The first time, I read each past conversation once. After that I check every ${FIRST_RUN_POLL_SECONDS} seconds and read only conversations that finish. When nothing is new, no AI is used.`,
  ].join('\n\n');
}

/** The start message, once per opening of Spaces on this connection, while something is still to read. */
export function narrateFirstRunStart(ownerUserId: string, now: number): void {
  const state = getHomeState(ownerUserId);
  if (!state || posted(startId(state.requestedAt))) return;
  const reading = shownHomes(ownerUserId).some((home) => ['queued', 'reading', 'writing'].includes(home.firstRun!.state) && home.firstRun!.total > 0);
  if (!reading) return;
  const text = startText(ownerUserId);
  const conversation = text ? windowConversation() : null;
  if (text && conversation) post(conversation, startId(state.requestedAt), text, { kind: 'start' }, now);
}

/** One line for each workspace whose first run ended since the last call. */
export function narrateFirstRunProgress(ownerUserId: string, now: number): void {
  const state = getHomeState(ownerUserId);
  if (!state) return;
  const ended = shownHomes(ownerUserId).filter((home) => home.firstRun!.total > 0
    && (home.firstRun!.state === 'done' || home.firstRun!.state === 'failed')
    && !posted(workspaceLineId(home.workspaceId, home.firstRun!.startedAt, home.firstRun!.state)));
  if (!ended.length) return;
  const conversation = windowConversation();
  if (!conversation) return;
  for (const home of ended) {
    const run = home.firstRun!;
    let text: string;
    if (run.state === 'failed') {
      text = `${homeLink(home)}: the home was not written: ${clip(run.error ?? 'unknown reason', LINE_MAX)} Retry it from the Spaces Home.`;
    } else {
      const line = standing(home.homePageId, ownerUserId);
      const conversations = `${run.total} conversation${run.total === 1 ? '' : 's'}`;
      text = line === '' ? `${homeLink(home)}: nothing in its ${conversations} needed a home page yet.`
        : line ? `${homeLink(home)} home is written: ${line}` : `${homeLink(home)} home is written from ${conversations}.`;
    }
    post(conversation, workspaceLineId(home.workspaceId, run.startedAt, run.state), text, { kind: 'workspace', workspaceId: home.workspaceId }, now);
  }
}

export function firstRunEndPosted(ownerUserId: string): boolean {
  const state = getHomeState(ownerUserId);
  return !state || posted(endId(state.requestedAt));
}

/** Added to the Spaces Home summary prompt while the first run's closing message is still to come. */
export function firstRunEndPrompt(): string {
  return [
    '5. This summary closes the first-time generation. In the same json block add a "firstRun" field:',
    '   {"wrote":"…","lookFirst":"…","question":"…","options":["…","…"],"continueIn":{"nodeId":"…","label":"…","draft":"…"}}',
    '   wrote: one sentence on what was written (how many workspace homes, the global part of the Spaces Home).',
    '   lookFirst: one sentence on what the user should look at first today; link a page as [title](michi://page/<pageId>).',
    '   question: one thing you are unsure about that only the user can settle, for example a workspace that has not moved for two weeks: still waiting for review, or dropped?',
    `   options: two or three short answers the user can pick (each under ${OPTION_MAX} characters). Nothing happens until they pick one.`,
    '   continueIn: optional, only when the question is best answered inside one conversation the homes cite: its node id, a short option label, and the message to put in its composer (never sent by itself).',
    '   Write these in the language the workspace homes use.',
  ].join('\n');
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? clip(value, max) : null;

function conversationWorkspace(nodeId: string, ownerUserId: string): string | null {
  const row = getDb().prepare("SELECT workspace_id FROM nodes WHERE id=? AND kind='chat' AND deleted_at IS NULL AND maintenance_job_id IS NULL")
    .get(nodeId) as { workspace_id: string } | undefined;
  if (!row) return null;
  return listWorkspaceHomes(ownerUserId).some((home) => home.workspaceId === row.workspace_id) ? row.workspace_id : null;
}

/** The closing message the summary reply carries, or null when it has none that holds. */
export function parseFirstRunEnd(reply: string, ownerUserId: string): { text: string; options: NarrationOption[] } | null {
  const json = extractCardsJson(reply);
  const value = isObject(json) && isObject(json.firstRun) ? json.firstRun : null;
  if (!value) return null;
  const wrote = str(value.wrote, TEXT_MAX);
  const lookFirst = str(value.lookFirst, TEXT_MAX);
  const question = str(value.question, TEXT_MAX);
  const options: NarrationOption[] = [];
  const labels = new Set<string>();
  for (const raw of Array.isArray(value.options) ? value.options : []) {
    const option = str(raw, OPTION_MAX);
    if (option && !labels.has(option) && options.length < 3) { labels.add(option); options.push({ label: option }); }
  }
  const continueIn = isObject(value.continueIn) ? value.continueIn : null;
  const nodeId = continueIn && typeof continueIn.nodeId === 'string' ? continueIn.nodeId : null;
  const workspaceId = nodeId ? conversationWorkspace(nodeId, ownerUserId) : null;
  const openLabel = continueIn ? str(continueIn.label, OPTION_MAX) : null;
  const draft = continueIn ? str(continueIn.draft, DRAFT_MAX) : null;
  if (nodeId && workspaceId && openLabel && draft && !labels.has(openLabel)) {
    if (options.length === 3) options.pop();
    options.push({ label: openLabel, open: { nodeId, workspaceId, draft } });
  }
  const head = [wrote, lookFirst].filter(Boolean).join(' ');
  if (!head && !question) return null;
  return { text: [head, question && options.length ? question : null].filter(Boolean).join('\n\n'), options: question ? options : [] };
}

function fallbackEnd(ownerUserId: string): string {
  const homes = shownHomes(ownerUserId).filter((home) => home.firstRun!.total > 0);
  const written = homes.filter((home) => home.firstRun!.state === 'done').length;
  const total = homes.reduce((sum, home) => sum + home.firstRun!.total, 0);
  const summary = resolveMetaAgentBehaviour(ownerUserId).maintainSpacesHome ? ' and the global part of the Spaces Home' : '';
  return `Done: I read ${total} conversation${total === 1 ? '' : 's'} and wrote ${written} workspace home${written === 1 ? '' : 's'}${summary}. From now on I read only new conversations.`;
}

/**
 * The closing message, once per opening: after the Spaces Home summary (from
 * its reply, when it carries one), or once every first read ended when the
 * summary is turned off.
 */
export function narrateFirstRunEnd(ownerUserId: string, summaryMessageId: string | null, now: number): boolean {
  const state = getHomeState(ownerUserId);
  if (!state || posted(endId(state.requestedAt))) return false;
  const conversation = windowConversation();
  if (!conversation) return false;
  const reply = summaryMessageId
    ? (getDb().prepare('SELECT content FROM messages WHERE id=?').get(summaryMessageId) as { content: string } | undefined)?.content ?? null
    : null;
  const parsed = reply ? parseFirstRunEnd(reply, ownerUserId) : null;
  return post(conversation, endId(state.requestedAt), parsed?.text ?? fallbackEnd(ownerUserId),
    { kind: 'end', ...(parsed?.options.length ? { options: parsed.options } : {}) }, now);
}

/** A one-off note from Michi in the window conversation, under a caller-chosen stable id. */
export function narrateNotice(id: string, text: string, now: number): boolean {
  const conversation = windowConversation();
  return conversation ? post(conversation, `mna-note-${id}`, text, { kind: 'notice' }, now) : false;
}

const UNSEEN_MAX = 3_000;
const NARRATED = `COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.${NARRATION_KEY}') END, '') <> ''`;

/**
 * What the runtime has not seen of the window conversation: the narration
 * messages posted after its last own message, newest kept when they do not fit.
 */
export function unseenNarration(nodeId: string): string[] {
  const rows = getDb().prepare(`SELECT content FROM messages WHERE node_id=? AND role='assistant' AND ${NARRATED}
      AND seq > COALESCE((SELECT MAX(seq) FROM messages WHERE node_id=? AND NOT ${NARRATED}), -1)
    ORDER BY seq DESC`).all(nodeId, nodeId) as Array<{ content: string }>;
  const kept: string[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.content.length > UNSEEN_MAX && kept.length) break;
    kept.unshift(row.content.length > UNSEEN_MAX ? `${row.content.slice(0, UNSEEN_MAX - 1)}…` : row.content);
    used += row.content.length;
  }
  return kept;
}
