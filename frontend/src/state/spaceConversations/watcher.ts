import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { ProgressCardDto, ProgressCardStatus } from 'michi-shared';
import { useChatNodesSnapshot, useChatPanes, useChatProjects, useStructuralSelector } from '../chatStore';
import type { ChatNodeState } from '../chatTypes';
import type { PageId } from '../commands';
import { backendConnectionIdForWorkspace } from '../../config/backendConnections';
import { markProgressCardSeen } from '../../services/api/spacesHome';
import { useProgressCards } from '../pages/useSpacesHome';
import { cardLiveState, isFinished, threadTitle } from './liveStatus';
import { dropPending, useSpaceConversationState } from './store';
import { useSpaceConversationRunner } from './runner';

/** What the area rail shows about conversations started from a Space. */
export interface SpaceConversationBadges {
  /** One of them is still running (the Scheduled dot). */
  scheduledRunning: boolean;
  /** One finished and has not been opened since (the Conversations dot). */
  conversationsDone: boolean;
}

const NO_BADGES: SpaceConversationBadges = { scheduledRunning: false, conversationsDone: false };
let badges = NO_BADGES;
const badgeListeners = new Set<() => void>();

function publishBadges(next: SpaceConversationBadges): void {
  if (next.scheduledRunning === badges.scheduledRunning && next.conversationsDone === badges.conversationsDone) return;
  badges = next;
  for (const listener of badgeListeners) listener();
}

const readBadges = () => badges;
function subscribeBadges(listener: () => void): () => void {
  badgeListeners.add(listener);
  return () => { badgeListeners.delete(listener); };
}

/** The rail's two signals; kept current by the shell's watcher. */
export function useSpaceConversationBadges(): SpaceConversationBadges {
  return useSyncExternalStore(subscribeBadges, readBadges, readBadges);
}

export function resetSpaceConversationBadgesForTests(): void {
  badges = NO_BADGES;
  for (const listener of badgeListeners) listener();
}

function statusesOf(cards: readonly ProgressCardDto[], nodes: Record<string, ChatNodeState>): string {
  return cards.map((card) => `${card.threadNodeId}\u0000${cardLiveState(card, nodes[card.threadNodeId]).status}`).join('\u0001');
}

function parseStatuses(key: string): Map<string, ProgressCardStatus> {
  const map = new Map<string, ProgressCardStatus>();
  if (!key) return map;
  for (const pair of key.split('\u0001')) {
    const [id, status] = pair.split('\u0000');
    map.set(id!, status as ProgressCardStatus);
  }
  return map;
}

export interface WatcherOptions {
  page: PageId;
  /** Opens a finished conversation from its toast. */
  onOpen: (card: ProgressCardDto) => void;
}

/**
 * Watches the active backend's progress cards from anywhere in the app: runs
 * queued starts, keeps the rail signals current, tells you when one finishes
 * while you are looking elsewhere, and marks a finished one seen once its
 * conversation is on screen (the card then goes 24 hours later).
 */
export function useSpaceConversationWatcher({ page, onOpen }: WatcherOptions): void {
  const { activeProject } = useChatProjects();
  const { focusedPane } = useChatPanes();
  const connectionId = activeProject ? backendConnectionIdForWorkspace(activeProject.id) : 'local';
  const cards = useProgressCards(connectionId);
  const refresh = cards.refresh;
  useSpaceConversationRunner(refresh);
  const { pending } = useSpaceConversationState();

  const list = useMemo(() => (cards.data ?? []).filter((card) => card.dismissedAt === null), [cards.data]);
  const statusKey = useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => statusesOf(list, nodes), [list]));
  const statuses = useMemo(() => parseStatuses(statusKey), [statusKey]);
  const nodes = useChatNodesSnapshot();
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const seenHere = useRef(new Set<string>());
  const previous = useRef(new Map<string, ProgressCardStatus>());
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const viewing = page === 'dashboard' ? focusedPane : null;

  useEffect(() => {
    for (const start of pending) {
      if (start.nodeId && list.some((card) => card.threadNodeId === start.nodeId)) dropPending(start.id);
    }
  }, [list, pending]);

  useEffect(() => {
    let finishedNow = false;
    for (const card of list) {
      const status = statuses.get(card.threadNodeId) ?? card.status;
      const before = previous.current.get(card.threadNodeId);
      if (before && !isFinished(before) && isFinished(status)) {
        finishedNow = true;
        if (status === 'done' && viewing !== card.threadNodeId) {
          toast.success(`New chat “${threadTitle(nodesRef.current[card.threadNodeId], card.title)}” finished`, {
            action: { label: 'Open', onClick: () => onOpenRef.current(card) },
          });
        }
      }
      previous.current.set(card.threadNodeId, status);
    }
    if (finishedNow) refresh();
  }, [list, refresh, statuses, viewing]);

  useEffect(() => {
    if (!viewing) return;
    const card = list.find((candidate) => candidate.threadNodeId === viewing);
    if (!card || card.seenAt !== null || seenHere.current.has(card.threadNodeId)) return;
    if (!isFinished(statuses.get(card.threadNodeId) ?? card.status)) return;
    seenHere.current.add(card.threadNodeId);
    markProgressCardSeen(card.threadNodeId, connectionId).then(refresh, () => { seenHere.current.delete(card.threadNodeId); });
  }, [connectionId, list, refresh, statuses, viewing]);

  useEffect(() => {
    let running = pending.length > 0;
    let unseen = false;
    for (const card of list) {
      const status = statuses.get(card.threadNodeId) ?? card.status;
      if (status === 'running') running = true;
      if ((status === 'done' || status === 'failed') && card.seenAt === null && !seenHere.current.has(card.threadNodeId) && viewing !== card.threadNodeId) unseen = true;
    }
    publishBadges({ scheduledRunning: running, conversationsDone: unseen });
  }, [list, pending.length, statuses, viewing]);

  useEffect(() => () => publishBadges(NO_BADGES), []);
}
