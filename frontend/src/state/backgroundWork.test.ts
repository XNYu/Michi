import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENT_LIMITS, SUBAGENT_UNTRACKED_ERROR, type WorkflowRunDtoV1 } from 'michi-shared';
import type { ChatMessage, ChatNodeState, SubagentInfo } from './chatTypes';
import type { LocatedWorkflowRun } from './workflowDomain';
import {
  conversationSubagents,
  countActiveSubagents,
  conversationSubagentState,
  describeRunningWork,
  foldSubagentCopies,
  isSubagentActive,
  resetPendingSightingsForTest,
  sameBackgroundWorkIndicator,
  selectBackgroundWork,
  selectBackgroundWorkIndicator,
  threadConversationIds,
  workflowMessageResolver,
} from './backgroundWork';

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

const done = (sessionId: string, patch: Partial<SubagentInfo> = {}) =>
  subagent({ sessionId, status: 'terminated', outcome: 'completed', ...patch });

function assistant(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', text: '', toolCalls: [], ...patch };
}

function user(id: string): ChatMessage {
  return { id, role: 'user', text: 'go', toolCalls: [] };
}

function chat(messages: ChatMessage[], patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'n1', kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status: 'idle', ...patch } as ChatNodeState;
}

function run(patch: Partial<WorkflowRunDtoV1> & { id: string }): LocatedWorkflowRun {
  return {
    backendConnectionId: 'local',
    value: {
      version: 1, runtime: 'kiro', nativeId: `native-${patch.id}`, workspaceId: 'ws', nodeId: 'n1',
      parentToolCallId: null, name: patch.id, status: 'completed', nodes: [], log: [], actions: [],
      startedAt: 0, updatedAt: 0, revision: 1,
      ...patch,
    },
  };
}

const ids = (items: Array<{ subagent: SubagentInfo }>) => items.map((item) => item.subagent.sessionId);
const runIds = (items: Array<{ run: LocatedWorkflowRun }>) => items.map((item) => item.run.value.id);

describe('isSubagentActive', () => {
  it('counts working agents and agents still running after their turn', () => {
    expect(isSubagentActive(subagent({ sessionId: 'a' }))).toBe(true);
    expect(isSubagentActive(subagent({ sessionId: 'b', status: 'terminated', background: true }))).toBe(true);
    expect(isSubagentActive(subagent({ sessionId: 'c', status: 'terminated', background: true, outcome: 'completed' }))).toBe(false);
    expect(isSubagentActive(subagent({ sessionId: 'd', status: 'terminated' }))).toBe(false);
    expect(isSubagentActive(done('e'))).toBe(false);
  });
});

