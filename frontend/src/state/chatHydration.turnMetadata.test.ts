import { describe, expect, it } from 'vitest';
import { mapMessageRow } from './chatHydration';

describe('turn message snapshot hydration', () => {
  it('restores plan, user metadata, and complete tool-call fields', () => {
    const user = mapMessageRow({
      id: 'u-a1', node_id: 'n1', role: 'user', content: 'hello', seq: 0, created_at: 1,
      metadata: JSON.stringify({
        quotedText: 'quote',
        attachments: [{ name: 'a.txt', absPath: '/tmp/a.txt' }],
        comments: [{ id: 'c1', quotedText: 'old', body: 'new' }],
      }),
    });
    const assistant = mapMessageRow({
      id: 'a1', node_id: 'n1', role: 'assistant', content: 'answer', seq: 1, created_at: 2,
      blocks: JSON.stringify([{ id: 'a1-b-0', kind: 'answer', rawText: 'answer', streaming: false }]),
      tool_calls: JSON.stringify([{ id: 't1', title: 'Read', status: 'completed', detail: 'why', inputJson: '{"x":1}', output: 'ok', textOffset: 0 }]),
      metadata: JSON.stringify({ plan: [{ content: 'ship', priority: 'high', status: 'completed' }] }),
    });

    expect(user.quotedText).toBe('quote');
    expect(user.attachments).toEqual([{ name: 'a.txt', absPath: '/tmp/a.txt' }]);
    expect(user.comments?.[0]?.body).toBe('new');
    expect(assistant.plan).toEqual([{ content: 'ship', priority: 'high', status: 'completed' }]);
    expect(assistant.toolCalls[0]).toMatchObject({
      detail: 'why', inputJson: '{"x":1}', output: 'ok', textOffset: 0,
    });
  });
});
