import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { SUBAGENT_UNTRACKED_ERROR, type BackgroundSubagentsUpdateV1 } from 'michi-shared';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import type { ChatMessage, ChatNodeState, SubagentInfo, ToolCallState } from '../../../state/chatTypes';
import { AgentBlockStyleOverride, type AgentBlockStyle } from '../../../state/prefs';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../../state/workflowDomain';
import { ToolCallGroup } from '../ToolCallGroup';
import {
  BackgroundWorkNodeContext,
  OPEN_BACKGROUND_WORK_EVENT,
  type OpenBackgroundWorkDetail,
} from '../backgroundWork/backgroundWorkEvents';
import { SubagentDetail } from './SubagentDetail';
import { MessageSubagents } from './SubagentRoster';
import { delegationStatus, firstPlainLine, subagentSummary, unclaimedSubagents, withConversationTone, withDelegationStatus } from './subagentPresentation';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** The line's hint, which it carries as its description rather than in its name. */
function hintOf(line: HTMLElement): string | null | undefined {
  const hint = document.getElementById(line.getAttribute('aria-describedby') ?? '');
  return hint?.hidden ? hint.textContent : null;
}

/** Renders inside a conversation and records drawer open requests. */
function inConversation(ui: React.ReactElement) {
  const requests: OpenBackgroundWorkDetail[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  cleanups.push(() => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener));
  const result = render(<BackgroundWorkNodeContext.Provider value="node-1">{ui}</BackgroundWorkNodeContext.Provider>);
  return { ...result, requests };
}

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return {
    sessionName: '',
    agentName: '',
    initialQuery: '',
    status: 'working',
    group: '',
    dependsOn: [],
    ...patch,
  };
}

const agentTool = (id: string, status = 'in_progress'): ToolCallState => ({
  id,
  title: 'Agent',
  status,
  kind: 'tool',
  detail: JSON.stringify({ subagent_type: 'Explore', description: 'Map the auth flow' }),
});

const finished = subagent({
  sessionId: 'toolu_1',
  parentToolCallId: 'toolu_1',
  agentName: 'Explore',
  description: 'Map the auth flow',
  prompt: 'Find every place the session cookie is read.',
  status: 'terminated',
  outcome: 'completed',
  result: '**Three readers** in `src/auth.ts`.',
  model: 'haiku',
  usage: { totalTokens: 12_400, durationMs: 4_200 },
  source: 'claude',
  activity: [
    { id: 'c1', kind: 'tool', title: 'Read src/auth.ts', status: 'completed', toolKind: 'Read', detail: 'src/auth.ts', output: 'export function readCookie() {}', startedAt: 1_000, endedAt: 1_400 },
    { id: 'm1', kind: 'message', title: 'Checking the middleware next' },
  ],
});