describe('conversationSubagents', () => {
  it('dedupes by sessionId, keeps first-seen order and lets the newer copy win', () => {
    const background = subagent({ sessionId: 'bg', status: 'terminated', background: true, agentName: 'Scanner' });
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [background, done('x')] }),
      user('u2'),
      assistant('a2', { subagents: [done('bg', { agentName: 'Scanner', result: 'found it' }), done('y')] }),
    ]);
    const entries = conversationSubagents(node);
    expect(entries.map((entry) => [entry.subagent.sessionId, entry.messageId])).toEqual([['bg', 'a2'], ['x', 'a1'], ['y', 'a2']]);
    expect(entries[0].subagent.result).toBe('found it');
    expect(countActiveSubagents(node)).toBe(0);
  });

  it('folds a launch copy with activity into a later completion copy without it', () => {
    // Claude background agent: the launch turn records its steps; the CLI's
    // own turn on completion carries the outcome but no activity.
    const steps = [
      { id: 't1', kind: 'tool' as const, title: 'Read a.ts', status: 'completed' },
      { id: 't2', kind: 'tool' as const, title: 'Grep x', status: 'completed' },
    ];
    const launch = subagent({
      sessionId: 'bg', status: 'terminated', background: true, agentName: 'Explore', prompt: 'Map it', description: 'Map the repo',
      model: 'haiku', startedAt: 1_000, endedAt: 5_000, activity: steps, activityDropped: 3, currentTool: 'Grep x', statusMessage: 'Searching',
    });
    const completion = subagent({
      sessionId: 'bg', status: 'terminated', outcome: 'completed', agentName: '', result: 'done', endedAt: 90_000,
      usage: { durationMs: 89_000, toolUses: 5 },
    });
    const node = chat([user('u1'), assistant('a1', { subagents: [launch] }), assistant('self', { subagents: [completion] })]);
    const [entry] = conversationSubagents(node);
    expect(entry.messageId).toBe('self');
    // The newer copy says how it stands now, even by leaving a field out.
    expect(entry.subagent).toMatchObject({ status: 'terminated', outcome: 'completed', result: 'done', endedAt: 90_000, usage: { durationMs: 89_000, toolUses: 5 } });
    expect(entry.subagent.currentTool).toBeUndefined();
    expect(entry.subagent.statusMessage).toBeUndefined();
    expect(entry.subagent.background).toBeUndefined();
    // What it lacks comes from the launch copy, the launch turn's steps included.
    expect(entry.subagent).toMatchObject({ agentName: 'Explore', prompt: 'Map it', description: 'Map the repo', model: 'haiku', startedAt: 1_000 });
    expect(entry.subagent.activity).toBe(steps);
    expect(entry.subagent.activityDropped).toBe(3);
    expect(countActiveSubagents(node)).toBe(0);
    // Unchanged copies fold to the same object.
    expect(conversationSubagents({ ...node })[0].subagent).toBe(entry.subagent);
  });

  it('looks one agent up by sessionId with whether it runs now', () => {
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [subagent({ sessionId: 'bg', status: 'terminated', background: true })] }),
      assistant('self', { subagents: [done('bg', { result: 'found it' })] }),
    ]);
    expect(conversationSubagentState(node, 'bg')).toMatchObject({ messageId: 'self', active: false, subagent: { outcome: 'completed', result: 'found it' } });
    expect(conversationSubagentState(node, 'missing')).toBeUndefined();
  });

  it('keeps the steps of every turn when both copies have some', () => {
    // Each message records only its own turn's steps: the launch turn's t1
    // and t2, then t3 while the agent keeps working in the next turn.
    const older = subagent({
      sessionId: 's', status: 'terminated', background: true, activityDropped: 2,
      activity: [
        { id: 't1', kind: 'tool', title: 'Read a.ts', status: 'completed', startedAt: 1_000, endedAt: 1_200 },
        { id: 't2', kind: 'tool', title: 'Grep x', status: 'completed', startedAt: 1_300, endedAt: 1_400 },
      ],
    });
    const newer = subagent({
      sessionId: 's', currentTool: 'Edit a.ts', activityDropped: 1,
      activity: [{ id: 't3', kind: 'tool', title: 'Edit a.ts', status: 'in_progress', startedAt: 20_000 }],
    });
    const folded = foldSubagentCopies(older, newer);
    expect(folded.activity?.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
    expect(folded.activity?.[0]).toBe(older.activity?.[0]);
    expect(folded.activity?.[2]).toMatchObject({ title: 'Edit a.ts', status: 'in_progress', startedAt: 20_000 });
    // Each copy dropped steps of its own turn.
    expect(folded.activityDropped).toBe(3);
    expect(folded).toMatchObject({ status: 'working', currentTool: 'Edit a.ts' });
    expect(folded.background).toBeUndefined();
  });

  it('lets the newer copy update a step it shares with the older one', () => {
    // A tool the launch turn started and the next turn saw finish.
    const older = subagent({
      sessionId: 's', status: 'terminated', background: true,
      activity: [
        { id: 't1', kind: 'tool', title: 'Read a.ts', status: 'completed', startedAt: 1_000, endedAt: 1_200 },
        { id: 't2', kind: 'tool', title: 'Bash npm test', status: 'in_progress', toolKind: 'Bash', startedAt: 1_300 },
      ],
    });
    const newer = subagent({
      sessionId: 's',
      activity: [
        { id: 't2', kind: 'tool', title: 'Bash npm test', status: 'completed', output: '12 passed', startedAt: 30_000, endedAt: 31_000 },
        { id: 't3', kind: 'message', title: 'Tests pass', startedAt: 31_500 },
      ],
    });
    const folded = foldSubagentCopies(older, newer);
    expect(folded.activity?.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
    // The launch turn's start stands; the newer copy brings the end.
    expect(folded.activity?.[1]).toEqual({
      id: 't2', kind: 'tool', title: 'Bash npm test', status: 'completed', toolKind: 'Bash', output: '12 passed', startedAt: 1_300, endedAt: 31_000,
    });
    expect(folded.activityDropped).toBeUndefined();
  });

  it('bounds the folded steps and counts what it drops', () => {
    const steps = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => (
      { id: `${prefix}${index}`, kind: 'tool' as const, title: `${prefix} ${index}`, status: 'completed', startedAt: index, endedAt: index }
    ));
    const older = subagent({ sessionId: 's', status: 'terminated', background: true, activity: steps('a', 50), activityDropped: 4 });
    const newer = subagent({ sessionId: 's', status: 'terminated', outcome: 'completed', activity: steps('b', 20), activityDropped: 1 });
    const folded = foldSubagentCopies(older, newer);
    expect(folded.activity).toHaveLength(SUBAGENT_LIMITS.activity);
    // The oldest ten go: a0…a9.
    expect(folded.activity?.[0].id).toBe('a10');
    expect(folded.activity?.at(-1)?.id).toBe('b19');
    expect(folded.activityDropped).toBe(4 + 1 + 10);
  });

  it('keeps a known outcome when a later copy reports none', () => {
    // A Codex child completed in a1; closing it in a2 reports a bare terminated state.
    const completed = done('child', {
      agentName: 'Auditor', description: 'Audit docs', result: 'Found 3 issues', error: 'one file unreadable',
      usage: { durationMs: 9_000, totalTokens: 1_200 }, startedAt: 1_000, endedAt: 10_000,
    });
    const closed = subagent({ sessionId: 'child', status: 'terminated' });
    const folded = foldSubagentCopies(completed, closed);
    expect(folded).toMatchObject({
      status: 'terminated', outcome: 'completed', result: 'Found 3 issues', error: 'one file unreadable',
      usage: { durationMs: 9_000, totalTokens: 1_200 }, endedAt: 10_000, agentName: 'Auditor',
    });
    const node = chat([user('u1'), assistant('a1', { subagents: [completed] }), user('u2'), assistant('a2', { subagents: [closed] })]);
    expect(conversationSubagentState(node, 'child')).toMatchObject({ messageId: 'a2', active: false, subagent: { outcome: 'completed', result: 'Found 3 issues' } });
    expect(countActiveSubagents(node)).toBe(0);

    // Running again clears it.
    const again = foldSubagentCopies(completed, subagent({ sessionId: 'child', currentTool: 'Read b.md' }));
    expect(again).toMatchObject({ status: 'working', currentTool: 'Read b.md' });
    for (const key of ['outcome', 'result', 'error', 'usage', 'endedAt'] as const) expect(again[key]).toBeUndefined();

    // A later copy with an outcome of its own wins on every field.
    const failed = foldSubagentCopies(completed, done('child', { outcome: 'failed', error: 'crashed', endedAt: 20_000 }));
    expect(failed).toMatchObject({ outcome: 'failed', error: 'crashed', endedAt: 20_000 });
    expect(failed.result).toBeUndefined();
    expect(failed.usage).toBeUndefined();
  });

  it('lets a later copy without an outcome stand when the older one had none either', () => {
    const launch = subagent({ sessionId: 'bg', status: 'terminated', background: true, endedAt: 13_000 });
    const republished = subagent({ sessionId: 'bg', status: 'terminated', background: true, usage: { toolUses: 4 } });
    const folded = foldSubagentCopies(launch, republished);
    expect(folded.endedAt).toBeUndefined();
    expect(folded.usage).toEqual({ toolUses: 4 });
    expect(isSubagentActive(folded)).toBe(true);
  });

  it('reads the live node roster for a tail message without a durable roster', () => {
    const node = chat([user('u1'), assistant('a1')], { status: 'streaming', subagents: [subagent({ sessionId: 'live' })] });
    expect(ids(conversationSubagents(node))).toEqual(['live']);
    expect(countActiveSubagents(node)).toBe(1);
    // The live roster never belongs to an earlier message.
    const later = chat([user('u1'), assistant('a1'), user('u2'), assistant('a2', { subagents: [] })], { subagents: [subagent({ sessionId: 'live' })] });
    expect(conversationSubagents(later)).toEqual([]);
  });
});

