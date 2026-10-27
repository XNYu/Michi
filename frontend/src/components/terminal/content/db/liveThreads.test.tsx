import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MichiDbRow, ThreadCardItem } from 'michi-shared';
import { conversationLookup, linkedConversationWaits, LiveThreadsContext, taskLastActivity, threadNowLine, ThreadChips, type LiveThreads } from './liveThreads';

const card = (nodeId: string, state: ThreadCardItem['state'], extra: Partial<ThreadCardItem> = {}): ThreadCardItem =>
  ({ nodeId, workspaceId: 'ws', title: `Chat ${nodeId}`, state, summary: '', at: 10, messageId: null, ...extra });
const live = (items: ThreadCardItem[], extra: Partial<LiveThreads> = {}): LiveThreads =>
  ({ byNode: new Map(items.map((item) => [item.nodeId, item])), loaded: true, failed: false, workspaceId: 'ws', ...extra });
const row = (values: MichiDbRow['values'], updatedAt = 1): MichiDbRow => ({ id: 'r', values, position: 0, updatedAt });

describe('linked conversations as they stand now', () => {
  it('draws up to three pills with their dot and title, then +N, and opens one without opening the card', () => {
    const open = vi.fn();
    const outer = vi.fn();
    render(<LiveThreadsContext.Provider value={live([card('a', 'waiting'), card('b', 'running'), card('c', 'done'), card('d', 'idle')], { open })}>
      <div onClick={outer}><ThreadChips nodeIds={['a', 'b', 'c', 'd']} /></div>
    </LiveThreadsContext.Provider>);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Chat a', 'Chat b', 'Chat c']);
    expect(screen.getByText('+1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Chat b/ }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'b' }));
    expect(outer).not.toHaveBeenCalled();
  });

  it('says a conversation deleted or moved away is no longer here, once the states are read', () => {
    const { rerender } = render(<LiveThreadsContext.Provider value={live([], { loaded: false })}><ThreadChips nodeIds={['gone']} /></LiveThreadsContext.Provider>);
    expect(screen.queryByText('No longer here')).toBeNull();
    rerender(<LiveThreadsContext.Provider value={live([card('gone', 'done', { workspaceId: 'elsewhere' })])}><ThreadChips nodeIds={['gone']} /></LiveThreadsContext.Provider>);
    expect(screen.getByText('No longer here')).toBeTruthy();
  });

  it('takes a conversation from any workspace when the host has checked the workspaces (All tasks)', () => {
    render(<LiveThreadsContext.Provider value={live([card('a', 'waiting', { workspaceId: 'elsewhere' })], { workspaceId: null, open: vi.fn() })}>
      <ThreadChips nodeIds={['a']} />
    </LiveThreadsContext.Provider>);
    expect(screen.getByRole('button', { name: /Chat a/ })).toBeTruthy();
  });

  it('reads a waiting conversation for filters and cards, but not on a task that already waits on you', () => {
    const states = live([card('a', 'waiting', { at: 50 }), card('b', 'stalled', { at: 70 })]);
    expect(conversationLookup(states)?.('a')).toEqual({ waiting: true, title: 'Chat a' });
    expect(conversationLookup(states)?.('b')).toEqual({ waiting: false, title: 'Chat b' });
    expect(conversationLookup(null)).toBeUndefined();
    expect(linkedConversationWaits(row({ status: 'doing', threads: ['a'] }), states)).toBe(true);
    expect(linkedConversationWaits(row({ status: 'waiting', threads: ['a'] }), states)).toBe(false);
    expect(linkedConversationWaits(row({ status: 'doing', threads: ['b'] }), states)).toBe(false);
    expect(taskLastActivity(row({ threads: ['a', 'b'] }), states)).toBe(70);
    expect(taskLastActivity(row({}, 5), states)).toBe(5);
  });
});

describe('threadNowLine', () => {
  it.each([
    ['waiting', 'Asked: Which one?', 'Asked: Which one?', 'Asked: Which one?'],
    ['waiting', '', 'Waiting on you', 'Waiting on you'],
    ['running', 'Reading the schema', 'Running · Reading the schema', 'Reading the schema'],
    ['running', '', 'Running', 'Running'],
    ['idle', '', 'Not started yet', 'Not started yet'],
    ['done', 'All set', 'All set', 'All set'],
    ['done', '', '', ''],
  ] as const)('%s with %j', (state, summary, withPrefix, without) => {
    expect(threadNowLine({ state, summary }, { runningPrefix: true })).toBe(withPrefix);
    expect(threadNowLine({ state, summary }, { runningPrefix: false })).toBe(without);
  });
});