describe('SubagentDetail', () => {
  it('shows the task, the activity trail, the result and the cost', () => {
    const { getByTestId, getAllByTestId, getByText, queryByText } = render(<SubagentDetail subagent={finished} />);
    expect(getByTestId('subagent-task').textContent).toBe('Find every place the session cookie is read.');
    const rows = getAllByTestId('subagent-activity-row');
    expect(rows.map((row) => row.getAttribute('data-activity-kind'))).toEqual(['tool', 'message']);
    expect(getByTestId('subagent-result').querySelector('strong')?.textContent).toBe('Three readers');
    expect(getByTestId('subagent-meta').textContent).toBe('haiku·12k tokens·1 tool·4.2s·claude');

    // Tool output stays folded until the row is opened.
    expect(queryByText('export function readCookie() {}')).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button'));
    expect(getByText('export function readCookie() {}')).toBeTruthy();
  });

  it('folds a long task and reports dropped steps', () => {
    const long = subagent({
      sessionId: 's',
      prompt: 'x'.repeat(900),
      activity: [{ id: 'a', kind: 'tool', title: 'Bash', status: 'in_progress' }],
      activityDropped: 4,
      currentTool: 'Bash',
    });
    const { getByTestId, getByText } = render(<SubagentDetail subagent={long} />);
    expect(getByTestId('subagent-task').textContent?.length).toBeLessThan(700);
    fireEvent.click(getByText('Show full task'));
    expect(getByTestId('subagent-task').textContent).toHaveLength(900);
    expect(getByText('4 earlier steps not kept')).toBeTruthy();
    expect(getByText(/activity · 5/)).toBeTruthy();
    expect(getByText('now ❯ Bash')).toBeTruthy();
  });

  it('gives a stopped agent\'s reason a neutral label and keeps a failure red under error', () => {
    const interrupted = subagent({ sessionId: 's', status: 'terminated', background: true, outcome: 'cancelled', error: SUBAGENT_UNTRACKED_ERROR });
    const { getByTestId, getByText, queryByText, unmount } = render(<SubagentDetail subagent={interrupted} active={false} />);
    const reason = getByTestId('subagent-error');
    expect(reason.textContent).toBe(SUBAGENT_UNTRACKED_ERROR);
    expect(reason.getAttribute('data-error-tone')).toBe('stopped');
    expect(reason.getAttribute('style')).toContain('var(--term-mid)');
    expect(reason.getAttribute('style')).not.toContain('var(--term-danger)');
    const label = getByText('why it stopped').parentElement!;
    expect(label.getAttribute('style')).toContain('var(--term-muted)');
    expect(queryByText('error')).toBeNull();
    unmount();

    const failed = subagent({ sessionId: 'f', status: 'terminated', outcome: 'failed', error: 'boom' });
    const view = render(<SubagentDetail subagent={failed} />);
    const error = view.getByTestId('subagent-error');
    expect(error.getAttribute('data-error-tone')).toBe('error');
    expect(error.getAttribute('style')).toContain('var(--term-danger)');
    expect(view.getByText('error').parentElement!.getAttribute('style')).toContain('var(--term-danger)');
    expect(view.queryByText('why it stopped')).toBeNull();
  });
});

