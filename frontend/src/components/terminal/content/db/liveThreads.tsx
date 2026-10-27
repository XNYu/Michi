import React, { createContext, useContext } from 'react';
import type { HomeSectionKey, MichiDbRow, ThreadCardItem, ThreadCardState } from 'michi-shared';
import { conversationWaitsOnYou, taskThreadIds, TASK_COLUMN } from 'michi-shared';
import { ThreadStateDot, type MichiDotKind } from '../ThreadStateDot';
import { michiOneLine } from '../michiPlainText';
import { cellOf, type ConversationLookup } from './dbModel';

/** A conversation the Link picker offers: its id as a Conversations cell holds it (the server's), its title and where it stands. */
export interface ConversationChoice {
  nodeId: string;
  title: string;
  state: HomeSectionKey | null;
  at: number | null;
}

/**
 * Where the conversations a task database links stand now, read in batches by
 * the database's host. `byNode` is keyed by the ids the cells hold; a read
 * that failed keeps what the read before it said.
 */
export interface LiveThreads {
  byNode: ReadonlyMap<string, ThreadCardItem>;
  /** Every id of the current set has been read: one not among `byNode` is no longer here. */
  loaded: boolean;
  failed: boolean;
  /**
   * The database's workspace: a linked conversation anywhere else is no longer
   * here. Null on All tasks, whose host keeps only the conversations still in
   * the workspace of a task that links them.
   */
  workspaceId: string | null;
  /** The workspace's name, for a task's details. */
  workspaceName?: string;
  open?: (item: ThreadCardItem) => void;
  /** The conversations a task can link: its workspace's (on All tasks, the workspace of the row asked for). */
  loadConversations?: (row?: MichiDbRow) => Promise<ConversationChoice[]>;
}

export const LiveThreadsContext = createContext<LiveThreads | null>(null);
export const useLiveThreads = (): LiveThreads | null => useContext(LiveThreadsContext);

const CARD_KIND: Record<ThreadCardState, MichiDotKind> = { waiting: 'waiting', stalled: 'stalled', running: 'doing', done: 'done', idle: 'idea' };

/** The glyph a conversation shows: where it stands. */
export function threadCardKind(item: Pick<ThreadCardItem, 'state'>): MichiDotKind {
  return CARD_KIND[item.state] ?? 'idea';
}

/**
 * The line a conversation shows for where it stands. A waiting summary is the
 * backend's own words, shown as is; `runningPrefix` only adds "Running · ".
 */
export function threadNowLine(item: Pick<ThreadCardItem, 'state' | 'summary'>, { runningPrefix }: { runningPrefix: boolean }): string {
  const said = michiOneLine(item.summary);
  if (item.state === 'waiting') return said || 'Waiting on you';
  if (item.state === 'running') return said ? (runningPrefix ? `Running · ${said}` : said) : 'Running';
  if (item.state === 'idle') return 'Not started yet';
  return said;
}

/** A linked conversation, while it is still in the database's workspace (on All tasks, the host has checked). */
export function liveConversation(live: LiveThreads | null, nodeId: string): ThreadCardItem | undefined {
  const item = live?.byNode.get(nodeId);
  if (!item || !live) return undefined;
  return live.workspaceId === null || item.workspaceId === live.workspaceId ? item : undefined;
}

/** Live states as the filters read them: whether a linked conversation waits on the person, and its title. */
export function conversationLookup(live: LiveThreads | null): ConversationLookup | undefined {
  if (!live) return undefined;
  return (nodeId) => {
    const item = liveConversation(live, nodeId);
    return item ? { waiting: conversationWaitsOnYou(item.state), title: item.title } : undefined;
  };
}

/** A task's card stands out when a conversation it links waits on the person, unless the task already says it waits on them. */
export function linkedConversationWaits(row: MichiDbRow, live: LiveThreads | null): boolean {
  if (cellOf(row, TASK_COLUMN.status) === 'waiting') return false;
  return taskThreadIds(cellOf(row, TASK_COLUMN.threads)).some((id) => conversationWaitsOnYou(liveConversation(live, id)?.state));
}

/** When a task last moved: its linked conversations' latest move, else its own last change. */
export function taskLastActivity(row: MichiDbRow, live: LiveThreads | null): number {
  const latest = taskThreadIds(cellOf(row, TASK_COLUMN.threads)).reduce((at, id) => Math.max(at, liveConversation(live, id)?.at ?? 0), 0);
  return latest || row.updatedAt;
}

/** Up to `max` linked conversations as small pills: where each stands and its title. A click opens one, not the card around it. */
export function ThreadChips({ nodeIds, max = 3 }: { nodeIds: readonly string[]; max?: number }) {
  const live = useLiveThreads();
  const shown = nodeIds.slice(0, max);
  const rest = nodeIds.length - shown.length;
  return (
    <span className="michi-db-threads">
      {shown.map((id) => {
        const item = liveConversation(live, id);
        if (!item) {
          return (
            <span key={id} className="michi-db-thread" data-missing={live?.loaded ? 'true' : undefined}>
              <ThreadStateDot kind="idea" size={8} />
              {live?.loaded ? 'No longer here' : 'Conversation'}
            </span>
          );
        }
        if (!live?.open) {
          return (
            <span key={id} className="michi-db-thread" data-state={item.state} title={item.title}>
              <ThreadStateDot kind={threadCardKind(item)} size={8} />
              <span className="michi-db-thread__title">{item.title}</span>
            </span>
          );
        }
        return (
          <button
            key={id}
            type="button"
            className="michi-db-thread"
            data-state={item.state}
            title={item.title}
            onClick={(event) => { event.stopPropagation(); live.open?.(item); }}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ThreadStateDot kind={threadCardKind(item)} size={8} />
            <span className="michi-db-thread__title">{item.title}</span>
          </button>
        );
      })}
      {rest > 0 && <span className="michi-db-thread michi-db-thread--more">+{rest}</span>}
    </span>
  );
}