describe('selectBackgroundWork: subagents', () => {
  it('does not count a working entry left over from a turn that never finished', () => {
    const stale = chat([
      user('u1'),
      assistant('a1', { subagents: [subagent({ sessionId: 'stuck' })] }),
      user('u2'),
      assistant('a2'),
    ]);
    expect(countActiveSubagents(stale)).toBe(0);
    expect(selectBackgroundWork(stale, []).subagents).toEqual([]);
    // Still listed (not running) when it belongs to the latest turn.
    const tail = chat([user('u1'), assistant('a1', { subagents: [subagent({ sessionId: 'stuck' })] })]);
    expect(selectBackgroundWork(tail, []).subagents.map((item) => item.active)).toEqual([false]);
  });

  it('keeps counting a working agent while its turn drains its metadata tail', () => {
    // visible-response-complete: the node is idle, the roster not yet final.
    const draining = chat([user('u1'), assistant('a1', { subagents: [subagent({ sessionId: 'child' })] })], { backgroundTurnAssistantId: 'a1' });
    expect(countActiveSubagents(draining)).toBe(1);
    expect(selectBackgroundWork(draining, []).subagents.map((item) => item.active)).toEqual([true]);
    // Only the draining message: an earlier leftover still does not count.
    const leftover = chat([
      user('u1'), assistant('a1', { subagents: [subagent({ sessionId: 'stuck' })] }),
      user('u2'), assistant('a2'),
    ], { backgroundTurnAssistantId: 'a2' });
    expect(countActiveSubagents(leftover)).toBe(0);
  });

  it('counts a background agent until a later turn brings its completion (recorded Claude order)', () => {
    // Claude Code 2.1.305: the launching reply records the agent as
    // background; the CLI's own turn on completion carries the outcome.
    const launched = chat([
      user('u1'),
      assistant('a1', { subagents: [subagent({ sessionId: 'toolu_bg', status: 'terminated', background: true })] }),
    ]);
    expect(countActiveSubagents(launched)).toBe(1);
    const completed = chat([
      ...launched.messages,
      assistant('self-n1-t2', { subagents: [done('toolu_bg', { background: true, result: 'PROBE_MARKER=x' })] }),
    ]);
    expect(countActiveSubagents(completed)).toBe(0);
    expect(selectBackgroundWork(completed, []).subagents.map((item) => [item.subagent.sessionId, item.active, item.latestTurn]))
      .toEqual([['toolu_bg', false, true]]);
  });

  it('shows running agents from any turn plus everything from the latest turn', () => {
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [done('old-done'), subagent({ sessionId: 'old-working' }), subagent({ sessionId: 'old-bg', status: 'terminated', background: true })] }),
      user('u2'),
      assistant('a2', { subagents: [done('new-done'), subagent({ sessionId: 'new-running' })] }),
    ], { status: 'streaming' });
    const { subagents } = selectBackgroundWork(node, []);
    // Running first, chronological within each group. old-done is hidden,
    // and so is old-working: only the streaming turn's `working` entries run.
    expect(ids(subagents)).toEqual(['old-bg', 'new-running', 'new-done']);
    expect(subagents.map((item) => [item.active, item.latestTurn])).toEqual([[true, false], [true, true], [false, true]]);
  });

  it('does not count working entries left in an earlier message while a later turn streams', () => {
    // A legacy roster that was never closed, or a turn stopped before its end landed.
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [subagent({ sessionId: 'legacy-1' }), subagent({ sessionId: 'legacy-2' })] }),
      user('u2'),
      assistant('a2', { streaming: true }),
    ], { status: 'streaming' });
    expect(countActiveSubagents(node)).toBe(0);
    expect(selectBackgroundWork(node, []).subagents).toEqual([]);
    // The streaming turn's own working agent still counts.
    const live = chat([...node.messages.slice(0, 3), assistant('a2', { streaming: true, subagents: [subagent({ sessionId: 'now' })] })], { status: 'streaming' });
    expect(countActiveSubagents(live)).toBe(1);
    expect(selectBackgroundWork(live, []).subagents.map((item) => [item.subagent.sessionId, item.active])).toEqual([['now', true]]);
  });

  it('counts a background agent still working in an earlier message while the next turn streams', () => {
    // a1's roster says working until a1's late `done` finalizes it; the user already sent a2.
    const background = subagent({ sessionId: 'bg', background: true, currentTool: 'Read a.ts' });
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [background, subagent({ sessionId: 'fg' })] }),
      user('u2'),
      assistant('a2', { streaming: true }),
    ], { status: 'streaming' });
    expect(countActiveSubagents(node)).toBe(1);
    expect(selectBackgroundWork(node, []).subagents.map((item) => [item.subagent.sessionId, item.active, item.latestTurn])).toEqual([['bg', true, false]]);
    expect(conversationSubagentState(node, 'bg')?.active).toBe(true);
    // Whether or not a turn streams, like a background agent whose turn ended.
    expect(countActiveSubagents({ ...node, status: 'idle' })).toBe(1);
    // Once a1 finalizes it, it still runs in the background.
    const finalized = chat(node.messages.map((message) => message.id === 'a1'
      ? { ...message, subagents: [{ ...background, status: 'terminated' as const, currentTool: undefined }] }
      : message), { status: 'streaming' });
    expect(countActiveSubagents(finalized)).toBe(1);
  });

  it('does not count an agent interrupted by a restart', () => {
    // Michi restarted while a background agent ran; the backend closes it as cancelled.
    const interrupted = subagent({
      sessionId: 'bg', status: 'terminated', background: true, outcome: 'cancelled',
      error: 'Interrupted: Michi restarted while this subagent was running\nprocess exited', startedAt: 1_000, endedAt: 50_000,
    });
    const launch = subagent({ sessionId: 'bg', status: 'terminated', background: true, startedAt: 1_000, endedAt: 13_000 });
    const inPlace = chat([user('u1'), assistant('a1', { subagents: [interrupted] }), user('u2'), assistant('a2')], { status: 'streaming' });
    expect(countActiveSubagents(inPlace)).toBe(0);
    const later = chat([user('u1'), assistant('a1', { subagents: [launch] }), user('u2'), assistant('a2', { subagents: [interrupted] })]);
    expect(countActiveSubagents(later)).toBe(0);
    expect(conversationSubagentState(later, 'bg')).toMatchObject({ active: false, subagent: { outcome: 'cancelled', error: interrupted.error } });
  });

  it('counts a working copy republished into the streaming turn, not its launch copy', () => {
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [subagent({ sessionId: 'child', status: 'terminated', background: true })] }),
      user('u2'),
      assistant('a2', { subagents: [subagent({ sessionId: 'child', currentTool: 'Read a.ts' })] }),
    ], { status: 'streaming' });
    expect(countActiveSubagents(node)).toBe(1);
    expect(countActiveSubagents({ ...node, status: 'idle' })).toBe(0);
  });

  it('hides a background agent whose completion arrived in an earlier turn than the latest', () => {
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [subagent({ sessionId: 'bg', status: 'terminated', background: true })] }),
      user('u2'),
      assistant('a2', { subagents: [done('bg')] }),
      user('u3'),
      assistant('a3'),
    ]);
    expect(selectBackgroundWork(node, []).subagents).toEqual([]);
  });

  it('keeps a focused finished agent from an earlier turn', () => {
    const node = chat([user('u1'), assistant('a1', { subagents: [done('old')] }), user('u2'), assistant('a2')]);
    expect(selectBackgroundWork(node, []).subagents).toEqual([]);
    expect(ids(selectBackgroundWork(node, [], { subagentIds: new Set(['old']) }).subagents)).toEqual(['old']);
  });

  it('shows nothing for a conversation whose messages are not loaded yet', () => {
    const node = chat([], { messagesLoaded: false });
    expect(selectBackgroundWork(node, [])).toEqual({ subagents: [], workflows: [] });
  });
});

