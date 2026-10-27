import { describe, expect, it } from 'vitest';
import { appendAnswerBlockText, appendThinkingBlockText, appendToolBlock, migrateAssistantToBlocks } from './assistantBlocks';
import type { ChatMessage } from './chatTypes';

describe('assistant block migration', () => {
  it('preserves same-offset tool order and appends offsetless tools at the end', () => {
    const legacy: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      text: 'abcd',
      toolCalls: [
        { id: 't2', title: 'second', status: 'completed', textOffset: 2 },
        { id: 't1', title: 'first', status: 'completed', textOffset: 2 },
        { id: 't3', title: 'tail', status: 'completed' },
      ],
    };

    const tools = migrateAssistantToBlocks(legacy).blocks?.filter((b) => b.kind === 'tool');
    expect(tools).toEqual([
      { id: 'a2-legacy-tool-t2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 2 },
      { id: 'a2-legacy-tool-t1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 2 },
      { id: 'a2-legacy-tool-t3', kind: 'tool', toolCallId: 't3', section: 'answer', rawOffset: 4 },
    ]);
  });
});

describe('assistant block streaming boundaries', () => {
  it('closes the preceding text block when a tool block is appended', () => {
    const base: ChatMessage = {
      id: 'a3',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [],
      streaming: true,
    };
    const withText = appendAnswerBlockText(base, 'before');
    const withTool = appendToolBlock(withText, 't1');

    expect(withTool.blocks).toEqual([
      { id: 'a3-b-0', kind: 'answer', rawText: 'before', streaming: false },
      { id: 'a3-b-1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 6 },
    ]);
  });

  it('keeps consecutive tools in the preceding thinking section', () => {
    const base: ChatMessage = {
      id: 'a4',
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [],
      streaming: true,
    };
    const withThinking = appendThinkingBlockText(base, 'inspect');
    const withFirstTool = appendToolBlock(withThinking, 't1');
    const withSecondTool = appendToolBlock(withFirstTool, 't2');

    expect(withSecondTool.blocks).toEqual([
      { id: 'a4-b-0', kind: 'thinking', rawText: 'inspect', streaming: false },
      { id: 'a4-b-1', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 7 },
      { id: 'a4-b-2', kind: 'tool', toolCallId: 't2', section: 'thinking', rawOffset: 7 },
    ]);
  });
});
