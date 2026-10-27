import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SUBAGENT_UNTRACKED_ERROR, type WorkflowRunDtoV1 } from 'michi-shared';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import type { ChatMessage, ChatNodeState, SubagentInfo } from '../../../state/chatTypes';
import { WorkflowDomainProvider, type WorkflowDomainApi } from '../../../state/workflowDomain';
import BackgroundWorkDrawer from './BackgroundWorkDrawer';
import type { OpenBackgroundWorkDetail } from './backgroundWorkEvents';

const project = vi.hoisted(() => {
  const initial = () => ({
    id: 'ws', name: 'WS', chatIds: ['root', 'child', 'idle', 'unloaded', 'other-root'], createdAt: 0, activeTreeId: 'tree',
    trees: [{ id: 'tree', rootNodeId: 'root', name: 'Thread', createdAt: 0 }, { id: 'other', rootNodeId: 'other-root', name: 'Other', createdAt: 0 }],
    edges: [{ source: 'root', target: 'child' }, { source: 'root', target: 'idle' }, { source: 'child', target: 'unloaded' }],
  });
  return { initial, current: initial() };
});

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../../state/chatStore')>('../../../state/chatStore');
  return { ...actual, useChatProjects: () => ({ activeProject: project.current }) };
});

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

const assistant = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', text: '', toolCalls: [], ...patch });
const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'go', toolCalls: [] });

function chat(nodeId: string, title: string, messages: ChatMessage[], patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, title, kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status: 'idle', messagesLoaded: true, ...patch } as ChatNodeState;
}

const oldDone = subagent({ sessionId: 'old-done', agentName: 'Archivist', status: 'terminated', outcome: 'completed', prompt: 'Summarize the archive.', result: 'Archive summarized.' });
// Launched in the earlier turn, which ended 12s in; it keeps running in the background.
const oldBackground = subagent({ sessionId: 'old-bg', agentName: 'Scanner', status: 'terminated', background: true, prompt: 'Scan the repo.', startedAt: 1_000, endedAt: 13_000 });
const latestDone = subagent({ sessionId: 'latest-done', agentName: 'Planner', status: 'terminated', outcome: 'completed', result: '**Plan** ready', usage: { durationMs: 3_200, toolUses: 6 } });
const latestRunning = subagent({ sessionId: 'latest-running', agentName: 'Explore', currentTool: 'Read src/auth.ts', startedAt: 1_000, activity: [{ id: 't1', kind: 'tool', title: 'Read src/auth.ts', status: 'in_progress' }] });

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf_1', workspaceId: 'ws', nodeId: 'root', parentToolCallId: 'tool-wf',
    name: 'probe', status: 'running',
    nodes: [
      { id: 'alpha', kind: 'step', title: 'alpha', status: 'completed', result: 'ALPHA' },
      { id: 'beta', kind: 'step', title: 'beta', status: 'running', currentTool: 'Read beta.txt' },
    ],
    log: [], actions: ['pause', 'stop'], startedAt: 50, updatedAt: 60, revision: 1,
    ...patch,
  };
}

function nodes(): Record<string, ChatNodeState> {
  return {
    root: chat('root', 'Root chat', [
      user('u1'),
      assistant('a1', { subagents: [oldDone, oldBackground], toolCalls: [{ id: 'tool-wf', title: 'Workflow', status: 'completed' }] }),
      user('u2'),
      assistant('a2', { subagents: [latestDone, latestRunning] }),
    ], { status: 'streaming' }),
    child: chat('child', 'Child branch', [user('u1'), assistant('c1', { subagents: [subagent({ sessionId: 'child-agent', agentName: 'Tester', statusMessage: 'Running the suite' })] })], { status: 'streaming' }),
    idle: chat('idle', 'Quiet branch', [user('u1'), assistant('i1')]),
    unloaded: chat('unloaded', 'Not loaded yet', [], { messagesLoaded: false }),
    // Another thread, the active one in some tests.
    'other-root': chat('other-root', 'Other thread', [user('u1'), assistant('o1', { subagents: [subagent({ sessionId: 'other-agent', agentName: 'Elsewhere' })] })], { status: 'streaming' }),
  };
}

