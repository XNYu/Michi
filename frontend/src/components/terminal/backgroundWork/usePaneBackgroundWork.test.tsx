import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import { resetPendingSightingsForTest } from '../../../state/backgroundWork';
import type { ChatMessage, ChatNodeState, SubagentInfo } from '../../../state/chatTypes';
import {
  WorkflowDomainProvider,
  useOptionalWorkflowDomain,
  type WorkflowDomainApi,
} from '../../../state/workflowDomain';
import { usePaneBackgroundWorkCounts } from './usePaneBackgroundWork';

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

function chat(nodeId: string, messages: ChatMessage[]): ChatNodeState {
  return { nodeId, kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status: 'streaming' } as ChatNodeState;
}

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
    name: 'probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
    ...patch,
  };
}

/** A nodes store the test drives directly, like ChatProvider's commits. */
function nodeStore(initial: Record<string, ChatNodeState>) {
  let nodes = initial;
  const listeners = new Set<() => void>();
  const value = {
    getNode: (id: string) => nodes[id],
    getNodes: () => nodes,
    subscribeNode: () => () => {},
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getStructureVersion: () => 0,
    subscribeStructure: () => () => {},
  };
  return {
    value,
    set(next: Record<string, ChatNodeState>) { nodes = next; for (const listener of listeners) listener(); },
  };
}