describe('background agents no live process tracks', () => {
  const NONE: ReadonlySet<string> = new Set();
  const launch = subagent({ sessionId: 'bg', status: 'terminated', background: true, agentName: 'Scanner', startedAt: 1_000, endedAt: 13_000 });
  // Its launch turn ended; nothing reported its completion since.
  const launched = chat([user('u1'), assistant('a1', { subagents: [launch] })]);

  it('reads stopped and stops counting once the feed says no process tracks it', () => {
    expect(countActiveSubagents(launched, NONE)).toBe(0);
    const state = conversationSubagentState(launched, 'bg', NONE);
    expect(state).toMatchObject({
      messageId: 'a1', active: false,
      subagent: { status: 'terminated', outcome: 'cancelled', error: SUBAGENT_UNTRACKED_ERROR, agentName: 'Scanner', startedAt: 1_000 },
    });
    // Presentation only: the roster keeps its entry as it was.
    expect(launch.outcome).toBeUndefined();
    const [item] = selectBackgroundWork(launched, [], {}, NONE).subagents;
    expect(item).toMatchObject({ active: false, latestTurn: true, subagent: { outcome: 'cancelled' } });
    // From an earlier turn it is finished work the drawer hides.
    const later = chat([...launched.messages, user('u2'), assistant('a2')]);
    expect(selectBackgroundWork(later, [], {}, NONE).subagents).toEqual([]);
    expect(ids(selectBackgroundWork(later, [], { subagentIds: new Set(['bg']) }, NONE).subagents)).toEqual(['bg']);
  });

  it('counts it while the feed lists it, and as today while liveness is unknown', () => {
    expect(countActiveSubagents(launched, new Set(['bg']))).toBe(1);
    expect(conversationSubagentState(launched, 'bg', new Set(['bg']))).toMatchObject({ active: true, subagent: launch });
    expect(countActiveSubagents(launched)).toBe(1);
    expect(countActiveSubagents(launched, undefined)).toBe(1);
    expect(conversationSubagentState(launched, 'bg')?.subagent).toBe(launch);
    expect(selectBackgroundWork(launched, []).subagents.map((item) => [item.subagent, item.active])).toEqual([[launch, true]]);
    // Another agent's liveness says nothing about this one being alive.
    expect(countActiveSubagents(launched, new Set(['other']))).toBe(0);
  });

  describe('while the feed reconnects', () => {
    // The feed disconnected at 20s (renderer clock); its last word listed no
    // agent of these nodes unless a test says otherwise.
    const stale = (ids: ReadonlySet<string> = NONE, staleSince = 20_000) => ({ ids, staleSince });
    beforeEach(() => {
      resetPendingSightingsForTest();
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
    });
    afterEach(() => {
      vi.useRealTimers();
      resetPendingSightingsForTest();
    });

    it('judges an agent this renderer saw pending before the disconnect by the last word', () => {
      // Seen pending at 10s, with the feed connected.
      expect(countActiveSubagents(launched, new Set(['bg']))).toBe(1);
      vi.setSystemTime(30_000);
      expect(countActiveSubagents(launched, stale())).toBe(0);
      const stopped = conversationSubagentState(launched, 'bg', stale());
      expect(stopped).toMatchObject({ active: false, subagent: { outcome: 'cancelled', error: SUBAGENT_UNTRACKED_ERROR } });
      // The same stopped copy as with the feed connected: nothing re-renders on a disconnect.
      expect(stopped!.subagent).toBe(conversationSubagentState(launched, 'bg', NONE)!.subagent);
      expect(selectBackgroundWork(launched, [], {}, stale()).subagents.map((item) => [item.subagent.outcome, item.active])).toEqual([['cancelled', false]]);
      // An agent the last word listed still runs.
      expect(countActiveSubagents(launched, stale(new Set(['bg'])))).toBe(1);
      expect(conversationSubagentState(launched, 'bg', stale(new Set(['bg'])))).toMatchObject({ active: true, subagent: launch });
    });

    it('needs no start time: a Codex child seen pending before the disconnect is judged too', () => {
      const { startedAt: _startedAt, ...child } = subagent({ sessionId: 'child', status: 'terminated', background: true, source: 'codex' });
      const node = chat([user('u1'), assistant('a1', { subagents: [child] })]);
      expect(countActiveSubagents(node, new Set(['child']))).toBe(1);
      vi.setSystemTime(30_000);
      expect(countActiveSubagents(node, stale())).toBe(0);
      expect(conversationSubagentState(node, 'child', stale())?.subagent.outcome).toBe('cancelled');
    });

    it('leaves an agent first seen pending since the disconnect as its roster says', () => {
      // Before the disconnect: bg pending, `late` still a foreground agent of a2.
      const lateWorking = subagent({ sessionId: 'late', status: 'working' });
      const before = chat([...launched.messages, user('u2'), assistant('a2', { subagents: [lateWorking] })]);
      expect(countActiveSubagents(before, new Set(['bg']))).toBe(1);

      vi.setSystemTime(25_000);
      // During the outage: a2 ended with `late` backgrounded (Codex marks
      // children background at the turn's end), and a3 launched `new`
      // (backend clock far behind: its startedAt says nothing here).
      const late = { ...lateWorking, status: 'terminated' as const, background: true };
      const fresh = subagent({ sessionId: 'new', status: 'terminated', background: true, startedAt: 1 });
      const node = chat([
        ...launched.messages,
        user('u2'), assistant('a2', { subagents: [late] }),
        user('u3'), assistant('a3', { subagents: [fresh] }),
      ]);
      // Only the agent seen pending before the disconnect stops.
      expect(countActiveSubagents(node, stale())).toBe(2);
      expect(conversationSubagentState(node, 'bg', stale())?.active).toBe(false);
      expect(conversationSubagentState(node, 'late', stale())).toMatchObject({ active: true, subagent: late });
      expect(conversationSubagentState(node, 'new', stale())).toMatchObject({ active: true, subagent: fresh });
      // The stopped one is finished work from an earlier turn: the drawer hides it.
      expect(selectBackgroundWork(node, [], {}, stale()).subagents.map((item) => [item.subagent.sessionId, item.active]))
        .toEqual([['late', true], ['new', true]]);
      // Seen exactly at the disconnect: not before it, so unknown.
      expect(countActiveSubagents(node, stale(NONE, 25_000))).toBe(2);
      // A connected feed's word applies to all of them.
      expect(countActiveSubagents(node, NONE)).toBe(0);
    });
  });

  it('keeps an agent the streaming turn just backgrounded running before the feed names it', () => {
    const working = subagent({ sessionId: 'bg', background: true, currentTool: 'Read a.ts' });
    const streaming = chat([user('u1'), assistant('a1', { streaming: true, subagents: [working] })], { status: 'streaming' });
    expect(countActiveSubagents(streaming, NONE)).toBe(1);
    expect(conversationSubagentState(streaming, 'bg', NONE)).toMatchObject({ active: true, subagent: working });
    expect(selectBackgroundWork(streaming, [], {}, NONE).subagents.map((item) => item.active)).toEqual([true]);
    // Once that turn stopped streaming, the feed's word stands.
    const ended = { ...streaming, status: 'idle' as const };
    expect(countActiveSubagents(ended, NONE)).toBe(0);
    const stopped = conversationSubagentState(ended, 'bg', NONE)!.subagent;
    expect(stopped).toMatchObject({ status: 'terminated', outcome: 'cancelled' });
    // Nothing still says what it does now.
    expect(stopped.currentTool).toBeUndefined();
    // A later turn streaming does not exempt an earlier turn's copy.
    const next = chat([...streaming.messages, user('u2'), assistant('a2', { streaming: true })], { status: 'streaming' });
    expect(countActiveSubagents(next, NONE)).toBe(0);
    expect(conversationSubagentState(next, 'bg', NONE)?.active).toBe(false);
  });

  it('leaves agents with an outcome and foreground agents alone', () => {
    const finished = done('bg-done', { background: true, result: 'found it' });
    const foreground = subagent({ sessionId: 'fg' });
    const node = chat([
      user('u1'),
      assistant('a1', { subagents: [finished] }),
      user('u2'),
      assistant('a2', { streaming: true, subagents: [foreground] }),
    ], { status: 'streaming' });
    expect(countActiveSubagents(node, NONE)).toBe(1);
    expect(conversationSubagentState(node, 'bg-done', NONE)?.subagent).toBe(finished);
    expect(conversationSubagentState(node, 'fg', NONE)).toMatchObject({ active: true, subagent: foreground });
    // A leftover foreground `working` entry is not background work either.
    const leftover = chat([user('u1'), assistant('a1', { subagents: [foreground] }), user('u2'), assistant('a2')]);
    expect(conversationSubagentState(leftover, 'fg', NONE)?.subagent).toBe(foreground);
  });

  it('keeps an error the agent already has', () => {
    const failing = subagent({ sessionId: 'bg', status: 'terminated', background: true, error: 'Rate limited\nretry later' });
    const node = chat([user('u1'), assistant('a1', { subagents: [failing] })]);
    expect(conversationSubagentState(node, 'bg', NONE)?.subagent).toMatchObject({ outcome: 'cancelled', error: 'Rate limited\nretry later' });
  });

  it('presents one stopped object per agent copy across calls and node commits', () => {
    const first = conversationSubagentState(launched, 'bg', NONE)!.subagent;
    expect(conversationSubagentState(launched, 'bg', new Set())!.subagent).toBe(first);
    expect(selectBackgroundWork(launched, [], {}, NONE).subagents[0].subagent).toBe(first);
    // A stream commit gives a fresh node object; the copies are the same.
    expect(conversationSubagentState({ ...launched, messages: [...launched.messages] }, 'bg', NONE)!.subagent).toBe(first);
    // Folded copies too.
    const folded = chat([...launched.messages, user('u2'), assistant('a2', { subagents: [subagent({ sessionId: 'bg', status: 'terminated', background: true })] })]);
    const foldedStopped = conversationSubagentState(folded, 'bg', NONE)!.subagent;
    expect(conversationSubagentState({ ...folded }, 'bg', NONE)!.subagent).toBe(foldedStopped);
  });
});

