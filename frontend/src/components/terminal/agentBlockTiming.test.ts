import { describe, expect, it } from 'vitest';
import type { AssistantBlock, ToolCallState } from '../../state/chatTypes';
import { activityWindow, activityWindowMs } from './agentBlockTiming';

const tools = new Map<string, ToolCallState>([
  ['t1', { id: 't1', title: 'Bash', status: 'completed', startedAt: 1_200, endedAt: 1_800 }],
  ['t2', { id: 't2', title: 'Bash', status: 'running', startedAt: 2_000 }],
  ['legacy', { id: 'legacy', title: 'Read', status: 'completed' }],
]);

const thinking = (id: string, startedAt?: number, endedAt?: number): AssistantBlock => ({
  id, kind: 'thinking', rawText: 'x', ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}),
});
const tool = (id: string, toolCallId: string): AssistantBlock => ({ id, kind: 'tool', toolCallId, section: 'thinking', rawOffset: 0 });

describe('activityWindow', () => {
  it('spans the earliest text/tool start to the latest end', () => {
    expect(activityWindow([thinking('b0', 1_000, 1_200), tool('b1', 't1'), thinking('b2', 1_900, 2_000), tool('b3', 't2')], tools))
      .toEqual({ startedAt: 1_000, endedAt: 2_000 });
  });

  it('ends no earlier than the immediately following block starts', () => {
    const answer: AssistantBlock = { id: 'b2', kind: 'answer', rawText: 'done', startedAt: 2_500 };
    expect(activityWindow([thinking('b0', 1_000, 1_200), tool('b1', 't1')], tools, answer))
      .toEqual({ startedAt: 1_000, endedAt: 2_500 });
  });

  it('ignores a following block without a start time', () => {
    const question: AssistantBlock = { id: 'b2', kind: 'user-input', requestId: 1, section: 'answer', rawOffset: 0 };
    expect(activityWindow([thinking('b0', 1_000, 1_200), tool('b1', 't1')], tools, question))
      .toEqual({ startedAt: 1_000, endedAt: 1_800 });
  });

  it('degrades to the known tool span on legacy text blocks and to nothing without timestamps', () => {
    expect(activityWindow([thinking('b0'), tool('b1', 't1')], tools)).toEqual({ startedAt: 1_200, endedAt: 1_800 });
    expect(activityWindow([thinking('b0'), tool('b1', 'legacy')], tools)).toEqual({ startedAt: undefined, endedAt: undefined });
  });
});

describe('activityWindowMs', () => {
  it('needs both ordered bounds', () => {
    expect(activityWindowMs(1_000, 45_000)).toBe(44_000);
    expect(activityWindowMs(1_000, undefined)).toBeUndefined();
    expect(activityWindowMs(undefined, 45_000)).toBeUndefined();
    expect(activityWindowMs(45_000, 1_000)).toBeUndefined();
  });
});
