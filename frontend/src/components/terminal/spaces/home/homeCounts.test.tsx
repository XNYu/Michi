import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { HomeSectionItem, SpacesHomeSectionsDto } from 'michi-shared';
import type { ChatNodeState } from '../../../../state/chatTypes';

const mocks = vi.hoisted(() => ({
  sections: null as unknown,
  nodes: {} as Record<string, Partial<ChatNodeState>>,
  focusedNodeId: null as string | null,
}));
vi.mock('../../../../state/pages/useSpacesHome', () => ({
  useHomeSections: () => ({ data: mocks.sections, status: 'ready', error: null, stale: false, refresh: () => {} }),
}));
vi.mock('../../../../state/chatStore', () => ({
  useOptionalChatProjects: () => ({ focusedNodeId: mocks.focusedNodeId }),
  useStructuralSelector: (select: (nodes: unknown) => unknown) => select(mocks.nodes),
}));

import { homeWaitingTotal, homeWorkspaceCounts, openedSinceDone, useSpacesHomeSections, withoutOpenedDone } from './homeCounts';

const done = (nodeId: string, at: number | null): HomeSectionItem => ({
  id: `conversation:${nodeId}`, kind: 'conversation', workspaceId: 'ws', workspaceName: 'w', title: nodeId, at, summary: '', agentClaim: false,
  target: { kind: 'conversation', nodeId, workspaceId: 'ws', messageId: null },
});
const node = (extra: Partial<ChatNodeState>) => extra as ChatNodeState;

describe('Spaces Home counts', () => {
  it('reads the sidebar unread mark: opened after the last reply, or on screen now', () => {
    expect(openedSinceDone(done('a', 100), node({ viewedAt: 100 }), null)).toBe(true);
    expect(openedSinceDone(done('a', 100), node({ viewedAt: 99 }), null)).toBe(false);
    expect(openedSinceDone(done('a', 100), node({ viewedAt: 150, lastAssistantAt: 200 }), null)).toBe(false);
    expect(openedSinceDone(done('a', 100), node({}), null)).toBe(false);
    expect(openedSinceDone(done('a', 100), undefined, null)).toBe(false);
    expect(openedSinceDone(done('a', 100), undefined, 'a')).toBe(true);
    const page: HomeSectionItem = { ...done('a', 1), kind: 'proposal', target: { kind: 'page', pageId: 'p', blockId: null, changeId: 'c' } };
    expect(openedSinceDone(page, node({ viewedAt: 9 }), 'a')).toBe(false);
  });

  it('drops opened Just done rows and their count, and leaves Waiting and Stalled alone', () => {
    const sections: SpacesHomeSectionsDto = {
      waiting: { items: [done('w', 1)], total: 3 }, stalled: { items: [], total: 0 },
      done: { items: [done('a', 1), done('b', 1)], total: 9, ruleIds: ['r'] }, conversations: { available: true },
      byWorkspace: { ws: { waiting: 3, stalled: 0 } },
    };
    const after = withoutOpenedDone(sections, new Set(['conversation:a']));
    expect(after.done).toEqual({ items: [done('b', 1)], total: 8, ruleIds: ['r'] });
    expect(after.waiting).toBe(sections.waiting);
    expect(withoutOpenedDone(sections, new Set())).toBe(sections);
    expect(homeWaitingTotal(after)).toBe(3);
    expect(homeWorkspaceCounts(after, 'ws')).toEqual({ waiting: 3, stalled: 0 });
    expect(homeWorkspaceCounts(after, 'other')).toEqual({ waiting: 0, stalled: 0 });
    expect(homeWorkspaceCounts(null, 'ws')).toEqual({ waiting: 0, stalled: 0 });
  });

  it('gives every reader the same sections, already without the rows you opened', () => {
    mocks.sections = { waiting: { items: [], total: 0 }, stalled: { items: [], total: 0 },
      done: { items: [done('a', 5), done('b', 5), done('c', 5)], total: 3 }, conversations: { available: true } };
    mocks.nodes = { a: { viewedAt: 6 } };
    mocks.focusedNodeId = 'c';
    const { result } = renderHook(() => useSpacesHomeSections('local'));
    expect(result.current.data?.done.items.map((item) => item.title)).toEqual(['b']);
    expect(result.current.data?.done.total).toBe(1);
  });
});