describe('selectBackgroundWork: workflows', () => {
  const messages = [
    user('u1'),
    assistant('a1', { createdAt: 100, toolCalls: [{ id: 'tool-old', title: 'Workflow', status: 'completed' }] }),
    user('u2'),
    assistant('a2', { createdAt: 200, toolCalls: [{ id: 'tool-new', title: 'Workflow', status: 'completed' }] }),
  ];

  it('shows running and paused runs from any turn plus runs the latest turn launched', () => {
    const runs = [
      run({ id: 'old-done', parentToolCallId: 'tool-old', startedAt: 110 }),
      run({ id: 'old-running', parentToolCallId: 'tool-old', status: 'running', startedAt: 120 }),
      run({ id: 'old-paused', parentToolCallId: 'tool-old', status: 'paused', startedAt: 130 }),
      run({ id: 'new-done', parentToolCallId: 'tool-new', status: 'failed', startedAt: 210 }),
      run({ id: 'other-node', nodeId: 'n2', status: 'running', startedAt: 220 }),
    ];
    const { workflows } = selectBackgroundWork(chat(messages), runs);
    expect(runIds(workflows)).toEqual(['old-running', 'old-paused', 'new-done']);
    expect(workflows.map((item) => [item.messageId, item.active, item.latestTurn])).toEqual([
      ['a1', true, false], ['a1', true, false], ['a2', false, true],
    ]);
    expect(workflows[0].runKey).toBe(JSON.stringify(['local', 'old-running']));
  });

  it('places a run without a known launcher by its start time', () => {
    const runs = [
      run({ id: 'before-latest', startedAt: 150 }),
      run({ id: 'after-latest', startedAt: 250 }),
      run({ id: 'unknown-tool', parentToolCallId: 'gone', startedAt: 260 }),
    ];
    expect(runIds(selectBackgroundWork(chat(messages), runs).workflows)).toEqual(['after-latest', 'unknown-tool']);
    const resolve = workflowMessageResolver(messages);
    expect(resolve({ parentToolCallId: null, startedAt: 150 })).toBe('a1');
    expect(resolve({ parentToolCallId: 'tool-new', startedAt: 0 })).toBe('a2');
  });

  it('keeps a focused finished run and still lists running runs of an unloaded conversation', () => {
    const old = run({ id: 'old-done', parentToolCallId: 'tool-old', startedAt: 110 });
    const key = JSON.stringify(['local', 'old-done']);
    expect(runIds(selectBackgroundWork(chat(messages), [old], { runKeys: new Set([key]) }).workflows)).toEqual(['old-done']);
    const unloaded = chat([], { messagesLoaded: false });
    expect(runIds(selectBackgroundWork(unloaded, [old, run({ id: 'live', status: 'running' })]).workflows)).toEqual(['live']);
  });
});