describe('usePaneBackgroundWorkCounts', () => {
  it('counts running work per chat pane and re-renders only when a count changes', () => {
    const working = subagent({ sessionId: 's1', currentTool: 'Read a.ts' });
    const tail = (text: string, roster: SubagentInfo[]): ChatMessage => ({ id: 'a1', role: 'assistant', text, toolCalls: [], subagents: roster, streaming: true });
    const store = nodeStore({ n1: chat('n1', [tail('', [working])]), n2: chat('n2', []) });
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    const paneIds = ['n1', 'n2', 'launcher'];
    const paneItems = { launcher: { kind: 'launcher' } };
    let renders = 0;
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    function Probe() {
      renders += 1;
      domain = useOptionalWorkflowDomain();
      const countsFor = usePaneBackgroundWorkCounts(paneIds, paneItems);
      return <span data-testid="counts">{paneIds.map((_, index) => `${countsFor(index).subagents}/${countsFor(index).workflows}`).join(' ')}</span>;
    }
    render(
      <ChatNodeStoreContext.Provider value={store.value}>
        <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    expect(screen.getByTestId('counts').textContent).toBe('1/0 0/0 0/0');

    // Stream chunks: fresh node and message objects, same counts.
    const before = renders;
    act(() => store.set({ ...store.value.getNodes(), n1: chat('n1', [tail('Hel', [working])]) }));
    act(() => store.set({ ...store.value.getNodes(), n1: chat('n1', [tail('Hello', [{ ...working, currentTool: 'Grep' }])]) }));
    expect(renders).toBe(before);

    act(() => store.set({ ...store.value.getNodes(), n1: chat('n1', [tail('Hello', [{ ...working, status: 'terminated', outcome: 'completed' }])]) }));
    expect(screen.getByTestId('counts').textContent).toBe('0/0 0/0 0/0');

    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onRun(run()));
    expect(screen.getByTestId('counts').textContent).toBe('0/1 0/0 0/0');
    const afterRun = renders;
    act(() => handlers[0].onRun(run({ revision: 2, status: 'paused' })));
    act(() => handlers[0].onRun(run({ id: 'wfr_other', nodeId: 'elsewhere' })));
    expect(renders).toBe(afterRun);
    act(() => handlers[0].onRun(run({ revision: 3, status: 'completed', actions: [] })));
    expect(screen.getByTestId('counts').textContent).toBe('0/0 0/0 0/0');
  });

  describe('with background-subagent liveness', () => {
    // One clock for when agents were first seen pending and when the feed
    // disconnected: the renderer's (fake) Date.now.
    beforeEach(() => {
      resetPendingSightingsForTest();
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
    });
    afterEach(() => {
      vi.useRealTimers();
      resetPendingSightingsForTest();
    });

    it('stops counting a background agent once the feed says no process tracks it', () => {
      // n1's launch turn ended with its agent still in the background.
      const background = subagent({ sessionId: 'bg', status: 'terminated', background: true, startedAt: 1_000 });
      const launched = (nodeId: string): ChatNodeState => ({
        ...chat(nodeId, [{ id: `${nodeId}-a1`, role: 'assistant', text: '', toolCalls: [], subagents: [{ ...background }] }]),
        status: 'idle',
      });
      const store = nodeStore({ n1: launched('n1'), n2: launched('n2') });
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      const paneIds = ['n1', 'n2'];
      const paneItems = {};
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() {
        domain = useOptionalWorkflowDomain();
        const countsFor = usePaneBackgroundWorkCounts(paneIds, paneItems);
        return <span data-testid="counts">{paneIds.map((_, index) => countsFor(index).subagents).join(' ')}</span>;
      }
      render(
        <ChatNodeStoreContext.Provider value={store.value}>
          <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
        </ChatNodeStoreContext.Provider>,
      );
      // Liveness unknown (no feed yet): counted as today.
      expect(screen.getByTestId('counts').textContent).toBe('1 1');
      act(() => { domain!.subscribeWorkspace('ws'); });
      // The snapshot lists only n2's agent: n1's ran in a process that ended.
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { n2: ['bg'] } }));
      expect(screen.getByTestId('counts').textContent).toBe('0 1');
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: false, nodes: { n2: [] } }));
      expect(screen.getByTestId('counts').textContent).toBe('0 0');
      // Disconnected at 20s: both were seen pending before it, and an ended
      // process cannot bring them back, so they stay stopped while the feed
      // reconnects.
      vi.setSystemTime(20_000);
      act(() => handlers[0].onDisconnect?.(new Error('gone')));
      expect(screen.getByTestId('counts').textContent).toBe('0 0');
    });

    it('counts agents first seen while the feed reconnects as their rosters say, until its snapshot', async () => {
      const launched = (nodeId: string, sessionId: string, startedAt: number): ChatNodeState => ({
        ...chat(nodeId, [{
          id: `${nodeId}-a1`, role: 'assistant', text: '', toolCalls: [],
          subagents: [subagent({ sessionId, status: 'terminated', background: true, startedAt })],
        }]),
        status: 'idle',
      });
      // n1's agent started long before the disconnect at 20s; n2 and n3 have none yet.
      const store = nodeStore({ n1: launched('n1', 'old', 1_000), n2: chat('n2', []), n3: chat('n3', []) });
      const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
      const api: WorkflowDomainApi = {
        list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
        subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
      };
      const paneIds = ['n1', 'n2', 'n3'];
      const paneItems = {};
      let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
      function Probe() {
        domain = useOptionalWorkflowDomain();
        const countsFor = usePaneBackgroundWorkCounts(paneIds, paneItems);
        return <span data-testid="counts">{paneIds.map((_, index) => countsFor(index).subagents).join(' ')}</span>;
      }
      render(
        <ChatNodeStoreContext.Provider value={store.value}>
          <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
        </ChatNodeStoreContext.Provider>,
      );
      let release!: () => void;
      act(() => { release = domain!.subscribeWorkspace('ws'); });
      act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: {} }));
      expect(screen.getByTestId('counts').textContent).toBe('0 0 0');
      vi.setSystemTime(20_000);
      act(() => handlers[0].onDisconnect?.(new Error('gone')));
      expect(screen.getByTestId('counts').textContent).toBe('0 0 0');

      // Agents launched during the outage: the last word predates them,
      // whatever the backend's clock stamped on them.
      vi.setSystemTime(25_000);
      act(() => store.set({ ...store.value.getNodes(), n2: launched('n2', 'kept', 1_500), n3: launched('n3', 'lost', 26_000) }));
      expect(screen.getByTestId('counts').textContent).toBe('0 1 1');

      // The reconnect's snapshot is current again: it lists n2's agent, not n3's.
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(handlers).toHaveLength(2);
      act(() => handlers[1].onBackgroundSubagents?.({ snapshot: true, nodes: { n2: ['kept'] } }));
      expect(screen.getByTestId('counts').textContent).toBe('0 1 0');

      // The last subscriber leaves: unknown, so back to the rosters' word.
      act(() => release());
      expect(screen.getByTestId('counts').textContent).toBe('1 1 1');
    });
  });
});
