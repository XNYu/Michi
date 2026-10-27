import { buildMessagesByNode } from '../chatHydration';
import type { ChatAction, ChatMessage, ChatNodeState } from '../chatTypes';
import { firstRunActive, firstRunClosed } from '../metaAgent/spacesFirstRun';
import { fetchTreeMessages } from '../../services/api/persistence';
import type { SpacesFirstRunStatus } from '../../services/api/spacesHome';

/**
 * The window's side of the Meta agent's first run: it opens the window once
 * per opening of Spaces, and re-reads the window conversation as the run
 * moves, since the run's messages are posted by the backend, not streamed.
 */

const OPENED_KEY = 'michi:metaChat:firstRunOpened:v1';

function opened(storage: Storage | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(OPENED_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, number> : {};
  } catch {
    return {};
  }
}

function defaultStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** True while a first run is going that has not opened the window yet; later visits and a finished run never do. */
export function firstRunOpensWindow(connectionId: string, status: SpacesFirstRunStatus | null | undefined, storage = defaultStorage()): boolean {
  if (!status || status.requestedAt === null || !firstRunActive(status)) return false;
  return opened(storage)[connectionId] !== status.requestedAt;
}

export function noteFirstRunOpenedWindow(connectionId: string, requestedAt: number, storage = defaultStorage()): void {
  try {
    storage?.setItem(OPENED_KEY, JSON.stringify({ ...opened(storage), [connectionId]: requestedAt }));
  } catch {
    // Quota or privacy mode: at worst the window opens once more.
  }
}

/** Changes whenever the first run posts something, so the window knows to re-read its conversation. Later summaries post nothing. */
export function firstRunProgressKey(status: SpacesFirstRunStatus | null | undefined): string {
  if (!status || status.requestedAt === null) return '';
  const summary = firstRunClosed(status) ? 'closed' : status.summary.state;
  return [status.requestedAt, summary, ...status.workspaces.map((home) => `${home.workspaceId}:${home.firstRun?.state ?? ''}`)].join('|');
}

/** One choice of a Meta agent question: answered by sending it, or (with `open`) by going to a conversation. */
export interface NarrationOption {
  label: string;
  open?: { nodeId: string; workspaceId: string; draft: string };
}

export interface WindowConversation {
  messages: ChatMessage[];
  /** The options of the last message, when it is a question the first run asked. */
  options: NarrationOption[];
}

function narrationOf(row: Record<string, unknown>): { kind?: unknown; options?: unknown } | null {
  if (typeof row.metadata !== 'string') return null;
  try {
    const value = (JSON.parse(row.metadata) as Record<string, unknown>).metaAgentNarration;
    return value && typeof value === 'object' ? value as { kind?: unknown; options?: unknown } : null;
  } catch {
    return null;
  }
}

function parseOptions(value: unknown): NarrationOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NarrationOption[] => {
    if (!entry || typeof entry !== 'object' || typeof (entry as NarrationOption).label !== 'string') return [];
    const { label, open } = entry as NarrationOption;
    const valid = open && typeof open.nodeId === 'string' && typeof open.workspaceId === 'string' && typeof open.draft === 'string';
    return [valid ? { label, open: { nodeId: open.nodeId, workspaceId: open.workspaceId, draft: open.draft } } : { label }];
  });
}

export async function fetchWindowConversation(ref: { workspaceId: string; treeId: string; nodeId: string }, signal?: AbortSignal): Promise<WindowConversation> {
  const rows = await fetchTreeMessages(ref.workspaceId, ref.treeId, undefined, signal);
  const own = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && (row as Record<string, unknown>).node_id === ref.nodeId);
  const messages = buildMessagesByNode(own)[ref.nodeId] ?? [];
  const last = messages.at(-1);
  const lastRow = last ? own.find((row) => row.id === last.id) : undefined;
  const narration = lastRow ? narrationOf(lastRow) : null;
  return { messages, options: narration?.kind === 'end' ? parseOptions(narration.options) : [] };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * What brings the store's copy of the window conversation up to the backend's:
 * nothing while a turn runs or while the store holds a message the backend
 * does not have yet; otherwise the backend's messages, and the question's
 * options as follow-up rows.
 */
export function windowConversationActions(local: ChatNodeState | undefined, fetched: WindowConversation): ChatAction[] {
  if (!local || local.status === 'streaming' || local.messagesLoaded === false) return [];
  const server = new Set(fetched.messages.map((message) => message.id));
  if (local.messages.some((message) => !server.has(message.id))) return [];
  const actions: ChatAction[] = [];
  const known = new Set(local.messages.map((message) => message.id));
  if (fetched.messages.some((message) => !known.has(message.id))) {
    actions.push({ type: 'messages-loaded', nodeIds: [local.nodeId], messagesByNode: { [local.nodeId]: fetched.messages } });
  }
  const labels = fetched.options.map((option) => option.label);
  if (labels.length && !sameList(labels, local.followUps ?? [])) actions.push({ type: 'set-follow-ups', nodeId: local.nodeId, followUps: labels });
  return actions;
}