describe('describeRunningWork', () => {
  it('names what runs', () => {
    expect(describeRunningWork({ subagents: 2, workflows: 1 })).toBe('2 subagents · 1 workflow running');
    expect(describeRunningWork({ subagents: 1, workflows: 0 })).toBe('1 subagent running');
    expect(describeRunningWork({ subagents: 0, workflows: 3 })).toBe('3 workflows running');
    expect(describeRunningWork({ subagents: 0, workflows: 0 })).toBeUndefined();
  });
});

describe('threadConversationIds', () => {
  it('walks the thread in tree order and skips deleted and non-chat nodes', () => {
    const nodes = {
      root: chat([], { nodeId: 'root' }),
      a: chat([], { nodeId: 'a' }),
      'a-child': chat([], { nodeId: 'a-child' }),
      b: chat([], { nodeId: 'b', deletedAt: 1 }),
      'b-child': chat([], { nodeId: 'b-child' }),
      digest: chat([], { nodeId: 'digest', kind: 'digest' }),
      merged: chat([], { nodeId: 'merged' }),
    };
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'a-child' },
      { source: 'root', target: 'b' },
      { source: 'b', target: 'b-child' },
      { source: 'root', target: 'digest' },
      { source: 'root', target: 'merged', kind: 'merge' as const },
    ];
    expect(threadConversationIds('root', edges, nodes)).toEqual(['root', 'a', 'a-child']);
    expect(threadConversationIds(null, edges, nodes)).toEqual([]);
  });
});

