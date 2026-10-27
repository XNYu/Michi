import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatNodeState } from '../chatTypes';
import type { SpacesFirstRunStatus } from '../../services/api/spacesHome';

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../../services/api/persistence', () => ({ fetchTreeMessages: vi.fn(async () => rows.value) }));

import {
  fetchWindowConversation, firstRunOpensWindow, firstRunProgressKey, noteFirstRunOpenedWindow, windowConversationActions,
} from './firstRunWindow';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

const status = (state: string, requestedAt: number | null = 100): SpacesFirstRunStatus => ({
  requestedAt, haltedReason: null, summary: { state: 'waiting', summarizedAt: null },
  workspaces: [{ workspaceId: 'ws-a', workspaceName: 'A', homePageId: 'pg-a', hiddenAt: null,
    firstRun: { workspaceId: 'ws-a', startedAt: 1, startSeq: 0, readCount: 0, total: 3, state, error: null, updatedAt: 1 } }],
} as unknown as SpacesFirstRunStatus);

const message = (id: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage => ({ id, role, text: id, toolCalls: [] } as unknown as ChatMessage);
const node = (patch: Partial<ChatNodeState>): ChatNodeState => ({ nodeId: 'n-a', status: 'idle', messages: [], followUps: [], ...patch } as unknown as ChatNodeState);

describe('the first run in the window', () => {
  it('opens the window once per opening of Spaces, only while the run is going', () => {
    const storage = memoryStorage();
    expect(firstRunOpensWindow('local', status('done'), storage)).toBe(false);
    expect(firstRunOpensWindow('local', status('reading', null), storage)).toBe(false);
    expect(firstRunOpensWindow('local', status('reading'), storage)).toBe(true);
    noteFirstRunOpenedWindow('local', 100, storage);
    expect(firstRunOpensWindow('local', status('writing'), storage)).toBe(false);
    expect(firstRunOpensWindow('remote-1', status('writing'), storage)).toBe(true);
  });

  it('keys the run by what it posted', () => {
    expect(firstRunProgressKey(null)).toBe('');
    expect(firstRunProgressKey(status('reading'))).not.toBe(firstRunProgressKey(status('done')));
  });

  it('neither opens the window nor re-reads it for a Spaces Home summary after the first run', () => {
    const storage = memoryStorage();
    const later = (summary: string) => ({ ...status('done'), closed: true, summary: { state: summary, summarizedAt: 5 } } as SpacesFirstRunStatus);
    expect(firstRunOpensWindow('local', later('due'), storage)).toBe(false);
    expect(firstRunOpensWindow('local', later('running'), storage)).toBe(false);
    expect(firstRunProgressKey(later('due'))).toBe(firstRunProgressKey(later('running')));
    expect(firstRunProgressKey(later('running'))).toBe(firstRunProgressKey(later('done')));
    // The summary that closes the first run still counts: the window reads its closing message.
    const closing = { ...status('done'), summary: { state: 'running', summarizedAt: null } } as SpacesFirstRunStatus;
    expect(firstRunOpensWindow('local', closing, storage)).toBe(true);
    expect(firstRunProgressKey(closing)).not.toBe(firstRunProgressKey(later('done')));
  });

  it("reads the conversation and the last message's options", async () => {
    const open = { nodeId: 'n-b', workspaceId: 'ws-b', draft: 'Still pending?' };
    rows.value = [
      { id: 'm-1', node_id: 'n-a', role: 'assistant', content: 'Reading.', seq: 0, metadata: JSON.stringify({ metaAgentNarration: { kind: 'start' } }) },
      { id: 'm-other', node_id: 'n-x', role: 'user', content: 'elsewhere', seq: 0 },
      { id: 'm-2', node_id: 'n-a', role: 'assistant', content: 'Done. Waiting, or dropped?', seq: 1,
        metadata: JSON.stringify({ metaAgentNarration: { kind: 'end', options: [{ label: 'Waiting' }, { label: 'Ask there', open }, { bad: 1 }] } }) },
    ];
    const fetched = await fetchWindowConversation({ workspaceId: 'p-assistant', treeId: 't', nodeId: 'n-a' });
    expect(fetched.messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(fetched.options).toEqual([{ label: 'Waiting' }, { label: 'Ask there', open }]);
  });

  it('installs what the backend posted, never over a running turn or a message it does not have', () => {
    const fetched = { messages: [message('u-1', 'user'), message('a-1'), message('mna-end')], options: [{ label: 'Waiting' }, { label: 'Dropped' }] };
    expect(windowConversationActions(node({ messages: [message('u-1', 'user'), message('a-1')] }), fetched)).toEqual([
      { type: 'messages-loaded', nodeIds: ['n-a'], messagesByNode: { 'n-a': fetched.messages } },
      { type: 'set-follow-ups', nodeId: 'n-a', followUps: ['Waiting', 'Dropped'] },
    ]);
    expect(windowConversationActions(node({ status: 'streaming' } as Partial<ChatNodeState>), fetched)).toEqual([]);
    expect(windowConversationActions(node({ messages: [message('u-local', 'user')] }), fetched)).toEqual([]);
    expect(windowConversationActions(node({ messages: fetched.messages, followUps: ['Waiting', 'Dropped'] }), fetched)).toEqual([]);
  });
});
