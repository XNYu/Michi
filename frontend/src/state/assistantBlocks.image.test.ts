import { describe, it, expect } from 'vitest';
import { appendImageBlock } from './assistantBlocks';
import type { ChatMessage } from './chatTypes';

const base: ChatMessage = { id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true } as ChatMessage;

describe('appendImageBlock', () => {
  it('appends an image block to blocks[]', () => {
    const m = appendImageBlock(base, { workspaceId: 'ws1', path: '.shot.png', mimeType: 'image/png', caption: 'hi', size: 4242 });
    const last = m.blocks![m.blocks!.length - 1];
    expect(last.kind).toBe('image');
    expect(last).toMatchObject({ kind: 'image', workspaceId: 'ws1', path: '.shot.png', mimeType: 'image/png', caption: 'hi', size: 4242 });
    // Stable block id matching the answer/thinking/tool helpers (`${message.id}-b-${index}`).
    expect(last.id).toBe('a1-b-0');
  });

  it('does not mutate the input message or its blocks', () => {
    const input: ChatMessage = { id: 'a2', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true } as ChatMessage;
    const blocksBefore = input.blocks;
    const lenBefore = input.blocks!.length;
    const m = appendImageBlock(input, { workspaceId: 'ws1', path: '.shot.png', mimeType: 'image/png', size: 4242 });
    // New message + new blocks array; input untouched.
    expect(m).not.toBe(input);
    expect(m.blocks).not.toBe(input.blocks);
    expect(input.blocks).toBe(blocksBefore);
    expect(input.blocks!.length).toBe(lenBefore);
  });
});