describe('delegation status', () => {
  it('follows an exactly linked agent past its launch receipt', () => {
    const backgrounded = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1' });
    expect(delegationStatus(agentTool('toolu_1', 'completed'), [backgrounded])).toBe('in_progress');
    expect(delegationStatus(agentTool('toolu_1', 'completed'), [{ ...backgrounded, status: 'terminated', outcome: 'failed' }])).toBe('failed');
  });

  it('only trusts a heuristic legacy match while the chip runs', () => {
    const legacy = subagent({ sessionId: 'kiro-1', agentName: 'Explore' });
    expect(delegationStatus(agentTool('t1', 'in_progress'), [legacy])).toBe('in_progress');
    expect(delegationStatus(agentTool('t1', 'completed'), [legacy])).toBe('completed');
  });

  it('keeps a crew working while any agent works and fails it only when all failed', () => {
    const crew: ToolCallState = { id: 'crew', title: 'Spawning agent crew', status: 'completed', kind: 'other' };
    const a = subagent({ sessionId: 'a', parentToolCallId: 'crew', status: 'terminated', outcome: 'failed' });
    const b = subagent({ sessionId: 'b', parentToolCallId: 'crew' });
    expect(delegationStatus(crew, [a, b])).toBe('in_progress');
    expect(delegationStatus(crew, [a, { ...b, status: 'terminated', outcome: 'completed' }])).toBe('completed');
    expect(delegationStatus(crew, [a, { ...b, status: 'terminated', outcome: 'failed' }])).toBe('failed');
  });

  it('keeps a crew running while its own call runs, after every stage stopped', () => {
    const crew: ToolCallState = { id: 'crew', title: 'Spawning agent crew', status: 'in_progress', kind: 'other' };
    const stopped = (sessionId: string) => subagent({ sessionId, parentToolCallId: 'crew', status: 'terminated', outcome: 'cancelled' });
    expect(delegationStatus(crew, [stopped('a'), stopped('b')])).toBe('in_progress');
    expect(delegationStatus({ ...crew, status: 'completed' }, [stopped('a'), stopped('b')])).toBe('completed');
  });

  it('rewrites only delegation chips and keeps identity when nothing changes', () => {
    const tools = [agentTool('toolu_1', 'completed'), { id: 'r', title: 'Read x', status: 'completed', kind: 'read' }];
    const roster = [subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1' })];
    const next = withDelegationStatus(tools, roster);
    expect(next[0].status).toBe('in_progress');
    expect(next[1]).toBe(tools[1]);
    expect(withDelegationStatus(tools, [])).toBe(tools);
  });

  it('gives a lone delegation\'s chrome the conversation\'s failure and runs it only while both copies run', () => {
    const status = (own: string, tone: Parameters<typeof withConversationTone>[1]) => withConversationTone([agentTool('toolu_1', own)], tone)[0].status;
    expect(status('completed', 'failed')).toBe('failed');
    expect(status('in_progress', 'failed')).toBe('failed');
    expect(status('in_progress', 'running')).toBe('in_progress');
    // A background agent a later turn carries working: its own turn is over.
    expect(status('completed', 'running')).toBe('completed');
    for (const tone of ['completed', 'cancelled', 'background', 'ended'] as const) {
      expect(status('in_progress', tone)).toBe('completed');
      expect(status('failed', tone)).toBe('completed');
    }
    const lone = [agentTool('toolu_1', 'completed')];
    expect(withConversationTone(lone, 'completed')).toBe(lone);
    expect(withConversationTone(lone, undefined)).toBe(lone);
    const several = [agentTool('toolu_1', 'in_progress'), agentTool('toolu_2', 'in_progress')];
    expect(withConversationTone(several, 'completed')).toBe(several);
  });
});

describe('delegation chips with a linked roster', () => {
  it('plain: keeps a backgrounded agent visibly working and opens it in the drawer', () => {
    const roster = [subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', prompt: 'Find readers.', currentTool: 'Read src/auth.ts' })];
    const { getByTestId, container, rerender, requests } = inConversation(
      <ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} defaultExpanded subagents={roster} />,
    );
    const row = getByTestId('subagent-spine-row');
    expect(row.textContent).toContain('SubAgent · Explore');
    expect(row.textContent).toContain('now ❯ Read src/auth.ts');
    expect(row.textContent).toContain('working');
    // The ❯ ornament is decoration: the line's name keeps "now", not the glyph.
    expect(within(row).getByRole('button', { name: 'SubAgent · Explore now Read src/auth.ts working' })).toBe(getByTestId('subagent-summary'));
    expect(within(row).queryByRole('button', { name: /❯/ })).toBeNull();

    // The group auto-collapses when the agent (not its launch receipt) ends.
    rerender(
      <BackgroundWorkNodeContext.Provider value="node-1">
        <ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} defaultExpanded subagents={[finished]} />
      </BackgroundWorkNodeContext.Provider>,
    );
    const header = container.querySelector('button[data-toolgroup-header]') as HTMLElement;
    expect(header.textContent).toContain('completed');
    fireEvent.click(header);
    // Named by what it shows, the summary included; the drawer hint is its description.
    const line = within(getByTestId('subagent-spine-row')).getByRole('button', { name: 'SubAgent · Explore Three readers in src/auth.ts. completed 4.2s' });
    expect(hintOf(line)).toBe('Show in background work');
    // One line: the result's first line, never the result body inline.
    expect(line.textContent).toContain('Three readers in src/auth.ts.');
    expect(line.textContent).toContain('4.2s');
    expect(container.querySelector('[data-testid="subagent-result"]')).toBeNull();
    expect(container.querySelector('[data-testid="subagent-task"]')).toBeNull();
    fireEvent.click(line);
    expect(requests).toEqual([{ nodeId: 'node-1', focus: { kind: 'subagent', sessionId: 'toolu_1' } }]);
  });

  it('plain: a crew chip lists each agent on its own line', () => {
    const crew: ToolCallState = { id: 'crew', title: 'Spawning agent crew', status: 'in_progress', kind: 'other' };
    const roster = [
      subagent({ sessionId: 'a', parentToolCallId: 'crew', agentName: 'reader', initialQuery: 'Read fixture.txt' }),
      subagent({ sessionId: 'b', parentToolCallId: 'crew', agentName: 'checker', status: 'terminated', outcome: 'completed', result: 'ok' }),
    ];
    const { getByTestId, getAllByTestId, requests } = inConversation(<ToolCallGroup tools={[crew]} defaultExpanded subagents={roster} />);
    expect(getByTestId('subagent-spine-row').textContent).toContain('Spawning agent crew · 2 agents');
    const rows = getAllByTestId('subagent-row');
    expect(rows.map((row) => row.getAttribute('data-subagent-id'))).toEqual(['a', 'b']);
    expect(rows[0].textContent).toContain('Read fixture.txt');
    expect(rows[1].textContent).toContain('ok');
    fireEvent.click(within(rows[1]).getByRole('button'));
    expect(requests).toEqual([{ nodeId: 'node-1', focus: { kind: 'subagent', sessionId: 'b' } }]);
  });

  it.each(['card', 'terminal'] as const)('%s: one line with name, result and status that opens the drawer', (style) => {
    const tool: ToolCallState = { id: 'toolu_1', title: 'Task', status: 'completed', kind: 'subagent' };
    const { getByTestId, container, requests } = inConversation(
      <AgentBlockStyleOverride.Provider value={style}>
        <ToolCallGroup tools={[tool]} defaultExpanded subagents={[finished]} />
      </AgentBlockStyleOverride.Provider>,
    );
    // A completed pure-subagent group collapses; open it.
    const header = container.querySelector('button[data-toolgroup-header]');
    if (header) fireEvent.click(header);
    const card = getByTestId('subagent-card');
    const line = within(card).getByTestId('subagent-summary');
    expect(line.tagName).toBe('BUTTON');
    expect(line.textContent).toContain('Explore');
    expect(line.textContent).toContain('Three readers in src/auth.ts.');
    expect(line.textContent).toContain('completed');
    expect(within(card).queryByTestId('subagent-detail')).toBeNull();
    fireEvent.click(line);
    expect(requests).toEqual([{ nodeId: 'node-1', focus: { kind: 'subagent', sessionId: 'toolu_1' } }]);
  });

  it('renders a static line outside a conversation and for a chip without a roster', () => {
    const { getByTestId, unmount } = render(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} defaultExpanded subagents={[finished]} />);
    expect(getByTestId('subagent-summary').tagName).toBe('DIV');
    expect(getByTestId('subagent-summary').textContent).toContain('Three readers in src/auth.ts.');
    unmount();
    const { getByTestId: get } = inConversation(<ToolCallGroup tools={[agentTool('toolu_2')]} defaultExpanded />);
    const line = get('subagent-summary');
    expect(line.tagName).toBe('DIV');
    expect(line.textContent).toContain('Map the auth flow');
  });
});

