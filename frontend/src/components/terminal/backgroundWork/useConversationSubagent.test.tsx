import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { SUBAGENT_UNTRACKED_ERROR } from 'michi-shared';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import type { ChatMessage, ChatNodeState, SubagentInfo } from '../../../state/chatTypes';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../../state/workflowDomain';
import { useConversationSubagent } from './useConversationSubagent';

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

const assistant = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', text: '', toolCalls: [], ...patch });
const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'go', toolCalls: [] });

function chat(messages: ChatMessage[], patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'n1', kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status: 'idle', ...patch } as ChatNodeState;
}

/** A nodes store the test drives directly, notifying per-node subscribers like ChatProvider. */
function nodeStore(initial: Record<string, ChatNodeState>) {
  let nodes = initial;
  const byNode = new Map<string, Set<() => void>>();
  const value = {
    getNode: (id: string) => nodes[id],
    getNodes: () => nodes,
    subscribeNode: (id: string, listener: () => void) => {
      const listeners = byNode.get(id) ?? new Set();
      byNode.set(id, listeners);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribe: () => () => {},
    getStructureVersion: () => 0,
    subscribeStructure: () => () => {},
  };
  return {
    value,
    set(next: Record<string, ChatNodeState>) {
      const previous = nodes;
      nodes = next;
      for (const [id, listeners] of byNode) if (previous[id] !== next[id]) for (const listener of listeners) listener();
    },
  };
}

describe('useConversationSubagent', () => {
  const launch = subagent({ sessionId: 'bg', status: 'terminated', background: true, agentName: 'Explore', activity: [{ id: 't1', kind: 'tool', title: 'Read a.ts' }] });
  const launched = [user('u1'), assistant('a1', { subagents: [launch] })];

  it('follows the folded agent and re-renders only when it or its running state changes', () => {
    const store = nodeStore({ n1: chat(launched, { status: 'streaming' }) });
    let renders = 0;
    function Probe() {
      renders += 1;
      const state = useConversationSubagent('n1', 'bg');
      return <span data-testid="state">{state ? `${state.messageId} ${state.subagent.outcome ?? 'none'} ${state.active} ${state.subagent.activity?.length ?? 0}` : 'none'}</span>;
    }
    render(<ChatNodeStoreContext.Provider value={store.value}><Probe /></ChatNodeStoreContext.Provider>);
    expect(screen.getByTestId('state').textContent).toBe('a1 none true 1');

    // A later turn streams text: fresh node and message objects, same agent.
    const before = renders;
    act(() => store.set({ n1: chat([...launched, user('u2'), assistant('a2', { text: 'Hel', streaming: true })], { status: 'streaming' }) }));
    act(() => store.set({ n1: chat([...launched, user('u2'), assistant('a2', { text: 'Hello', streaming: true })], { status: 'streaming' }) }));
    expect(renders).toBe(before);

    // The completion arrives with the CLI's own turn: folded, launch steps kept.
    act(() => store.set({ n1: chat([...launched, assistant('self', { subagents: [subagent({ sessionId: 'bg', status: 'terminated', outcome: 'completed', result: 'done' })] })]) }));
    expect(screen.getByTestId('state').textContent).toBe('self completed false 1');
  });

  it('reads stopped once the feed says no process tracks it, and follows the feed only', () => {
    const store = nodeStore({ n1: chat(launched) });
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    let renders = 0;
    function Probe() {
      renders += 1;
      domain = useOptionalWorkflowDomain();
      const state = useConversationSubagent('n1', 'bg');
      return <span data-testid="state">{state ? `${state.subagent.outcome ?? 'none'} ${state.active} ${state.subagent.error ?? ''}` : 'none'}</span>;
    }
    render(
      <ChatNodeStoreContext.Provider value={store.value}>
        <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    expect(screen.getByTestId('state').textContent).toBe('none true ');
    act(() => { domain!.subscribeWorkspace('ws'); });
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { n1: ['bg'] } }));
    expect(screen.getByTestId('state').textContent).toBe('none true ');
    // Workflow progress and unchanged liveness do not re-render the line.
    const before = renders;
    act(() => handlers[0].onRun({
      version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
      name: 'probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
    }));
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: false, nodes: { n1: ['bg'] } }));
    expect(renders).toBe(before);
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: false, nodes: { n1: [] } }));
    expect(screen.getByTestId('state').textContent).toBe(`cancelled false ${SUBAGENT_UNTRACKED_ERROR}`);
  });

  it('is undefined without a conversation or a store', () => {
    function Probe({ nodeId }: { nodeId: string | null }) {
      return <span data-testid="state">{useConversationSubagent(nodeId, 'bg') ? 'found' : 'none'}</span>;
    }
    const { rerender } = render(<Probe nodeId="n1" />);
    expect(screen.getByTestId('state').textContent).toBe('none');
    const store = nodeStore({ n1: chat(launched) });
    rerender(<ChatNodeStoreContext.Provider value={store.value}><Probe nodeId={null} /></ChatNodeStoreContext.Provider>);
    expect(screen.getByTestId('state').textContent).toBe('none');
    rerender(<ChatNodeStoreContext.Provider value={store.value}><Probe nodeId="n1" /></ChatNodeStoreContext.Provider>);
    expect(screen.getByTestId('state').textContent).toBe('found');
  });
});
