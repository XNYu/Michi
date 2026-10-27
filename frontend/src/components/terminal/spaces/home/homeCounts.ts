import { useCallback, useMemo } from 'react';
import type { HomeSectionItem, HomeWorkspaceCounts, SpacesHomeSectionsDto } from 'michi-shared';
import { useOptionalChatProjects, useStructuralSelector } from '../../../../state/chatStore';
import type { ChatNodeState } from '../../../../state/chatTypes';
import { useHomeSections, type HomeResource } from '../../../../state/pages/useSpacesHome';

/**
 * Whether the user opened a Just done conversation after it completed, by the
 * conversation sidebar's unread mark: its `viewedAt` against its last reply,
 * and the conversation on screen counts as read. A node this window has not
 * seen opened since it loaded keeps its row.
 */
export function openedSinceDone(item: HomeSectionItem, node: ChatNodeState | undefined, focusedNodeId: string | null): boolean {
  if (item.target.kind !== 'conversation') return false;
  if (item.target.nodeId === focusedNodeId) return true;
  if (!node || node.viewedAt === undefined) return false;
  return Math.max(node.lastAssistantAt ?? 0, item.at ?? 0) <= node.viewedAt;
}

/** The sections without the Just done rows the user has opened since; the total drops with them. */
export function withoutOpenedDone(sections: SpacesHomeSectionsDto, opened: ReadonlySet<string>): SpacesHomeSectionsDto {
  if (opened.size === 0) return sections;
  const items = sections.done.items.filter((item) => !opened.has(item.id));
  const dropped = sections.done.items.length - items.length;
  return { ...sections, done: { ...sections.done, items, total: Math.max(items.length, sections.done.total - dropped) } };
}

const NO_ITEMS: readonly HomeSectionItem[] = [];

/** The ids of `items` opened since they completed, joined so an unchanged answer keeps its identity. */
export function useOpenedDoneKey(items: readonly HomeSectionItem[]): string {
  const focusedNodeId = useOptionalChatProjects()?.focusedNodeId ?? null;
  const select = useCallback((nodes: Record<string, ChatNodeState>) => items
    .filter((item) => item.target.kind === 'conversation' && openedSinceDone(item, nodes[item.target.nodeId], focusedNodeId))
    .map((item) => item.id).join('\n'), [focusedNodeId, items]);
  return useStructuralSelector(select);
}

export const openedSet = (key: string): ReadonlySet<string> => new Set(key ? key.split('\n') : []);

/**
 * Waiting, Stalled and Done for a connection, counted from Michi's own
 * conversations. The rail, the sidebar and the homes take their numbers from
 * here so they always agree.
 */
export function useSpacesHomeSections(connectionId: string): HomeResource<SpacesHomeSectionsDto> {
  const resource = useHomeSections(connectionId);
  const openedKey = useOpenedDoneKey(resource.data?.done.items ?? NO_ITEMS);
  const data = useMemo(() => (resource.data ? withoutOpenedDone(resource.data, openedSet(openedKey)) : null), [openedKey, resource.data]);
  return { ...resource, data };
}

/** The "Waiting on you" total: conversations waiting for a reply plus page suggestions waiting for review. */
export function homeWaitingTotal(sections: SpacesHomeSectionsDto | null | undefined): number {
  return sections?.waiting.total ?? 0;
}

const NO_COUNTS: HomeWorkspaceCounts = { waiting: 0, stalled: 0 };

/** One workspace's Waiting and Stalled counts, for its row in the Spaces sidebar. */
export function homeWorkspaceCounts(sections: SpacesHomeSectionsDto | null | undefined, workspaceId: string): HomeWorkspaceCounts {
  return sections?.byWorkspace?.[workspaceId] ?? NO_COUNTS;
}
