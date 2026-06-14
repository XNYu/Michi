import { appendAnswerBlockText } from './assistantBlocks';
import type { AssistantBlock, ChatMessage } from './chatTypes';

function msg(blocks: AssistantBlock[]): ChatMessage {
  return { id: 'm1', role: 'assistant', text: '', toolCalls: [], blocks, streaming: true };
}

describe('cloneBlocks identity preservation (via appendAnswerBlockText)', () => {
  it('keeps frozen block identities when a new answer block is pushed', () => {
    const a0: AssistantBlock = { id: 'm1-b-0', kind: 'answer', rawText: 'Hello', streaming: true };
    const t1: AssistantBlock = { id: 'm1-b-1', kind: 'tool', toolCallId: 'tc1', section: 'answer', rawOffset: 5 };
    const before = msg([a0, t1]);

    const after = appendAnswerBlockText(before, ' world');

    expect(after.blocks![0]).toBe(a0);        // frozen answer block: same object
    expect(after.blocks![1]).toBe(t1);        // tool block: same object
    expect(after.blocks).not.toBe(before.blocks); // new array
    expect(after.blocks![2]).toMatchObject({ kind: 'answer', rawText: ' world' });
  });

  it('replaces only the tail when appending into an existing answer block', () => {
    const a0: AssistantBlock = { id: 'm1-b-0', kind: 'thinking', rawText: 'reason', streaming: false };
    const a1: AssistantBlock = { id: 'm1-b-1', kind: 'answer', rawText: 'Hel', streaming: true };
    const before = msg([a0, a1]);

    const after = appendAnswerBlockText(before, 'lo');

    expect(after.blocks![0]).toBe(a0);        // frozen thinking block: same object
    expect(after.blocks![1]).not.toBe(a1);    // tail answer block: replaced
    expect(after.blocks![1]).toMatchObject({ kind: 'answer', rawText: 'Hello' });
  });
});
