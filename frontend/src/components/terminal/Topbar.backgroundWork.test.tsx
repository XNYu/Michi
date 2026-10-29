/**
 * Topbar → PaneCaption wiring for the background work badge: each caption
 * gets its own pane's counts (browser panes have no caption, so indexes must
 * stay aligned after they are filtered out), and only chat panes show one.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import TerminalTopbar from './Topbar';
import { ChatNodeStoreContext } from '../../state/chatStore';
import type { ChatMessage, ChatNodeState, SubagentInfo } from '../../state/chatTypes';
import { PrefsProvider } from '../../state/prefs';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../state/workflowDomain';

const panes = vi.hoisted(() => ({
  openPanes: ['n1', 'web', 'd1', 'n2', 'n3', 'launcher'],
  paneItems: {
    web: { id: 'web', kind: 'browser', projectId: 'ws', treeId: 't1', title: 'Web', createdAt: 1, url: 'https://example.com' },
    launcher: { id: 'launcher', kind: 'launcher', projectId: 'ws', treeId: 't1', title: 'New pane', createdAt: 1 },
  } as Record<string, unknown>,
}));

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  const project = {
    id: 'ws', name: 'WS', chatIds: ['n1', 'd1', 'n2', 'n3'], createdAt: 0, activeTreeId: 't1',
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 0 }], edges: [],
  };
  const noop = () => {};
  return {
    ...actual,
    useChatProjects: () => ({ activeProject: project, projects: [project], focusedNodeId: 'n1', canNavBack: false, canNavForward: false }),
    useChatPanes: () => ({ openPanes: panes.openPanes, focusedPane: 'n1', paneItems: panes.paneItems }),
    useChatActions: () => ({ focusPane: noop, closePane: noop, reorderPane: noop, setPaneWidth: noop, navBack: noop, navForward: noop }),
  };
});

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }), triggerUpdate: vi.fn() };
});

vi.mock('../../lib/electronBridge', () => ({ getElectron: () => null }));

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

function node(nodeId: string, patch: Partial<ChatNodeState> = {}, roster?: SubagentInfo[]): ChatNodeState {
  const messages: ChatMessage[] = [
    { id: `${nodeId}-u`, role: 'user', text: 'go', toolCalls: [] },
    { id: `${nodeId}-a`, role: 'assistant', text: '', toolCalls: [], subagents: roster },
  ];
  return { nodeId, kind: 'chat', chatId: null, projectId: 'ws', title: `title-${nodeId}`, messages, followUps: [], status: 'idle', ...patch } as ChatNodeState;
}

function run(patch: Partial<WorkflowRunDtoV1> & { id: string; nodeId: string }): WorkflowRunDtoV1 {
  return {
    version: 1, runtime: 'kiro', nativeId: `native-${patch.id}`, workspaceId: 'ws', parentToolCallId: null,
    name: patch.id, status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
    ...patch,
  };
}

function nodeStore(initial: Record<string, ChatNodeState>) {
  let nodes = initial;
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    value: {
      getNode: (id: string) => nodes[id],
      getNodes: () => nodes,
      subscribeNode: () => () => {},
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getStructureVersion: () => version,
      subscribeStructure: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    set(next: Record<string, ChatNodeState>) { nodes = next; version += 1; for (const listener of listeners) listener(); },
  };
}

function Subscribe() {
  const domain = useOptionalWorkflowDomain();
  React.useEffect(() => domain?.subscribeWorkspace('ws'), [domain]);
  return null;
}

describe('Topbar background work badges', () => {
  it('gives each chat pane caption its own counts', () => {
    const store = nodeStore({
      // A working agent in the streaming turn.
      n1: node('n1', { status: 'streaming' }, [subagent({ sessionId: 'a' })]),
      // A digest pane never shows a badge, whatever it holds.
      d1: node('d1', { kind: 'digest', status: 'streaming' }, [subagent({ sessionId: 'b' })]),
      // Nothing runs.
      n2: node('n2'),
      // A background agent and a workflow.
      n3: node('n3', {}, [subagent({ sessionId: 'c', status: 'terminated', background: true })]),
    });
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    const { container } = render(
      <PrefsProvider>
        <ChatNodeStoreContext.Provider value={store.value}>
          <WorkflowDomainProvider api={api}>
            <Subscribe />
            <TerminalTopbar page="dashboard" onNav={() => {}} sidebarCollapsed={false} onToggleSidebar={() => {}} />
          </WorkflowDomainProvider>
        </ChatNodeStoreContext.Provider>
      </PrefsProvider>,
    );
    act(() => handlers[0].onRun(run({ id: 'wf', nodeId: 'n3' })));

    const captions = Array.from(container.querySelectorAll<HTMLElement>('[data-pane-caption-id]'));
    // The browser pane has no caption.
    expect(captions.map((cell) => cell.dataset.paneCaptionId)).toEqual(['n1', 'd1', 'n2', 'n3', 'launcher']);
    const badgeOf = (id: string) => container.querySelector(`[data-pane-caption-id="${id}"] [data-testid="pane-background-work-badge"]`);
    expect(badgeOf('n1')?.getAttribute('aria-label')).toBe('1 subagent running. Show background work');
    expect(badgeOf('n3')?.getAttribute('aria-label')).toBe('1 subagent · 1 workflow running. Show background work');
    expect(badgeOf('n3')?.textContent).toBe('◆2');
    expect(badgeOf('d1')).toBeNull();
    expect(badgeOf('n2')).toBeNull();
    expect(badgeOf('launcher')).toBeNull();

    // n1's agent finishes: only its badge goes.
    act(() => store.set({ ...store.value.getNodes(), n1: node('n1', { status: 'streaming' }, [subagent({ sessionId: 'a', status: 'terminated', outcome: 'completed' })]) }));
    expect(badgeOf('n1')).toBeNull();
    expect(badgeOf('n3')?.textContent).toBe('◆2');

    // The feed's snapshot lists no live background agent for n3: the
    // process that ran it ended, so only the workflow still counts.
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: {} }));
    expect(badgeOf('n3')?.textContent).toBe('◆1');
    expect(badgeOf('n3')?.getAttribute('aria-label')).toBe('1 workflow running. Show background work');
  });
});

describe('Topbar background work button', () => {
  function mount(nodes: Record<string, ChatNodeState>) {
    const store = nodeStore(nodes);
    const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { handlers.push(options); return () => {}; }),
    };
    const view = render(
      <PrefsProvider>
        <ChatNodeStoreContext.Provider value={store.value}>
          <WorkflowDomainProvider api={api}>
            <Subscribe />
            <TerminalTopbar page="dashboard" onNav={() => {}} sidebarCollapsed={false} onToggleSidebar={() => {}} />
          </WorkflowDomainProvider>
        </ChatNodeStoreContext.Provider>
      </PrefsProvider>,
    );
    const button = () => view.container.querySelector<HTMLElement>('[data-testid="topbar-background-work"]');
    return { store, handlers, button };
  }

  it("speaks for the focused conversation's crew: running, waiting for approval, then finished", () => {
    const crew = (status: SubagentInfo['status'], outcome?: SubagentInfo['outcome']) =>
      ['a', 'b', 'c'].map((sessionId) => subagent({ sessionId, status, ...(outcome ? { outcome } : {}) }));
    const { store, button } = mount({ n1: node('n1', { status: 'streaming' }, crew('working')), n2: node('n2'), n3: node('n3') });
    expect(button()?.dataset.state).toBe('running');
    expect(button()?.textContent).toBe('◆3');
    expect(button()?.getAttribute('aria-label')).toBe('3 subagents running. Show background work');

    // A subagent's approval is shown in the parent's chat.
    act(() => store.set({ ...store.value.getNodes(), n1: node('n1', {
      status: 'streaming', pendingPermission: { requestId: 1, title: 'Running: ls (subagent probe)', options: [] },
    }, crew('working')) }));
    expect(button()?.dataset.state).toBe('waiting');
    expect(button()?.getAttribute('aria-label')).toBe('3 subagents running · waiting for your approval. Show background work');

    // The turn ended: what it started stays listed, muted.
    act(() => store.set({ ...store.value.getNodes(), n1: node('n1', {}, crew('terminated', 'completed')) }));
    expect(button()?.dataset.state).toBe('done');
    expect(button()?.textContent).toBe('◆3');
    expect(button()?.getAttribute('aria-label')).toBe('3 background items finished. Show background work');

    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener('michi:open-background-work', listener);
    act(() => button()!.click());
    window.removeEventListener('michi:open-background-work', listener);
    expect(opened).toEqual([{ nodeId: 'n1' }]);
  });

  it('falls back to another open conversation with running work, and hides when there is none', () => {
    const { store, handlers, button } = mount({ n1: node('n1'), n2: node('n2'), n3: node('n3') });
    expect(button()).toBeNull();
    act(() => handlers[0].onRun(run({ id: 'wf', nodeId: 'n3' })));
    expect(button()?.getAttribute('aria-label')).toBe('1 workflow running. Show background work');
    act(() => handlers[0].onRun(run({ id: 'wf', nodeId: 'n3', status: 'completed', actions: [], revision: 2 })));
    // n3 is not focused and nothing of it runs any more.
    expect(button()).toBeNull();
    act(() => store.set({ ...store.value.getNodes(), d1: node('d1', { kind: 'digest', status: 'streaming' }, [subagent({ sessionId: 'x' })]) }));
    expect(button()).toBeNull();
  });
});
