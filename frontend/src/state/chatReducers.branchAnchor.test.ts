import { describe, it, expect } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatMessage, ChatNodeState } from './chatTypes';

const msg = (id: string, role: 'user' | 'assistant' = 'assistant', text = ''): ChatMessage =>
  ({ id, role, text, toolCalls: [] } as ChatMessage);

const baseNode = (msgs: ChatMessage[], extras: Partial<ChatNodeState> = {}): ChatNodeState =>
  ({
    nodeId: 'n', kind: 'chat', chatId: 'c', projectId: 'p',
    messages: msgs, followUps: [], status: 'idle', ...extras,
  } as unknown as ChatNodeState);

describe('set-follow-ups records the last assistant message id', () => {
  it('writes followUpsSourceMessageId to the last assistant message', () => {
    const nodes = { n: baseNode([msg('u1', 'user'), msg('a1')]) };
    const next = reduceNodes(nodes, { type: 'set-follow-ups', nodeId: 'n', followUps: ['q1'] });
    expect(next.n.followUpsSourceMessageId).toBe('a1');
  });

  it('leaves followUpsSourceMessageId undefined when no assistant message', () => {
    const nodes = { n: baseNode([msg('u1', 'user')]) };
    const next = reduceNodes(nodes, { type: 'set-follow-ups', nodeId: 'n', followUps: ['q1'] });
    expect(next.n.followUpsSourceMessageId).toBeUndefined();
  });

  it('uses the most recent assistant message', () => {
    const nodes = { n: baseNode([msg('u1', 'user'), msg('a1'), msg('u2', 'user'), msg('a2')]) };
    const next = reduceNodes(nodes, { type: 'set-follow-ups', nodeId: 'n', followUps: ['q1'] });
    expect(next.n.followUpsSourceMessageId).toBe('a2');
  });
});

describe('retry-trim clears followUpsSourceMessageId when its target is trimmed', () => {
  it('clears when the source message was trimmed', () => {
    const nodes = {
      n: baseNode([msg('u1', 'user'), msg('a1')], { followUpsSourceMessageId: 'a1' }),
    };
    const next = reduceNodes(nodes, { type: 'retry-trim', nodeId: 'n' });
    expect(next.n.followUpsSourceMessageId).toBeUndefined();
  });

  it('keeps the id when source survives', () => {
    const nodes = {
      n: baseNode(
        [msg('u1', 'user'), msg('a1'), msg('u2', 'user'), msg('a2')],
        { followUpsSourceMessageId: 'a1' },
      ),
    };
    const next = reduceNodes(nodes, { type: 'retry-trim', nodeId: 'n', fromIndex: 2 });
    expect(next.n.followUpsSourceMessageId).toBe('a1');
  });
});

describe('done reducer writes followUpsSourceMessageId from metadata-extracted follow-ups', () => {
  it('writes the assistantId when metadata yields follow-ups', () => {
    // Construct an assistant message whose raw text contains an inline
    // [FOLLOW-UPS: ...] sentinel so that assistantMetadata() returns
    // non-empty followUps, which causes the `done` branch to replace
    // followUpsSourceMessageId with action.assistantId.
    const assistantMsg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [
        {
          id: 'a1-b-0',
          kind: 'answer',
          rawText: 'Hello [FOLLOW-UPS: What next? | Tell me more | Explain further]',
          streaming: false,
        },
      ],
    };
    const nodes = { n: baseNode([msg('u1', 'user'), assistantMsg]) };
    const next = reduceNodes(nodes, { type: 'done', nodeId: 'n', assistantId: 'a1' });
    // The sentinel triggers metadata extraction; both checks are unconditional.
    expect(next.n.followUps.length).toBeGreaterThan(0);
    expect(next.n.followUpsSourceMessageId).toBe('a1');
  });

  it('leaves followUpsSourceMessageId untouched when metadata yields none', () => {
    const nodes = { n: baseNode([msg('u1', 'user'), msg('a1')], { followUpsSourceMessageId: 'prev' }) };
    const next = reduceNodes(nodes, { type: 'done', nodeId: 'n', assistantId: 'a1' });
    expect(next.n.followUpsSourceMessageId).toBe('prev');
  });
});
