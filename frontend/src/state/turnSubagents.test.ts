import type { ChatMessage, ChatNodeState, SubagentInfo, ToolCallState } from './chatTypes';
import { turnOwnSubagents } from './turnSubagents';

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: 'kiro_default', initialQuery: 'Research', status: 'working', group: '', dependsOn: [], ...patch };
}

/** A crew stage republished in a later turn: bare terminated, no steps, the first turn's chip. */
const repeat = (sessionId: string, patch: Partial<SubagentInfo> = {}) =>
  subagent({ sessionId, status: 'terminated', parentToolCallId: 'crew', ...patch });

const tool = (id: string): ToolCallState => ({ id, title: 'Spawning agent crew', status: 'completed', kind: 'tool' });

function assistant(id: string, subagents?: SubagentInfo[], toolCalls: ToolCallState[] = []): ChatMessage {
  return { id, role: 'assistant', text: '', toolCalls, ...(subagents ? { subagents } : {}) };
}

const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'go', toolCalls: [] });

function own(messages: ChatMessage[], live?: SubagentInfo[]) {
  const node: Pick<ChatNodeState, 'messages' | 'subagents'> = { messages, subagents: live };
  const tail = [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  const byMessage = turnOwnSubagents(node, tail);
  return (id: string) => byMessage.get(id)?.map((entry) => entry.sessionId);
}

describe('turnOwnSubagents', () => {
  it("leaves out a finished crew's stages that later turns' rosters repeat", () => {
    const stages = ['a', 'b'].map((id) => subagent({
      sessionId: id, status: 'terminated', outcome: 'cancelled', parentToolCallId: 'crew',
      activity: [{ id: `${id}-1`, kind: 'tool', title: 'Read', status: 'completed' }],
    }));
    const get = own([
      user('u1'), assistant('a1', stages, [tool('crew')]),
      user('u2'), assistant('a2', [repeat('b'), repeat('a')]),
      user('u3'), assistant('a3'),
      user('u4'), assistant('a4', [repeat('a'), repeat('b')]),
    ]);
    expect(get('a1')).toEqual(['a', 'b']);
    expect(get('a2')).toEqual([]);
    expect(get('a4')).toEqual([]);
  });

  it('leaves out repeats in the live roster of the streaming tail turn', () => {
    const get = own(
      [user('u1'), assistant('a1', [subagent({ sessionId: 'a', status: 'terminated', outcome: 'completed' })]), user('u2'), assistant('a2')],
      [repeat('a')],
    );
    expect(get('a2')).toEqual([]);
  });

  it('keeps an agent that works again, or reports again, in a later turn', () => {
    const first = subagent({ sessionId: 'a', status: 'terminated', outcome: 'completed', result: 'one' });
    const get = own([
      user('u1'), assistant('a1', [first]),
      user('u2'), assistant('a2', [repeat('a', { status: 'working' })]),
      user('u3'), assistant('a3', [repeat('a', { activity: [{ id: 's', kind: 'tool', title: 'Read', status: 'completed' }] })]),
      user('u4'), assistant('a4', [repeat('a', { outcome: 'completed', result: 'two' })]),
      user('u5'), assistant('a5', [repeat('a', { parentToolCallId: 'again' })], [tool('again')]),
    ]);
    expect([get('a2'), get('a3'), get('a4'), get('a5')]).toEqual([['a'], ['a'], ['a'], ['a']]);
  });

  it("keeps a background agent's completion in the turn it lands in, then leaves out its repeats", () => {
    const launch = subagent({ sessionId: 'bg', status: 'terminated', background: true });
    const completion = subagent({ sessionId: 'bg', status: 'terminated', background: true, outcome: 'completed', result: 'found it' });
    const get = own([
      user('u1'), assistant('a1', [launch]),
      assistant('self', [completion]),
      user('u2'), assistant('a2', [subagent({ sessionId: 'bg', status: 'terminated', background: true, outcome: 'completed', result: 'found it' })]),
    ]);
    expect(get('a1')).toEqual(['bg']);
    expect(get('self')).toEqual(['bg']);
    expect(get('a2')).toEqual([]);
  });

  it('does not count an earlier outcome as news when a bare copy came in between', () => {
    const get = own([
      user('u1'), assistant('a1', [subagent({ sessionId: 'a', status: 'terminated', outcome: 'cancelled' })]),
      user('u2'), assistant('a2', [repeat('a')]),
      user('u3'), assistant('a3', [repeat('a', { outcome: 'cancelled' })]),
    ]);
    expect(get('a3')).toEqual([]);
  });

  it('returns a roster with nothing left out as it is', () => {
    const roster = [subagent({ sessionId: 'a' })];
    const byMessage = turnOwnSubagents({ messages: [user('u1'), assistant('a1', roster)] }, 'a1');
    expect(byMessage.get('a1')).toBe(roster);
  });
});
