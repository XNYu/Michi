import { describe, expect, it } from 'vitest';
import {
  projectAnswerRun,
  splitAssistantRuns,
  weaveRunToolBlocks,
} from './streamingProjection';
import type { AssistantBlock, ToolCallState } from './chatTypes';

describe('block-first streaming projection', () => {
  it('carries incomplete sentinels across thinking-interrupted answer runs', () => {
    const blocks: AssistantBlock[] = [
      { id: 'a1', kind: 'answer', rawText: 'Hello [TITLE:', streaming: false },
      { id: 'th1', kind: 'thinking', rawText: 'checking', streaming: false },
      { id: 'a2', kind: 'answer', rawText: ' Hidden]\nBody', streaming: false },
    ];

    const runs = splitAssistantRuns(blocks);
    expect(runs.map((r) => r.kind)).toEqual(['answer', 'thinking', 'answer']);

    const first = projectAnswerRun(runs[0].blocks, runs[0].incomingCarry);
    const second = projectAnswerRun(runs[2].blocks, runs[2].incomingCarry);
    expect(first.visibleText).toBe('Hello ');
    expect(first.outgoingCarry).toEqual({ pendingRawTail: '[TITLE:' });
    expect(second.visibleText).toBe('Body');
  });

  it('uses final fallback and groups same-offset tools without cloning tool refs', () => {
    const tool1: ToolCallState = { id: 't1', title: 'one', status: 'completed' };
    const tool2: ToolCallState = { id: 't2', title: 'two', status: 'completed' };
    const tools = new Map<string, ToolCallState>([
      [tool1.id, tool1],
      [tool2.id, tool2],
    ]);
    const blocks: AssistantBlock[] = [
      { id: 'a1', kind: 'answer', rawText: 'abc', streaming: false },
      { id: 'tb1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 3 },
      { id: 'tb2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 3 },
    ];

    const projection = projectAnswerRun(blocks);
    const segments = weaveRunToolBlocks(
      projection.visibleText,
      projection.rawText.length,
      blocks,
      tools,
      projection.remapOffset,
      { forceFinal: true },
    );

    expect(segments).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'tool-group', tools: [tool1, tool2] },
    ]);
  });

  it('keeps Kiro tool blocks at their emitted message boundaries without blank-line markdown snapping', () => {
    const tool1: ToolCallState = { id: 't1', title: 'Bash', status: 'completed' };
    const tool2: ToolCallState = { id: 't2', title: 'Read', status: 'completed' };
    const tools = new Map<string, ToolCallState>([
      [tool1.id, tool1],
      [tool2.id, tool2],
    ]);
    const first = 'Let me inspect the workspace.';
    const second = 'Now I will read the DAO.';
    const third = 'Here is the mapping.';
    const blocks: AssistantBlock[] = [
      { id: 'a1', kind: 'answer', rawText: first, streaming: true },
      { id: 'tb1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: first.length },
      { id: 'a2', kind: 'answer', rawText: second, streaming: true },
      { id: 'tb2', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: first.length + second.length },
      { id: 'a3', kind: 'answer', rawText: third, streaming: true },
    ];

    const projection = projectAnswerRun(blocks);
    const segments = weaveRunToolBlocks(
      projection.visibleText,
      projection.rawText.length,
      blocks,
      tools,
      projection.remapOffset,
      { forceFinal: false },
    );

    expect(segments).toEqual([
      { kind: 'text', text: first },
      { kind: 'tool-group', tools: [tool1] },
      { kind: 'text', text: second },
      { kind: 'tool-group', tools: [tool2] },
      { kind: 'text', text: third },
    ]);
  });
});
