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
