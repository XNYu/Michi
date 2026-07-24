import { describe, it, expect } from 'vitest';
import {
  latestOverviewFirstSentence,
  overviewTrail,
  branchRibbonText,
  nodeHeat,
} from './mapOverviewSelectors';
import type { ChatNodeState } from './chatTypes';

function node(partial: Partial<ChatNodeState>): ChatNodeState {
  return {
    nodeId: 'n1', projectId: 'p1', chatId: null, messages: [],
    followUps: [], status: 'idle', kind: 'chat', ...partial,
  } as ChatNodeState;
}

describe('latestOverviewFirstSentence', () => {
  it('takes the first sentence of the LAST overview entry', () => {
    const n = node({ branchOverviewEntries: [
      { at: 1, text: '早期进展。次要句。' },
      { at: 2, text: '最新结论:确认是 PATH 问题。还有细节。' },
    ]});
    expect(latestOverviewFirstSentence(n)).toBe('最新结论:确认是 PATH 问题。');
  });

  it('splits on English period too', () => {
    const n = node({ branchOverviewEntries: [{ at: 1, text: 'Fixed via fix-path. Verified on dmg.' }]});
    expect(latestOverviewFirstSentence(n)).toBe('Fixed via fix-path.');
  });

  it('falls back to title when no entries', () => {
    expect(latestOverviewFirstSentence(node({ title: 'My Branch' }))).toBe('My Branch');
  });

  it('falls back to first user message when no title/entries', () => {
    const n = node({ messages: [{ id: 'm1', role: 'user', text: '为什么白屏?', toolCalls: [] }] as any });
    expect(latestOverviewFirstSentence(n)).toBe('为什么白屏?');
  });

  it('returns empty string when nothing available', () => {
    expect(latestOverviewFirstSentence(node({}))).toBe('');
  });
});

describe('overviewTrail', () => {
  it('returns entries sorted ascending by at', () => {
    const n = node({ branchOverviewEntries: [
      { at: 30, text: 'c' }, { at: 10, text: 'a' }, { at: 20, text: 'b' },
    ]});
    expect(overviewTrail(n).map((e) => e.text)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array when no entries', () => {
    expect(overviewTrail(node({}))).toEqual([]);
  });

  it('does not mutate the source array', () => {
    const entries = [{ at: 2, text: 'b' }, { at: 1, text: 'a' }];
    const n = node({ branchOverviewEntries: entries });
    overviewTrail(n);
    expect(entries[0].at).toBe(2); // original order preserved
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

  it('returns null for blank branch (no messages, no prompt)', () => {
    expect(branchRibbonText(node({}))).toBeNull();
  });
});

const NOW = 1_000_000_000_000;
const H = 3600_000, D = 24 * H;

describe('nodeHeat', () => {
  it('streaming node is always "streaming" regardless of time', () => {
    expect(nodeHeat(node({ status: 'streaming', lastAssistantAt: NOW - 10 * D }), NOW)).toBe('streaming');
  });
  it('active within 6h is hot', () => {
    expect(nodeHeat(node({ lastAssistantAt: NOW - 2 * H }), NOW)).toBe('hot');
  });
  it('within 1 day is warm', () => {
    expect(nodeHeat(node({ lastAssistantAt: NOW - 20 * H }), NOW)).toBe('warm');
  });
  it('within 3 days is cool', () => {
    expect(nodeHeat(node({ lastAssistantAt: NOW - 2 * D }), NOW)).toBe('cool');
  });
  it('older than 3 days is cold', () => {
    expect(nodeHeat(node({ lastAssistantAt: NOW - 5 * D }), NOW)).toBe('cold');
  });
  it('no timestamp is cold', () => {
    expect(nodeHeat(node({}), NOW)).toBe('cold');
  });
});