describe('subagent summaries', () => {
  it('says what runs now, else what came back, else the mission', () => {
    const base = subagent({ sessionId: 's', description: 'Map the auth flow' });
    expect(subagentSummary({ ...base, currentTool: 'Read a.ts' }, { running: true })).toEqual({ tone: 'now', text: 'Read a.ts' });
    expect(subagentSummary({ ...base, statusMessage: 'Checking middleware' }, { running: true })).toEqual({ tone: 'status', text: 'Checking middleware' });
    expect(subagentSummary(finished, { running: false })).toEqual({ tone: 'result', text: 'Three readers in src/auth.ts.' });
    expect(subagentSummary({ ...finished, outcome: 'failed', error: 'boom\ntrace' }, { running: false })).toEqual({ tone: 'error', text: 'boom' });
    // A stale "working" roster under a completed chip does not claim a now line.
    expect(subagentSummary({ ...base, currentTool: 'Glob' }, { running: false })).toEqual({ tone: 'mission', text: 'Map the auth flow' });
    expect(subagentSummary(undefined, { running: true, fallback: 'From the tool input' })).toEqual({ tone: 'mission', text: 'From the tool input' });
    expect(subagentSummary(undefined, { running: true })).toBeUndefined();
  });

  it('strips markdown from a first line', () => {
    expect(firstPlainLine('\n## **Summary**\nrest')).toBe('Summary');
    expect(firstPlainLine('- `a.ts` changed')).toBe('a.ts changed');
    expect(firstPlainLine('   ')).toBeUndefined();
  });
});

