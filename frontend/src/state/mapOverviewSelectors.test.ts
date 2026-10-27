import { describe, it, expect } from 'vitest';
import { latestOverviewFirstSentence, branchRibbonText, nodeHeat } from './mapOverviewSelectors';
import type { ChatNodeState } from './chatTypes';

function node(partial: Partial<ChatNodeState>): ChatNodeState {
  return {
    nodeId: 'n1', projectId: 'p1', chatId: null, messages: [],
    followUps: [], status: 'idle', kind: 'chat', ...partial,
  } as ChatNodeState;
}

describe('latestOverviewFirstSentence', () => {
  it('falls back to first user message when no title/entries', () => {
    const n = node({ messages: [{ id: 'm1', role: 'user', text: '为什么白屏?', toolCalls: [] }] as any });
    expect(latestOverviewFirstSentence(n)).toBe('为什么白屏?');
  });

  it('returns empty string when nothing available', () => {
    expect(latestOverviewFirstSentence(node({}))).toBe('');
  });
});

describe('branchRibbonText', () => {
  it('prefers quotedText from first user message', () => {
    const n = node({ messages: [
      { id: 'm1', role: 'user', text: 'why?', quotedText: '会不会是 Gatekeeper', toolCalls: [] },
    ] as any });
    expect(branchRibbonText(n)).toBe('会不会是 Gatekeeper');
  });

  it('uses pendingSpawnPrompt for fanout branches without quotedText', () => {
    const n = node({ spawnedByAgent: true, pendingSpawnPrompt: '验证 fix-path 方案', messages: [] });
    expect(branchRibbonText(n)).toBe('验证 fix-path 方案');
  });

  it('uses first user message text when no quote and no spawn prompt', () => {
    const n = node({ messages: [{ id: 'm1', role: 'user', text: '换个思路试试', toolCalls: [] }] as any });
    expect(branchRibbonText(n)).toBe('换个思路试试');
  });
});

const NOW = 1_000_000_000_000;
const H = 3600_000, D = 24 * H;

describe('nodeHeat', () => {
  it('older than 3 days is cold', () => {
    expect(nodeHeat(node({ lastAssistantAt: NOW - 5 * D }), NOW)).toBe('cold');
  });
});