function nodeStore(initial: Record<string, ChatNodeState>) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    value: {
      getNode: (id: string) => current[id],
      getNodes: () => current,
      subscribeNode: () => () => {},
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getStructureVersion: () => 0,
      subscribeStructure: () => () => {},
    },
    set(next: Record<string, ChatNodeState>) { current = next; for (const listener of listeners) listener(); },
  };
}

function setup(request: OpenBackgroundWorkDetail, initialRuns: WorkflowRunDtoV1[] = [run()]) {
  const store = nodeStore(nodes());
  const handlers: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
  let latest = initialRuns[0];
  const api: WorkflowDomainApi = {
    list: vi.fn(),
    get: vi.fn(async () => latest),
    act: vi.fn(async (_backend, _id, action) => { latest = run({ status: action === 'stop' ? 'cancelled' : 'paused', actions: [], revision: latest.revision + 1 }); return latest; }),
    answer: vi.fn(async () => { latest = { ...latest, approvals: [], revision: latest.revision + 1 }; return latest; }),
    subscribe: vi.fn((_workspaceId, options) => {
      handlers.push(options);
      for (const value of initialRuns) options.onRun(value);
      return () => {};
    }),
  };
  const onClose = vi.fn();
  const ui = (detail: OpenBackgroundWorkDetail, seq: number) => (
    <ChatNodeStoreContext.Provider value={store.value}>
      <WorkflowDomainProvider api={api}>
        <BackgroundWorkDrawer open motion="instant" onClose={onClose} request={detail} requestSeq={seq} />
      </WorkflowDomainProvider>
    </ChatNodeStoreContext.Provider>
  );
  const result = render(ui(request, 1));
  return { ...result, store, api, handlers, onClose, reopen: (detail: OpenBackgroundWorkDetail, seq: number) => result.rerender(ui(detail, seq)) };
}

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  project.current = project.initial();
});
afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const subagentRows = () => screen.queryAllByTestId('background-subagent-row');
const rowIds = () => subagentRows().map((row) => row.getAttribute('data-subagent-id'));