describe('background agents', () => {
  it('reads "in background" on the spawning message instead of ended', () => {
    const bg = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan' });
    const { getByTestId, requests } = inConversation(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} defaultExpanded subagents={[bg]} />);
    const line = getByTestId('subagent-summary');
    expect(getByTestId('subagent-spine-row').textContent).toMatch(/in background(?! work)/);
    expect(line.hasAttribute('aria-label')).toBe(false);
    expect(within(getByTestId('subagent-spine-row')).getByRole('button', { name: 'SubAgent · Explore Map the auth flow in background' })).toBe(line);
    expect(hintOf(line)).toBe('Show in background work');
    fireEvent.click(line);
    expect(requests).toEqual([{ nodeId: 'node-1', focus: { kind: 'subagent', sessionId: 'toolu_1' } }]);
  });

  /**
   * A delegation chip in the first assistant message of conversation
   * node-1, rendered inside a store the test drives (`show` replaces the
   * conversation's messages after the launch message, and sets its status).
   * Expanded in the plain chrome unless told otherwise.
   */
  function launchedInConversation(
    launch: SubagentInfo,
    { style = 'plain', expanded = true, onRender }: { style?: AgentBlockStyle; expanded?: boolean; onRender?: () => void } = {},
  ) {
    const tools = [agentTool('toolu_1', 'completed')];
    const launched: ChatMessage[] = [
      { id: 'u1', role: 'user', text: 'go', toolCalls: [] },
      { id: 'a1', role: 'assistant', text: '', toolCalls: tools, subagents: [launch] },
    ];
    const conversation = (messages: ChatMessage[], status: ChatNodeState['status'] = 'idle'): ChatNodeState => ({ nodeId: 'node-1', kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status } as ChatNodeState);
    let current = conversation(launched);
    const listeners = new Set<() => void>();
    const store = {
      getNode: (id: string) => (id === 'node-1' ? current : undefined),
      getNodes: () => ({ 'node-1': current }),
      subscribeNode: (_id: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      subscribe: () => () => {},
      getStructureVersion: () => 0,
      subscribeStructure: () => () => {},
    };
    // The workflow-runs feed, which also says which background agents a live process tracks.
    const feeds: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { feeds.push(options); return () => {}; }),
    };
    function Subscribe() {
      const domain = useOptionalWorkflowDomain();
      React.useEffect(() => domain?.subscribeWorkspace('ws'), [domain]);
      return null;
    }
    const { getByTestId, container } = inConversation(
      <ChatNodeStoreContext.Provider value={store}>
        <WorkflowDomainProvider api={api}>
          <Subscribe />
          <AgentBlockStyleOverride.Provider value={style}>
            <React.Profiler id="group" onRender={() => onRender?.()}>
              <ToolCallGroup tools={tools} defaultExpanded={expanded} subagents={[launch]} />
            </React.Profiler>
          </AgentBlockStyleOverride.Provider>
        </WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    return {
      line: () => getByTestId('subagent-summary'),
      /** The collapsed group's header. */
      header: () => container.querySelector('button[data-toolgroup-header]') as HTMLElement,
      show: (later: ChatMessage[], status?: ChatNodeState['status']) => {
        current = conversation([...launched, ...later], status);
        act(() => { for (const listener of listeners) listener(); });
      },
      live: (update: BackgroundSubagentsUpdateV1) => act(() => feeds[0].onBackgroundSubagents?.(update)),
    };
  }

  it('reads stopped once no live process tracks it, and in background while one does', () => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const { line, live } = launchedInConversation(launch);
    expect(line().textContent).toMatch(/in background(?! work)/);
    live({ snapshot: true, nodes: { 'node-1': ['toolu_1'] } });
    expect(line().textContent).toMatch(/in background(?! work)/);

    // The process that ran it ended before it reported back.
    live({ snapshot: false, nodes: { 'node-1': [] } });
    expect(line().textContent).toContain(SUBAGENT_UNTRACKED_ERROR.split('\n')[0]);
    expect(line().textContent).toContain('stopped');
    expect(line().textContent).not.toMatch(/in background(?! work)|working/);
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
  });

  it('reads stopped, with no now line, when the working agent\'s process ended before its turn did', () => {
    // The app quit mid-turn: the launch turn never closed its roster.
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', background: true, currentTool: 'Read a.ts', prompt: 'Scan', startedAt: 1_000 });
    const { line, header, live } = launchedInConversation(launch);
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('now');
    expect(line().textContent).toContain('❯ Read a.ts');
    live({ snapshot: true, nodes: {} });
    // No longer running, the group collapses as it does when an agent ends; open it again.
    expect(header().textContent).toContain('SubAgent · Explore · stopped');
    fireEvent.click(header());
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
    expect(line().textContent).toContain(SUBAGENT_UNTRACKED_ERROR.split('\n')[0]);
    expect(line().textContent).toContain('stopped');
    expect(line().textContent).not.toContain('❯');
    expect(line().textContent).not.toContain('Read a.ts');
    expect(line().textContent).not.toMatch(/working/);
  });

  it('reads as the conversation knows it once a later turn brought its completion', () => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const { line, show } = launchedInConversation(launch);
    // (The hidden hint "Show in background work" is not the status.)
    expect(line().textContent).toMatch(/in background(?! work)/);
    // No duration while it runs: 12s was its launch turn, not the agent.
    expect(line().textContent).not.toContain('12s');

    // The CLI's own turn carries the completion.
    show([{ id: 'self', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({ sessionId: 'toolu_1', status: 'terminated', outcome: 'completed', result: 'Found **two** readers.', usage: { durationMs: 42_000 } })] }]);
    expect(line().textContent).toContain('Found two readers.');
    expect(line().textContent).toContain('completed');
    expect(line().textContent).toContain('42s');
    expect(line().textContent).not.toMatch(/in background(?! work)/);
  });

  it('keeps its outcome and result when a later turn reports it closed without one', () => {
    // A Codex child completed in a1; closing it in a2 reports a bare terminated state.
    const completed = subagent({
      sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', outcome: 'completed',
      result: 'Found 3 issues', usage: { durationMs: 9_000 }, startedAt: 1_000, endedAt: 10_000,
    });
    const { line, show } = launchedInConversation(completed);
    const name = 'SubAgent · Explore Found 3 issues completed 9.0s';
    expect(line().textContent).toContain('Found 3 issues');
    show([
      { id: 'u2', role: 'user', text: 'close it', toolCalls: [] },
      { id: 'a2', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({ sessionId: 'toolu_1', status: 'terminated' })] },
    ]);
    expect(within(line()).queryByText('ended')).toBeNull();
    expect(line().textContent).toContain('Found 3 issues');
    expect(line().textContent).toContain('completed');
    expect(within(document.body).getByRole('button', { name })).toBe(line());
  });

  it('reads stopped with its error once a restart interrupted it', () => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const { line, show } = launchedInConversation(launch);
    show([{ id: 'a2', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({
      sessionId: 'toolu_1', status: 'terminated', background: true, outcome: 'cancelled', endedAt: 40_000,
      error: 'Interrupted: Michi restarted while this subagent was running\nexit code 143',
    })] }]);
    expect(line().textContent).toContain('Interrupted: Michi restarted while this subagent was running');
    expect(line().textContent).not.toContain('exit code 143');
    expect(line().textContent).toContain('stopped');
    expect(line().textContent).not.toMatch(/in background(?! work)|working/);
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');

    // Recorded in place on its own copy, it reads the same.
    const interrupted = { ...launch, outcome: 'cancelled' as const, endedAt: 40_000, error: 'Interrupted: Michi restarted while this subagent was running' };
    const { container } = inConversation(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} defaultExpanded subagents={[interrupted]} />);
    const own = within(container).getByTestId('subagent-summary');
    expect(own.textContent).toContain('Interrupted: Michi restarted while this subagent was running');
    expect(own.textContent).toContain('stopped');
    expect(own.textContent).not.toMatch(/in background(?! work)|working/);
  });

  describe.each(['plain', 'card', 'terminal'] as const)('%s: the collapsed group', (style) => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const later = (patch: Partial<SubagentInfo>): ChatMessage[] => [
      { id: 'self', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({ sessionId: 'toolu_1', status: 'terminated', ...patch })] },
    ];

    it('reads in background while the agent runs, without running chrome, then stopped once no live process tracks it', () => {
      const { header, live } = launchedInConversation(launch, { style, expanded: false });
      expect(header().textContent).toContain('SubAgent · Explore · in background');
      expect(header().textContent).not.toContain('completed');
      // Its launch turn is over: no spinner, shimmer or done counter.
      expect(header().textContent).not.toContain('0/1');
      expect(header().querySelector('.agent-spinner, .term-shimmer, .term-dot-i--run')).toBeNull();

      live({ snapshot: true, nodes: { 'node-1': ['toolu_1'] } });
      expect(header().textContent).toContain('SubAgent · Explore · in background');
      live({ snapshot: false, nodes: { 'node-1': [] } });
      expect(header().textContent).toContain('SubAgent · Explore · stopped');
      expect(header().textContent).not.toMatch(/in background|completed/);
    });

    it('reads the outcome a later turn brought', () => {
      const { header, show } = launchedInConversation(launch, { style, expanded: false });
      show(later({ outcome: 'completed', result: 'Found two readers.' }));
      expect(header().textContent).toContain('SubAgent · Explore · completed');
      show(later({ outcome: 'failed', error: 'boom' }));
      expect(header().textContent).toContain('SubAgent · Explore · failed');
      show(later({ background: true, outcome: 'cancelled', error: 'Interrupted: Michi restarted while this subagent was running' }));
      expect(header().textContent).toContain('SubAgent · Explore · stopped');
    });

    it('reads working while the agent works in its turn', () => {
      const { header } = launchedInConversation({ ...launch, status: 'working' }, { style, expanded: false });
      expect(header().textContent).toContain('SubAgent · Explore · working');
    });

    /** The spinner, shimmer or running dot a group shows while it runs. */
    const spinner = (header: HTMLElement) => header.querySelector('.agent-spinner, .term-shimmer, .term-dot-i--run');
    /** Header text in the danger color (the failure fragment). */
    const dangerText = (header: HTMLElement) => [header, ...header.querySelectorAll('[style]')]
      .filter((el) => el.getAttribute('style')?.includes('var(--term-danger)'))
      .map((el) => el.textContent);
    const failedWords = (header: HTMLElement) => header.textContent?.match(/failed/g)?.length ?? 0;

    it('reads a later turn\'s failure as failed once, in the danger color', () => {
      const { header, show } = launchedInConversation(launch, { style, expanded: false });
      expect(dangerText(header())).toEqual([]);
      show(later({ outcome: 'failed', error: 'boom' }));
      expect(header().textContent).toContain('SubAgent · Explore · failed');
      expect(failedWords(header())).toBe(1);
      expect(dangerText(header())).toEqual([' · failed']);
      expect(spinner(header())).toBeNull();
      expect(header().textContent).not.toContain('0/1');
    });

    it('reads a failure on its own copy once, in the danger color', () => {
      const { header } = launchedInConversation({ ...launch, outcome: 'failed', error: 'boom' }, { style, expanded: false });
      expect(header().textContent).toContain('SubAgent · Explore · failed');
      expect(failedWords(header())).toBe(1);
      expect(dangerText(header())).toEqual([' · failed']);
    });

    it('neither spins nor counts under the completion a later turn brought to a launch copy left working', () => {
      // A roster that was never closed: the launch copy still says working.
      const { header, show } = launchedInConversation({ ...launch, status: 'working' }, { style, expanded: false });
      show(later({ outcome: 'completed', result: 'Found two readers.' }));
      expect(header().textContent).toContain('SubAgent · Explore · completed');
      expect(header().textContent).not.toContain('0/1');
      expect(spinner(header())).toBeNull();
      expect(dangerText(header())).toEqual([]);
    });

    it('neither spins nor counts once liveness stopped a launch copy left working', () => {
      const { header, live } = launchedInConversation({ ...launch, status: 'working' }, { style, expanded: false });
      live({ snapshot: true, nodes: {} });
      expect(header().textContent).toContain('SubAgent · Explore · stopped');
      expect(header().textContent).not.toContain('0/1');
      expect(spinner(header())).toBeNull();
    });

    it('collapses once a later turn ends a launch copy left working', () => {
      const { header, show } = launchedInConversation({ ...launch, status: 'working' }, { style, expanded: true });
      expect(header()?.textContent ?? '').not.toContain('SubAgent · Explore');
      show(later({ outcome: 'completed', result: 'Found two readers.' }));
      expect(header().textContent).toContain('SubAgent · Explore · completed');
    });

    it('does not spin for a background agent a later turn carries working', () => {
      const { header, show } = launchedInConversation(launch, { style, expanded: false });
      show([
        { id: 'u2', role: 'user', text: 'next', toolCalls: [] },
        { id: 'a2', role: 'assistant', text: '', toolCalls: [], streaming: true, subagents: [subagent({ sessionId: 'toolu_1', status: 'working', background: true })] },
      ], 'streaming');
      expect(header().textContent).toContain('SubAgent · Explore · working');
      expect(header().textContent).not.toContain('0/1');
      expect(spinner(header())).toBeNull();
    });

    it('spins with its counter while a foreground agent works in its turn', () => {
      // The plain chrome shows its running chrome on the open group's header;
      // the terminal header's running chrome is the counter alone.
      const { header } = launchedInConversation({ ...launch, status: 'working', background: false }, { style, expanded: style === 'plain' });
      expect(header().textContent).toContain('0/1');
      if (style !== 'terminal') expect(spinner(header())).not.toBeNull();
    });

    it('does not re-render on stream frames that leave the agent as it is', () => {
      let renders = 0;
      const { header, show } = launchedInConversation(launch, { style, expanded: false, onRender: () => { renders += 1; } });
      const before = renders;
      expect(before).toBeGreaterThan(0);
      show([{ id: 'u2', role: 'user', text: 'next', toolCalls: [] }, { id: 'a2', role: 'assistant', text: 'Hel', toolCalls: [], streaming: true }]);
      show([{ id: 'u2', role: 'user', text: 'next', toolCalls: [] }, { id: 'a2', role: 'assistant', text: 'Hello', toolCalls: [], streaming: true }]);
      expect(renders).toBe(before);
      expect(header().textContent).toContain('SubAgent · Explore · in background');
    });

    it('reads the tool status without a conversation or an exactly linked entry', () => {
      const collapsed = (ui: React.ReactElement) => <AgentBlockStyleOverride.Provider value={style}>{ui}</AgentBlockStyleOverride.Provider>;
      const group = <ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} defaultExpanded={false} subagents={[launch]} />;
      const headerIn = (container: HTMLElement) => container.querySelector('button[data-toolgroup-header]')!.textContent;
      // No chat node (specimens, provider-free tests).
      const bare = render(collapsed(group));
      expect(headerIn(bare.container)).toContain('SubAgent · Explore · completed');
      bare.unmount();
      // A chat node id but no store.
      const noStore = inConversation(collapsed(group));
      expect(headerIn(noStore.container)).toContain('SubAgent · Explore · completed');
      noStore.unmount();
      // A legacy entry matched by name, not linked to the chip.
      const { header } = launchedInConversation({ ...launch, parentToolCallId: undefined }, { style, expanded: false });
      expect(header().textContent).toContain('SubAgent · Explore · completed');
    });
  });

  it('explains a background agent in its detail', () => {
    const bg = subagent({ sessionId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan' });
    const { getByText } = render(<SubagentDetail subagent={bg} />);
    expect(getByText(/Its result arrives with a later reply/)).toBeTruthy();
  });

  it('names Codex children by thread id when they have no nickname', () => {
    const child = subagent({ sessionId: '01a13922-817a', source: 'codex', status: 'terminated', outcome: 'completed' });
    const { getByTestId } = render(<MessageSubagents subagents={[child]} />);
    expect(getByTestId('subagent-row').textContent).toContain('Codex 01a13922');
  });
});

describe('message-level roster', () => {
  it('shows only agents no chip in the message claims', () => {
    const crewAgent = subagent({ sessionId: 'crew-1', agentName: 'researcher', source: 'crew' });
    const roster = [finished, crewAgent];
    const unclaimed = unclaimedSubagents(roster, [agentTool('toolu_1', 'completed')]);
    expect(unclaimed.map((entry) => entry.sessionId)).toEqual(['crew-1']);

    const { getByTestId, getAllByTestId } = render(<MessageSubagents subagents={unclaimed} />);
    expect(getByTestId('message-subagents').textContent).toContain('1 working');
    expect(getAllByTestId('subagent-row')).toHaveLength(1);
  });

  it('renders nothing when every agent is claimed', () => {
    const { container } = render(<MessageSubagents subagents={unclaimedSubagents([finished], [agentTool('toolu_1')])} />);
    expect(container.firstChild).toBeNull();
  });
});
