import { progressCardStatusLine, progressReplyConclusion, progressReplyText, progressTurnSummary, type ProgressCardAwaiting, type ProgressCardDto, type ProgressCardStatus } from 'michi-shared';
import type { ChatMessage, ChatNodeState } from '../chatTypes';

/** What a progress card shows, read from the thread each time. */
export interface CardLiveState {
  status: ProgressCardStatus;
  /** One line about what the conversation is doing; never message text. */
  line: string;
  title: string;
  runtimeId: string | null;
  /** A running conversation waits for you: what kind of answer, and the request or question itself. */
  awaiting: ProgressCardAwaiting | null;
  waitingFor: string | null;
}

const DETAIL_MAX = 160;

function lastAssistant(node: ChatNodeState): ChatMessage | undefined {
  for (let i = node.messages.length - 1; i >= 0; i -= 1) {
    const message = node.messages[i]!;
    if (message.role === 'assistant') return message;
    if (message.role === 'user') return undefined;
  }
  return undefined;
}

/** The status line of a conversation running in this window, from its newest reply. */
export function progressStatusLine(node: ChatNodeState): string {
  return progressCardStatusLine({ awaiting: nodeAwaiting(node), activity: node.runtimeActivity, reply: lastAssistant(node) });
}

/** What kind of answer a conversation in this window waits on from you, if any. */
export function nodeAwaiting(node: ChatNodeState): ProgressCardAwaiting | null {
  if (node.pendingPermission) return 'approval';
  return node.pendingUserInput && !node.pendingUserInput.resolved ? 'question' : null;
}

function oneLine(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/** The request a conversation in this window waits on: the approval's title, or the question it asks. */
export function nodeWaitingFor(node: ChatNodeState): string | null {
  if (node.pendingPermission) return oneLine(node.pendingPermission.title);
  const question = node.pendingUserInput && !node.pendingUserInput.resolved ? node.pendingUserInput.questions?.[0] : undefined;
  return oneLine(question ? question.question || question.header : null);
}

/** What the newest turn concluded, cut like the backend's card summary: its overview entry, else its reply's conclusion. */
export function replySummary(node: ChatNodeState): string | null {
  const reply = lastAssistant(node);
  if (!reply) return null;
  const asked = [...node.messages].reverse().find((message) => message.role === 'user')?.createdAt;
  const ended = progressTurnSummary(node.branchOverviewEntries ?? [], asked);
  if (ended) return ended;
  return progressReplyConclusion(progressReplyText({ blocks: reply.blocks as ReadonlyArray<{ kind: string; rawText?: unknown }> | undefined, text: reply.text }));
}

/** The conversation's name: its title (here, else as the backend read it), else its first message's first line. */
export function threadTitle(node: ChatNodeState | undefined, fallback = ''): string {
  const title = node?.title?.trim() || fallback.trim();
  if (title) return title;
  const first = node?.messages.find((message) => message.role === 'user')?.text.trim().split('\n')[0]?.trim();
  return first || 'New chat';
}

/** The backend's line for a running conversation, which it reads from the live turn. */
const backendLine = (card: Pick<ProgressCardDto, 'statusLine'>) => card.statusLine || 'Working…';

/**
 * The card's status from the thread: the conversation streaming in this
 * window when it is (it is live), else what the backend read from the
 * thread, including what a conversation started elsewhere is doing.
 */
export function cardLiveState(
  card: Pick<ProgressCardDto, 'status' | 'title' | 'runtimeId' | 'statusLine' | 'awaiting' | 'awaitingDetail'>,
  node: ChatNodeState | undefined,
): CardLiveState {
  const runtimeId = node?.runtimeId ?? card.runtimeId;
  const title = threadTitle(node, card.title);
  const backend = (status: ProgressCardStatus): CardLiveState => {
    const awaiting = status === 'running' ? card.awaiting ?? null : null;
    return { status, line: status === 'running' ? backendLine(card) : '', title, runtimeId, awaiting, waitingFor: awaiting ? card.awaitingDetail ?? null : null };
  };
  if (!node) return backend(card.status);
  if (node.status === 'streaming' && !node.visibleResponseComplete) {
    const awaiting = nodeAwaiting(node);
    return { status: 'running', line: progressStatusLine(node), title, runtimeId, awaiting, waitingFor: awaiting ? nodeWaitingFor(node) : null };
  }
  if (node.status === 'error') return { status: 'failed', line: '', title, runtimeId, awaiting: null, waitingFor: null };
  // A reply finished here before the backend's next read saw its turn end.
  const status = card.status === 'running' || card.status === 'idle'
    ? lastAssistant(node) ? 'done' : card.status
    : card.status;
  return backend(status);
}

export function isFinished(status: ProgressCardStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}
