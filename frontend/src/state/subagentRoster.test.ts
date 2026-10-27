import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySubagentActivity,
  applyTurnEvent,
  createDurableTurn,
  endBackgroundSubagents,
  finalizeSubagentRoster,
  mergeSubagentRoster,
  parseSubagentEnds,
  parseSubagentRoster,
  subagentEndOf,
  SUBAGENT_LIMITS,
  SUBAGENT_SESSION_ENDED_ERROR,
  type ChatStreamEvent,
  type SubagentEnd,
  type SubagentInfo,
} from 'michi-shared';
import { countActiveSubagents } from './backgroundWork';
import { mapMessageRow } from './chatHydration';
import { reduceNodes } from './chatReducers';
import { serializeMessageRowsForNode } from './workspacePersistence';
import { createBackgroundTurnBinding } from './observeChatStream';
import { dispatchChatStreamEvent } from '../services/chatStreamEvents';
import type { ChatMessage, ChatNodeState } from './chatTypes';

function entry(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
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

const spawned = entry({
  sessionId: 'toolu_1',
  agentName: 'Explore',
  sessionName: 'Map the auth flow',
  initialQuery: 'Map the auth flow',
  description: 'Map the auth flow',
  prompt: 'Find every place the session cookie is read.\nReport file paths.',
  parentToolCallId: 'toolu_1',
  model: 'haiku',
  source: 'claude',
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subagent roster fold', () => {
  it('treats list updates as patches: fields persist, entries never vanish, order is first-seen', () => {
    let roster = mergeSubagentRoster(undefined, [spawned]);
    roster = mergeSubagentRoster(roster, [entry({ sessionId: 'toolu_2', agentName: 'Plan' })]);
    // A later single-entry patch carries only what changed.
    roster = mergeSubagentRoster(roster, [entry({ sessionId: 'toolu_1', agentName: 'subagent', statusMessage: 'Reading files' })]);

    expect(roster.map((item) => item.sessionId)).toEqual(['toolu_1', 'toolu_2']);
    expect(roster[0]).toMatchObject({
      agentName: 'Explore',
      prompt: spawned.prompt,
      model: 'haiku',
      parentToolCallId: 'toolu_1',
      statusMessage: 'Reading files',
      status: 'working',
    });
  });

  it('keeps a known outcome final against a late working frame', () => {
    let roster = mergeSubagentRoster(undefined, [spawned]);
    roster = mergeSubagentRoster(roster, [{ ...spawned, status: 'terminated', outcome: 'completed', result: 'Found 3 readers.' }]);
    roster = mergeSubagentRoster(roster, [{ ...spawned, status: 'working' }]);

    expect(roster[0]).toMatchObject({ status: 'terminated', outcome: 'completed', result: 'Found 3 readers.', endedAt: 1_000 });
    expect(roster[0].currentTool).toBeUndefined();
  });

  it('folds tool activity by id and derives the current tool', () => {
    let roster = mergeSubagentRoster(undefined, [spawned]);
    roster = applySubagentActivity(roster, {
      subagentSessionId: 'toolu_1', toolCallId: 'c1', title: 'Read src/auth.ts', status: 'in_progress', toolKind: 'Read', detail: 'src/auth.ts',
    })!;
    expect(roster[0].currentTool).toBe('Read src/auth.ts');

    vi.setSystemTime(1_500);
    roster = applySubagentActivity(roster, {
      subagentSessionId: 'toolu_1', toolCallId: 'c1', title: '', status: 'completed', output: 'export function readCookie() {}',
    })!;
    expect(roster[0].currentTool).toBeUndefined();
    expect(roster[0].activity).toEqual([{
      id: 'c1',
      kind: 'tool',
      title: 'Read src/auth.ts',
      status: 'completed',
      toolKind: 'Read',
      detail: 'src/auth.ts',
      output: 'export function readCookie() {}',
      startedAt: 1_000,
      endedAt: 1_500,
    }]);
  });

  it('pairs legacy title-only updates and dedupes replayed narration', () => {
    let roster = mergeSubagentRoster(undefined, [spawned]);
    roster = applySubagentActivity(roster, { subagentSessionId: 'toolu_1', title: 'grep cookie', status: 'in_progress' })!;
    roster = applySubagentActivity(roster, { subagentSessionId: 'toolu_1', title: 'grep cookie', status: 'completed' })!;
    roster = applySubagentActivity(roster, { subagentSessionId: 'toolu_1', title: 'Looking at middleware', status: '', activityKind: 'message' })!;
    roster = applySubagentActivity(roster, { subagentSessionId: 'toolu_1', title: 'Looking at middleware', status: '', activityKind: 'message' })!;

    expect(roster[0].activity?.map((item) => [item.kind, item.title, item.status])).toEqual([
      ['tool', 'grep cookie', 'completed'],
      ['message', 'Looking at middleware', undefined],
    ]);
    expect(roster[0].statusMessage).toBe('Looking at middleware');
  });

  it('ignores activity for unknown subagents and bounds the activity list', () => {
    const roster = mergeSubagentRoster(undefined, [spawned]);
    expect(applySubagentActivity(roster, { subagentSessionId: 'other', title: 'x', status: 'in_progress' })).toEqual(roster);

    let bounded = roster;
    for (let index = 0; index < SUBAGENT_LIMITS.activity + 5; index += 1) {
      bounded = applySubagentActivity(bounded, { subagentSessionId: 'toolu_1', toolCallId: `c${index}`, title: `step ${index}`, status: 'completed' })!;
    }
    expect(bounded[0].activity).toHaveLength(SUBAGENT_LIMITS.activity);
    expect(bounded[0].activity?.[0].id).toBe('c5');
    expect(bounded[0].activityDropped).toBe(5);
  });

  it('finalizes still-working agents; an interrupted turn cancels them and interrupts their tools', () => {
    const roster = applySubagentActivity(mergeSubagentRoster(undefined, [spawned]), {
      subagentSessionId: 'toolu_1', toolCallId: 'c1', title: 'Bash', status: 'in_progress',
    });
    const ended = finalizeSubagentRoster(roster, false)!;
    expect(ended[0]).toMatchObject({ status: 'terminated', endedAt: 1_000 });
    expect(ended[0].outcome).toBeUndefined();
    expect(ended[0].activity?.[0].status).toBe('completed');

    const cancelled = finalizeSubagentRoster(roster, true)!;
    expect(cancelled[0]).toMatchObject({ status: 'terminated', outcome: 'cancelled' });
    expect(cancelled[0].activity?.[0].status).toBe('interrupted');
  });

  it('parses untrusted rosters defensively', () => {
    const parsed = parseSubagentRoster(JSON.stringify([
      { sessionName: 'no id' },
      { sessionId: 's1', status: 'working', outcome: 'exploded', source: 'mystery', result: 'x'.repeat(SUBAGENT_LIMITS.result + 50), activity: [{ title: 'no id' }, { id: 'a', title: 'ok' }] },
    ]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].outcome).toBeUndefined();
    expect(parsed[0].source).toBeUndefined();
    expect(parsed[0].result).toHaveLength(SUBAGENT_LIMITS.result);
    expect(parsed[0].activity).toEqual([{ id: 'a', kind: 'tool', title: 'ok' }]);
    expect(parseSubagentRoster('not json')).toEqual([]);
  });
});

const node = (messages: ChatMessage[]): Record<string, ChatNodeState> => ({
  n: { nodeId: 'n', kind: 'chat', projectId: 'w', chatId: 'n', messages, status: 'streaming', followUps: [] },
});
const streamingAssistant = (id: string): ChatMessage => ({ id, role: 'assistant', text: '', blocks: [], toolCalls: [], streaming: true });

describe('subagent roster in chat state', () => {
  it('folds into the node and the stamped message, then finalizes both at done', () => {
    let nodes = node([streamingAssistant('a')]);
    nodes = reduceNodes(nodes, { type: 'subagent-list-update', nodeId: 'n', assistantId: 'a', subagents: [spawned] });
    nodes = reduceNodes(nodes, {
      type: 'subagent-tool-activity', nodeId: 'n', assistantId: 'a', subagentSessionId: 'toolu_1', toolCallId: 'c1', title: 'Read a.ts', status: 'in_progress',
    });
    expect(nodes.n.subagents?.[0].currentTool).toBe('Read a.ts');
    expect(nodes.n.messages[0].subagents?.[0]).toMatchObject({ prompt: spawned.prompt, currentTool: 'Read a.ts' });

    nodes = reduceNodes(nodes, { type: 'done', nodeId: 'n', assistantId: 'a' });
    expect(nodes.n.subagents?.[0].status).toBe('terminated');
    expect(nodes.n.messages[0].subagents?.[0]).toMatchObject({ status: 'terminated', currentTool: undefined });
    expect(nodes.n.messages[0].subagents?.[0].activity?.[0].status).toBe('completed');
  });

  it('routes a stamped event to its own message and a legacy event to the streaming tail', () => {
    const finished: ChatMessage = { id: 'old', role: 'assistant', text: 'done', blocks: [], toolCalls: [], streaming: false };
    let nodes = node([finished, { id: 'u', role: 'user', text: 'next', toolCalls: [] }, streamingAssistant('tail')]);
    nodes = reduceNodes(nodes, { type: 'subagent-list-update', nodeId: 'n', assistantId: 'old', subagents: [spawned] });
    nodes = reduceNodes(nodes, { type: 'subagent-list-update', nodeId: 'n', subagents: [entry({ sessionId: 'legacy', agentName: 'crew' })] });

    expect(nodes.n.messages[0].subagents?.map((item) => item.sessionId)).toEqual(['toolu_1']);
    expect(nodes.n.messages[2].subagents?.map((item) => item.sessionId)).toEqual(['legacy']);
  });

  it('does not let a late event from an older turn repopulate the new turn\'s live roster', () => {
    const finished: ChatMessage = { id: 'old', role: 'assistant', text: 'done', blocks: [], toolCalls: [], streaming: false, subagents: [spawned] };
    let nodes = node([finished, { id: 'u', role: 'user', text: 'next', toolCalls: [] }, streamingAssistant('tail')]);
    nodes = reduceNodes(nodes, { type: 'subagent-list-update', nodeId: 'n', assistantId: 'old', subagents: [{ sessionId: 'toolu_1', status: 'terminated', outcome: 'completed' }] });
    expect(nodes.n.subagents).toBeUndefined();
    expect(nodes.n.messages[0].subagents?.[0].outcome).toBe('completed');
    const before = nodes;
    nodes = reduceNodes(nodes, { type: 'subagent-tool-activity', nodeId: 'n', assistantId: 'old', subagentSessionId: 'nobody', title: 'x', status: 'in_progress' });
    expect(nodes).toBe(before);
  });

  it('keeps status and identity when a patch omits them', () => {
    const roster = mergeSubagentRoster(mergeSubagentRoster(undefined, [spawned]), [{ sessionId: 'toolu_1', background: true }]);
    expect(roster[0]).toMatchObject({ status: 'working', agentName: 'Explore', background: true });
    expect(applySubagentActivity(roster, { subagentSessionId: 'other', title: 't', status: '' })).toBe(roster);
  });

  it('matches the durable projection for the same events', () => {
    const events: ChatStreamEvent[] = [
      { event: 'subagent_list_update', data: { subagents: [spawned], seq: 1 } },
      { event: 'subagent_tool_activity', data: { subagentSessionId: 'toolu_1', toolCallId: 'c1', title: 'Read a.ts', status: 'in_progress', seq: 2 } },
      { event: 'subagent_tool_activity', data: { subagentSessionId: 'toolu_1', toolCallId: 'c1', title: '', status: 'completed', output: 'ok', seq: 3 } },
      { event: 'subagent_list_update', data: { subagents: [{ ...spawned, status: 'terminated', outcome: 'completed', result: 'All done.' }], seq: 4 } },
    ];
    let turn = createDurableTurn({ turnId: 't', assistantId: 'a', nodeId: 'n', workspaceId: 'w', displayUserText: 'q', startedAt: 1 });
    for (const event of events) turn = applyTurnEvent(turn, event);

    let nodes = node([streamingAssistant('a')]);
    for (const event of events) {
      if (event.event === 'subagent_list_update') {
        nodes = reduceNodes(nodes, { type: 'subagent-list-update', nodeId: 'n', assistantId: 'a', subagents: event.data.subagents });
      } else if (event.event === 'subagent_tool_activity') {
        const { seq: _seq, ...payload } = event.data;
        nodes = reduceNodes(nodes, { type: 'subagent-tool-activity', nodeId: 'n', assistantId: 'a', ...payload });
      }
    }
    expect(nodes.n.messages[0].subagents).toEqual(turn.assistantMessage.subagents);
    expect(turn.assistantMessage.subagents?.[0]).toMatchObject({ outcome: 'completed', result: 'All done.' });
  });

  it('persists, hydrates and writes back the message roster', () => {
    const roster = [{ ...spawned, status: 'terminated' as const, outcome: 'completed' as const, result: 'All done.', endedAt: 2_000 }];
    const hydrated = mapMessageRow({ id: 'a', role: 'assistant', content: 'Answer', metadata: JSON.stringify({ subagents: roster }) });
    expect(hydrated.subagents).toEqual(roster);

    const rows = serializeMessageRowsForNode({ n: { ...node([hydrated]).n, status: 'idle' } }, 'n');
    expect(JSON.parse(String(rows[0].metadata)).subagents).toEqual(roster);
    expect(mapMessageRow(rows[0]).subagents).toEqual(roster);
  });

  it('observer replay stamps the assistant id on roster and activity actions', () => {
    const dispatch = vi.fn();
    const handlers = createBackgroundTurnBinding({ chatId: 'n', nodeId: 'n', dispatch, lastTurnRef: { current: '' }, lastSeqRef: { current: -1 } }).createHandlers();
    dispatchChatStreamEvent({ event: 'subagent_list_update', data: { subagents: [spawned], assistantId: 'a', turnId: 't', seq: 1 } }, handlers);
    dispatchChatStreamEvent({
      event: 'subagent_tool_activity',
      data: { subagentSessionId: 'toolu_1', toolCallId: 'c1', title: 'Read a.ts', status: 'in_progress', toolKind: 'Read', assistantId: 'a', turnId: 't', seq: 2 },
    }, handlers);
    const actions = dispatch.mock.calls.map(([action]) => action).filter((action) => action.type.startsWith('subagent-'));
    expect(actions).toEqual([
      { type: 'subagent-list-update', nodeId: 'n', assistantId: 'a', subagents: [spawned] },
      { type: 'subagent-tool-activity', nodeId: 'n', assistantId: 'a', subagentSessionId: 'toolu_1', toolCallId: 'c1', title: 'Read a.ts', status: 'in_progress', toolKind: 'Read' },
    ]);
  });
});

const backgroundLaunch = entry({
  sessionId: 'toolu_bg', agentName: 'Explore', status: 'terminated', background: true, startedAt: 100, endedAt: 200,
  activity: [{ id: 'c1', kind: 'tool', title: 'Read a.ts', status: 'completed', startedAt: 110, endedAt: 120 }],
});
const STOPPED: SubagentEnd = { sessionId: 'toolu_bg', outcome: 'cancelled', endedAt: 900, error: SUBAGENT_SESSION_ENDED_ERROR };

describe('background subagent ends', () => {
  it('ends only copies still waiting for an outcome, and returns the same roster when none does', () => {
    const done = entry({ sessionId: 'toolu_done', status: 'terminated', background: true, outcome: 'completed', result: 'r' });
    const foreground = entry({ sessionId: 'toolu_fg', status: 'terminated' });
    const roster = [backgroundLaunch, done, foreground];
    const ended = endBackgroundSubagents(roster, [STOPPED, { ...STOPPED, sessionId: 'toolu_done' }, { ...STOPPED, sessionId: 'toolu_fg' }]);
    expect(ended).not.toBe(roster);
    expect(ended[0]).toEqual({ ...backgroundLaunch, outcome: 'cancelled', endedAt: 900, error: SUBAGENT_SESSION_ENDED_ERROR });
    expect(ended[1]).toBe(done);
    expect(ended[2]).toBe(foreground);
    expect(endBackgroundSubagents(ended, [{ ...STOPPED, endedAt: 1_500, error: 'again' }])).toBe(ended);
    expect(endBackgroundSubagents(roster, [])).toBe(roster);
    expect(endBackgroundSubagents(roster, [{ ...STOPPED, sessionId: 'nobody' }])).toBe(roster);
  });

  it('closes a working copy: running steps interrupted, no current tool; a known end keeps its outcome, result and usage', () => {
    const working = { ...backgroundLaunch, status: 'working' as const, currentTool: 'Bash', usage: { toolUses: 2 },
      activity: [{ id: 'c2', kind: 'tool' as const, title: 'Bash', status: 'in_progress', startedAt: 130 }] };
    const [stopped] = endBackgroundSubagents([working], [STOPPED]);
    expect(stopped).toMatchObject({ status: 'terminated', outcome: 'cancelled', endedAt: 900 });
    expect(stopped.currentTool).toBeUndefined();
    expect(stopped.activity).toEqual([{ id: 'c2', kind: 'tool', title: 'Bash', status: 'interrupted', startedAt: 130, endedAt: 900 }]);

    const [completed] = endBackgroundSubagents([working], [{ sessionId: 'toolu_bg', outcome: 'completed', endedAt: 800, result: 'Found 3', usage: { totalTokens: 5 } }]);
    expect(completed).toMatchObject({ outcome: 'completed', result: 'Found 3', usage: { toolUses: 2, totalTokens: 5 } });
    expect(completed.error).toBeUndefined();
    expect(completed.activity?.[0].status).toBe('completed');

    // An unknown end time leaves none (its own was when the launch turn ended).
    const [unknown] = endBackgroundSubagents([backgroundLaunch], [{ sessionId: 'toolu_bg', outcome: 'cancelled', error: 'restart' }]);
    expect(unknown.endedAt).toBeUndefined();
    // An error the copy already has stays.
    const [kept] = endBackgroundSubagents([{ ...backgroundLaunch, error: 'its own' }], [STOPPED]);
    expect(kept.error).toBe('its own');
  });

  it('derives an end from what the session knows', () => {
    expect(subagentEndOf(backgroundLaunch, 'gone', 50)).toEqual({ sessionId: 'toolu_bg', outcome: 'cancelled', endedAt: 50, error: 'gone' });
    expect(subagentEndOf({ sessionId: 'x' }, 'gone')).toEqual({ sessionId: 'x', outcome: 'cancelled', error: 'gone' });
    expect(subagentEndOf({ ...backgroundLaunch, outcome: 'completed', result: 'r', endedAt: 40 }, 'gone', 50))
      .toEqual({ sessionId: 'toolu_bg', outcome: 'completed', endedAt: 40, result: 'r' });
  });

  it('parses untrusted ends defensively', () => {
    expect(parseSubagentEnds([
      { sessionId: 'a', outcome: 'cancelled', endedAt: 1, error: 'x'.repeat(SUBAGENT_LIMITS.error + 9), extra: 1 },
      { sessionId: 'b', outcome: 'nope' },
      { outcome: 'failed' },
      'c',
    ])).toEqual([{ sessionId: 'a', outcome: 'cancelled', endedAt: 1, error: `${'x'.repeat(SUBAGENT_LIMITS.error - 1)}…` }]);
  });
});

describe('background subagent ends in chat state', () => {
  const finished = (id: string, subagents: SubagentInfo[]): ChatMessage => ({ id, role: 'assistant', text: 'ok', blocks: [], toolCalls: [], streaming: false, subagents });
  const action = (patch: Partial<{ nodeId: string; workspaceId: string; subagents: SubagentEnd[] }> = {}) =>
    ({ type: 'background-subagents-ended' as const, nodeId: 'n', workspaceId: 'w', subagents: [STOPPED], ...patch });

  it('ends every waiting copy in the node and its live roster, so the badge clears without liveness', () => {
    const carried = { ...backgroundLaunch, status: 'working' as const };
    const other = entry({ sessionId: 'toolu_other', status: 'terminated', background: true });
    let nodes = node([finished('a1', [backgroundLaunch]), { id: 'u', role: 'user', text: 'next', toolCalls: [] }, finished('a2', [carried, other])]);
    nodes = { n: { ...nodes.n, status: 'idle', subagents: [carried, other] } };
    expect(countActiveSubagents(nodes.n)).toBe(2);
    const before = nodes.n;

    nodes = reduceNodes(nodes, action());
    expect(nodes.n.messages[0].subagents?.[0]).toMatchObject({ outcome: 'cancelled', error: SUBAGENT_SESSION_ENDED_ERROR, endedAt: 900 });
    expect(nodes.n.messages[2].subagents?.[0]).toMatchObject({ status: 'terminated', outcome: 'cancelled' });
    expect(nodes.n.messages[2].subagents?.[1]).toBe(other);
    expect(nodes.n.messages[1]).toBe(before.messages[1]);
    expect(nodes.n.subagents?.[0].outcome).toBe('cancelled');
    expect(countActiveSubagents(nodes.n)).toBe(1);
    // Not a turn: status and the rest of the node are as they were.
    expect(nodes.n.status).toBe('idle');
    expect({ ...nodes.n, messages: before.messages, subagents: before.subagents }).toEqual(before);

    const again = reduceNodes(nodes, action({ subagents: [{ ...STOPPED, endedAt: 2_000 }] }));
    expect(again).toBe(nodes);
  });

  it('ignores another workspace\'s node, an unknown node and an empty list', () => {
    const nodes = node([finished('a1', [backgroundLaunch])]);
    expect(reduceNodes(nodes, action({ workspaceId: 'other' }))).toBe(nodes);
    expect(reduceNodes(nodes, action({ nodeId: 'missing' }))).toBe(nodes);
    expect(reduceNodes(nodes, action({ subagents: [] }))).toBe(nodes);
  });
});