describe('selectBackgroundWorkIndicator', () => {
  const at = (nodeId: string, messages: ChatMessage[], patch: Partial<ChatNodeState> = {}) => chat(messages, { nodeId, ...patch });

  it('speaks for the focused conversation while the drawer lists anything for it', () => {
    const nodes = {
      n1: at('n1', [user('u'), assistant('a', { subagents: [done('x'), done('y')] })]),
      n2: at('n2', [user('u'), assistant('b', { subagents: [subagent({ sessionId: 'z' })] })], { status: 'streaming' }),
    };
    expect(selectBackgroundWorkIndicator(nodes, ['n1', 'n2'], 'n1', [])).toEqual({
      nodeId: 'n1', running: { subagents: 0, workflows: 0 }, total: 2, waiting: false,
    });
    // Its latest turn started nothing: another pane's running work speaks instead.
    const quiet = { ...nodes, n1: at('n1', [user('u'), assistant('a', { subagents: [done('x')] }), user('u2'), assistant('c')]) };
    expect(selectBackgroundWorkIndicator(quiet, ['n1', 'n2'], 'n1', [])).toMatchObject({ nodeId: 'n2', running: { subagents: 1 } });
  });

  it('counts workflow runs, flags a waiting approval while work runs, and skips non-chat panes', () => {
    const nodes = {
      n1: at('n1', [user('u'), assistant('a')], { pendingPermission: { requestId: 1, title: 'Approve', options: [] } }),
      d1: at('d1', [user('u'), assistant('d', { subagents: [subagent({ sessionId: 'q' })] })], { kind: 'digest', status: 'streaming' } as Partial<ChatNodeState>),
    };
    const runs = [run({ id: 'wf', status: 'running' })];
    expect(selectBackgroundWorkIndicator(nodes, ['d1', 'n1'], 'd1', runs)).toEqual({
      nodeId: 'n1', running: { subagents: 0, workflows: 1 }, total: 1, waiting: true,
    });
    expect(selectBackgroundWorkIndicator(nodes, ['d1', 'n1'], 'd1', [])).toBeNull();
    // A pane that is not open never speaks.
    expect(selectBackgroundWorkIndicator(nodes, ['d1'], 'n1', runs)).toBeNull();
  });

  it('compares by value', () => {
    const a = { nodeId: 'n1', running: { subagents: 1, workflows: 0 }, total: 2, waiting: false };
    expect(sameBackgroundWorkIndicator(a, { ...a, running: { ...a.running } })).toBe(true);
    expect(sameBackgroundWorkIndicator(a, { ...a, waiting: true })).toBe(false);
    expect(sameBackgroundWorkIndicator(a, null)).toBe(false);
    expect(sameBackgroundWorkIndicator(null, null)).toBe(true);
  });
});