describe('BackgroundWorkDrawer', () => {
  it('lists this conversation\'s work as one line per item, running first', () => {
    setup({ nodeId: 'root' });
    const dialog = screen.getByRole('dialog', { name: 'Background work' });
    expect(within(dialog).getByRole('button', { name: 'This conversation' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByTestId('background-work-running').textContent).toBe('3 running');
    // The earlier turn's finished agent is hidden; its background one still runs.
    expect(rowIds()).toEqual(['old-bg', 'latest-running', 'latest-done']);
    const [background, running, done] = subagentRows();
    expect(background.textContent).toContain('Scanner');
    expect(background.textContent).toContain('Scan the repo.');
    expect(background.textContent).toContain('in background');
    expect(background.getAttribute('data-active')).toBe('true');
    expect(running.textContent).toContain('Explore');
    expect(running.textContent).toContain('now ❯ Read src/auth.ts');
    expect(running.textContent).toContain('1 tool');
    expect(running.textContent).toContain('working');
    expect(done.textContent).toContain('Plan ready');
    expect(done.textContent).toContain('3.2s');
    expect(done.textContent).toContain('6 tools');
    expect(done.textContent).toContain('completed');
    // Rows stay one line until expanded.
    expect(screen.queryByTestId('subagent-detail')).toBeNull();

    const workflow = screen.getByTestId('background-workflow-row');
    expect(workflow.textContent).toContain('probe');
    expect(workflow.textContent).toContain('now ❯ beta ❯ Read beta.txt');
    expect(workflow.textContent).toContain('1/2 steps');
    expect(workflow.textContent).toContain('running');
  });

  it('expands and scrolls to the focused subagent, even a finished one from an earlier turn', () => {
    setup({ nodeId: 'root', focus: { kind: 'subagent', sessionId: 'old-done' } });
    expect(rowIds()).toEqual(['old-bg', 'latest-running', 'old-done', 'latest-done']);
    const row = subagentRows()[2];
    expect(within(row).getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(within(row).getByTestId('subagent-task').textContent).toBe('Summarize the archive.');
    expect(within(row).getByTestId('subagent-result').textContent).toContain('Archive summarized.');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(row);

    // One expanded at a time; a click toggles.
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    expect(screen.getAllByTestId('subagent-detail')).toHaveLength(1);
    expect(within(subagentRows()[0]).getByTestId('subagent-detail')).toBeTruthy();
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    expect(screen.queryByTestId('subagent-detail')).toBeNull();
  });

  it('switches to the whole thread, grouped by conversation', () => {
    setup({ nodeId: 'root' });
    fireEvent.click(screen.getByRole('button', { name: 'Whole thread' }));
    const groups = screen.getAllByTestId('background-work-group');
    // Quiet branch has nothing to show; the unloaded one says it is loading.
    expect(groups.map((group) => group.getAttribute('data-node-id'))).toEqual(['root', 'child', 'unloaded']);
    expect(within(groups[0]).getByTestId('background-work-group-title').textContent).toBe('Root chat');
    expect(groups[0].textContent).toContain('this conversation');
    expect(within(groups[1]).getByTestId('background-subagent-row').textContent).toContain('Running the suite');
    expect(within(groups[2]).getByRole('status').textContent).toBe('loading…');
    expect(screen.getByTestId('background-work-running').textContent).toBe('4 running');
  });

  it('scopes the whole thread to the requested conversation\'s thread, not the active one', () => {
    project.current = { ...project.initial(), activeTreeId: 'other' };
    setup({ nodeId: 'child' });
    fireEvent.click(screen.getByRole('button', { name: 'Whole thread' }));
    expect(screen.getAllByTestId('background-work-group').map((group) => group.getAttribute('data-node-id'))).toEqual(['root', 'child', 'unloaded']);
    expect(rowIds()).not.toContain('other-agent');
  });

  it('expands a workflow run with its steps, controls and approvals', async () => {
    const pending = run({
      approvals: [{ id: 'appr_1', nodeId: 'beta', title: 'Read beta.txt', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }], requestedAt: 1 }],
    });
    const { api } = setup({ nodeId: 'root', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']) } }, [pending]);
    const row = screen.getByTestId('background-workflow-row');
    expect(row.textContent).toContain('needs approval');
    expect(within(row).getByRole('button', { name: 'Workflow probe, running, needs approval' }).getAttribute('aria-expanded')).toBe('true');
    const detail = within(row).getByTestId('workflow-run-detail');
    expect(within(detail).getAllByTestId('workflow-node').map((node) => node.getAttribute('data-node-id'))).toEqual(['alpha', 'beta']);
    // The full run is fetched for the expanded view.
    expect(api.get).toHaveBeenCalledWith('local', 'wfr_1');

    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: 'Allow once' })); });
    expect(api.answer).toHaveBeenCalledWith('local', 'wfr_1', 'appr_1', 'allow');
    expect(within(row).queryByTestId('workflow-approval')).toBeNull();

    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Stop workflow probe' })); });
    expect(api.act).toHaveBeenCalledWith('local', 'wfr_1', 'stop');
    expect(row.textContent).toContain('stopped');
    expect(within(row).queryByRole('button', { name: 'Stop workflow probe' })).toBeNull();
  });

  it('updates live while open', () => {
    const { store, handlers, reopen } = setup({ nodeId: 'root' });
    act(() => handlers[0].onRun(run({ revision: 2, nodes: [{ id: 'gamma', kind: 'step', title: 'gamma', status: 'running', currentTool: 'Write out.txt' }] })));
    expect(screen.getByTestId('background-workflow-row').textContent).toContain('gamma ❯ Write out.txt');
    const next = nodes();
    next.root = chat('root', 'Root chat', [
      ...next.root.messages,
      user('u3'),
      assistant('a3', { subagents: [subagent({ sessionId: 'fresh', agentName: 'Fresh', currentTool: 'Glob' })] }),
    ], { status: 'streaming' });
    act(() => store.set(next));
    // The new turn is now the latest and its agent shows. What the drawer
    // already listed stays while it is open; the previous turn's working
    // entry no longer runs and reads as ended.
    expect(rowIds()).toEqual(['old-bg', 'fresh', 'latest-done', 'latest-running']);
    const stale = subagentRows()[3];
    expect(stale.getAttribute('data-active')).toBeNull();
    expect(stale.textContent).toContain('ended');
    expect(stale.textContent).not.toContain('now ❯');
    // A new request applies the history rule again.
    reopen({ nodeId: 'root' }, 2);
    expect(rowIds()).toEqual(['old-bg', 'fresh']);
  });

  it('keeps an expanded earlier-turn workflow run and an earlier-turn agent listed when they finish', async () => {
    const { store, handlers, reopen } = setup({ nodeId: 'root' });
    // The earlier turn's background agent finishes while expanded.
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    const next = nodes();
    next.root = chat('root', 'Root chat', next.root.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [oldDone, { ...oldBackground, outcome: 'completed' as const, result: 'Scan finished.' }] }
      : message), { status: 'streaming' });
    act(() => store.set(next));
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    const agent = subagentRows()[1];
    expect(agent.getAttribute('data-active')).toBeNull();
    expect(agent.textContent).toContain('completed');
    expect(within(agent).getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(within(agent).getByTestId('subagent-result').textContent).toContain('Scan finished.');

    // The earlier turn's workflow run finishes while expanded.
    const workflowToggle = () => within(screen.getByTestId('background-workflow-row')).getByRole('button', { name: /^Workflow probe/ });
    fireEvent.click(workflowToggle());
    await act(async () => {});
    act(() => handlers[0].onRun(run({ status: 'completed', actions: [], result: 'All read.', revision: 2, nodes: [{ id: 'alpha', kind: 'step', title: 'alpha', status: 'completed', result: 'ALPHA' }] })));
    const workflow = screen.getByTestId('background-workflow-row');
    expect(workflow.getAttribute('data-active')).toBeNull();
    expect(workflow.textContent).toContain('All read.');
    expect(workflow.textContent).toContain('completed');
    expect(workflowToggle().getAttribute('aria-expanded')).toBe('true');
    expect(within(workflow).getByTestId('workflow-run-detail')).toBeTruthy();
    // The finished agent stays too, though no longer expanded.
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-work-running').textContent).toBe('1 running');

    // Opening again applies the history rule: finished earlier-turn work is hidden.
    reopen({ nodeId: 'root' }, 2);
    expect(rowIds()).toEqual(['latest-running', 'latest-done']);
    expect(screen.queryByTestId('background-workflow-row')).toBeNull();
  });

  it('keeps finished earlier-turn work listed across a scope switch', () => {
    const { store, handlers } = setup({ nodeId: 'root' });
    // The earlier turn's background agent and workflow run finish while the drawer is open.
    const next = nodes();
    next.root = chat('root', 'Root chat', next.root.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [oldDone, { ...oldBackground, outcome: 'completed' as const, result: 'Scan finished.' }] }
      : message), { status: 'streaming' });
    act(() => store.set(next));
    act(() => handlers[0].onRun(run({ status: 'completed', actions: [], result: 'All read.', revision: 2 })));
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-workflow-row').textContent).toContain('All read.');

    fireEvent.click(screen.getByRole('button', { name: 'Whole thread' }));
    const root = () => screen.getAllByTestId('background-work-group').find((group) => group.getAttribute('data-node-id') === 'root')!;
    expect(within(root()).getAllByTestId('background-subagent-row').map((row) => row.getAttribute('data-subagent-id')))
      .toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(within(root()).getByTestId('background-workflow-row').textContent).toContain('All read.');

    fireEvent.click(screen.getByRole('button', { name: 'This conversation' }));
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-workflow-row').textContent).toContain('All read.');
  });

  it('shows a background agent a restart interrupted as stopped, with its error', () => {
    const { store } = setup({ nodeId: 'root' });
    const next = nodes();
    next.root = chat('root', 'Root chat', next.root.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [oldDone, { ...oldBackground, outcome: 'cancelled' as const, endedAt: 40_000, error: 'Interrupted: Michi restarted while this subagent was running\nexit code 143' }] }
      : message), { status: 'streaming' });
    act(() => store.set(next));
    const row = subagentRows().find((element) => element.getAttribute('data-subagent-id') === 'old-bg')!;
    expect(row.getAttribute('data-active')).toBeNull();
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-label')).toBe('Scanner, stopped: Interrupted: Michi restarted while this subagent was running');
    expect(within(row).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
    expect(toggle.textContent).not.toContain('exit code 143');
    expect(toggle.textContent).not.toContain('working');
    expect(toggle.textContent).not.toContain('in background');
    // Its recorded length, not a live clock.
    expect(toggle.textContent).toContain('39s');
    expect(screen.getByTestId('background-work-running').textContent).toBe('2 running');

    fireEvent.click(toggle);
    const detail = within(row).getByTestId('subagent-detail');
    expect(detail.textContent).toContain('Interrupted: Michi restarted while this subagent was running');
    expect(detail.textContent).not.toContain('Still running after this turn ended');
    expect(within(detail).getByTestId('subagent-meta').textContent).toContain('39s');
  });

  it('shows a background agent no live process tracks as stopped, after the running ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(601_000);
    const { handlers, reopen } = setup({ nodeId: 'root' });
    expect(rowIds()).toEqual(['old-bg', 'latest-running', 'latest-done']);
    expect(screen.getByTestId('background-work-running').textContent).toBe('3 running');
    // The feed tracks no background agent of this conversation: the
    // process that ran old-bg ended before it reported back.
    act(() => handlers[0].onBackgroundSubagents?.({ snapshot: true, nodes: { child: ['child-agent'] } }));
    // Still listed (the drawer showed it), no longer in the running group.
    expect(rowIds()).toEqual(['latest-running', 'old-bg', 'latest-done']);
    expect(screen.getByTestId('background-work-running').textContent).toBe('2 running');
    const row = subagentRows()[1];
    expect(row.getAttribute('data-active')).toBeNull();
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-label')).toBe(`Scanner, stopped: ${SUBAGENT_UNTRACKED_ERROR}`);
    expect(within(row).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
    expect(toggle.textContent).not.toMatch(/in background|working|❯/);
    // No live clock: the 10m since it started is not shown, and nothing ticks.
    expect(toggle.textContent).not.toContain('10m');
    const text = toggle.textContent;
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(within(subagentRows()[1]).getByRole('button').textContent).toBe(text);

    fireEvent.click(toggle);
    const detail = within(subagentRows()[1]).getByTestId('subagent-detail');
    expect(detail.textContent).toContain(SUBAGENT_UNTRACKED_ERROR);
    expect(detail.textContent).not.toContain('Still running after this turn ended');

    // Opening again applies the history rule: earlier-turn work that stopped is hidden.
    reopen({ nodeId: 'root' }, 2);
    expect(rowIds()).toEqual(['latest-running', 'latest-done']);
  });

  it('times a background agent from its start on a live clock, not by its launch turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(601_000);
    setup({ nodeId: 'root' });
    const background = subagentRows()[0];
    // Launched at 1s; its launch turn lasted 12s.
    expect(background.textContent).toContain('10m');
    expect(background.textContent).not.toContain('12s');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(subagentRows()[0].textContent).toContain('10m 2s');
    fireEvent.click(within(subagentRows()[0]).getByRole('button'));
    expect(within(subagentRows()[0]).getByTestId('subagent-meta').textContent).toContain('10m 2s');
  });

  it('presents a working entry the conversation no longer runs as ended', () => {
    const { store } = setup({ nodeId: 'root' });
    // The turn ended in an error before its roster was closed.
    act(() => store.set({ ...nodes(), root: { ...nodes().root, status: 'error' } }));
    const row = subagentRows().find((element) => element.getAttribute('data-subagent-id') === 'latest-running')!;
    expect(row.getAttribute('data-active')).toBeNull();
    // No now line, no clock, an ended label.
    expect(within(row).getByRole('button').textContent).toBe('Explore1 toolended▸');
    fireEvent.click(within(row).getByRole('button'));
    expect(within(row).getByTestId('subagent-detail').textContent).not.toContain('now ❯');
    expect(screen.getByTestId('background-work-running').textContent).toBe('2 running');
  });

  it('a new open request resets the scope and expands its focus', () => {
    const { reopen } = setup({ nodeId: 'root' });
    fireEvent.click(screen.getByRole('button', { name: 'Whole thread' }));
    reopen({ nodeId: 'child', focus: { kind: 'subagent', sessionId: 'child-agent' } }, 2);
    expect(screen.getByRole('button', { name: 'This conversation' }).getAttribute('aria-pressed')).toBe('true');
    expect(rowIds()).toEqual(['child-agent']);
    expect(within(subagentRows()[0]).getByTestId('subagent-detail')).toBeTruthy();
  });

  it('says so when nothing runs', () => {
    setup({ nodeId: 'idle' }, []);
    expect(screen.getByText('Nothing is running in this conversation.')).toBeTruthy();
    expect(screen.queryByTestId('background-work-running')).toBeNull();
  });
});
