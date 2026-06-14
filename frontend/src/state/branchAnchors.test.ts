import { describe, it, expect } from 'vitest';
import {
  buildAnchorMap,
  findQuoteRange,
  cleanupOrphanedAnchors,
  computeSurvivingMessageIds,
} from './branchAnchors';
import type { ChatNodeState, ProjectEdge, ChatMessage } from './chatTypes';

const msg = (id: string, role: 'user' | 'assistant' = 'assistant', text = ''): ChatMessage =>
  ({ id, role, text, toolCalls: [] } as ChatMessage);

const node = (id: string, messages: ChatMessage[], extras: Partial<ChatNodeState> = {}): ChatNodeState =>
  ({
    nodeId: id, kind: 'chat', chatId: id, projectId: 'p',
    messages, followUps: [], status: 'idle', ...extras,
  } as unknown as ChatNodeState);

describe('buildAnchorMap', () => {
  it('groups live branch children by anchor message id, sorted by edge.createdAt', () => {
    const parent = node('A', [msg('m1'), msg('m2')]);
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'branch', anchorMessageId: 'm1', createdAt: 200 },
      { source: 'A', target: 'C', kind: 'branch', anchorMessageId: 'm1', createdAt: 100 },
    ] as unknown as ProjectEdge[];
    const childB = node('B', [msg('x')]);
    const childC = node('C', [msg('y')]);
    const ordered = buildAnchorMap('A', edges, { A: parent, B: childB, C: childC }).get('m1');
    expect(ordered?.map((a) => a.childNodeId)).toEqual(['C', 'B']);
    expect(ordered?.[0].createdAt).toBe(100);
    expect(ordered?.[1].createdAt).toBe(200);
  });

  it('uses edge.createdAt, NOT child.messages[0].createdAt (blank-child case)', () => {
    const parent = node('A', [msg('m1')]);
    const blankChild = node('B', []); // empty — no first message
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'branch', anchorMessageId: 'm1', createdAt: 5000 },
    ] as unknown as ProjectEdge[];
    const out = buildAnchorMap('A', edges, { A: parent, B: blankChild }).get('m1');
    expect(out?.[0].createdAt).toBe(5000);
  });

  it('hides soft-deleted children', () => {
    const parent = node('A', [msg('m1')]);
    const child = node('B', [msg('x')], { deletedAt: 1 });
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'branch', anchorMessageId: 'm1', createdAt: 100 },
    ] as unknown as ProjectEdge[];
    expect(buildAnchorMap('A', edges, { A: parent, B: child }).size).toBe(0);
  });

  it('drops anchors whose message no longer exists in parent', () => {
    const parent = node('A', [msg('m1')]);
    const child = node('B', [msg('x')]);
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'branch', anchorMessageId: 'm-gone', createdAt: 100 },
    ] as unknown as ProjectEdge[];
    expect(buildAnchorMap('A', edges, { A: parent, B: child }).size).toBe(0);
  });

  it('ignores non-branch edges (merge / link / digest-source)', () => {
    const parent = node('A', [msg('m1')]);
    const child = node('B', [msg('x')]);
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'merge', anchorMessageId: 'm1', createdAt: 100 },
      { source: 'A', target: 'B', kind: 'link', anchorMessageId: 'm1', createdAt: 100 },
      { source: 'A', target: 'B', kind: 'digest-source', anchorMessageId: 'm1', createdAt: 100 },
    ] as unknown as ProjectEdge[];
    expect(buildAnchorMap('A', edges, { A: parent, B: child }).size).toBe(0);
  });
});

describe('findQuoteRange', () => {
  it('finds the first occurrence', () => {
    expect(findQuoteRange('hello world hello', 'hello')).toEqual({ start: 0, end: 5 });
  });
  it('returns null when not present', () => {
    expect(findQuoteRange('hello world', 'foo')).toBeNull();
  });
  it('returns null for empty quote', () => {
    expect(findQuoteRange('hello', '')).toBeNull();
  });
});

describe('cleanupOrphanedAnchors', () => {
  it('clears anchorMessageId on edges whose anchor is gone', () => {
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'branch', anchorMessageId: 'gone', createdAt: 100 },
      { source: 'A', target: 'C', kind: 'branch', anchorMessageId: 'm1', createdAt: 200 },
      { source: 'A', target: 'D', kind: 'merge', anchorMessageId: 'gone', createdAt: 300 },
    ] as unknown as ProjectEdge[];
    const out = cleanupOrphanedAnchors(edges, 'A', new Set(['m1']));
    expect((out[0] as unknown as Record<string, unknown>).anchorMessageId).toBeUndefined();
    expect((out[1] as unknown as Record<string, unknown>).anchorMessageId).toBe('m1');
    expect((out[2] as unknown as Record<string, unknown>).anchorMessageId).toBe('gone'); // not a branch — untouched
  });

  it('preserves createdAt even when clearing anchorMessageId', () => {
    const edges: ProjectEdge[] = [
      { source: 'A', target: 'B', kind: 'branch', anchorMessageId: 'gone', createdAt: 5000 },
    ] as unknown as ProjectEdge[];
    const out = cleanupOrphanedAnchors(edges, 'A', new Set());
    expect((out[0] as unknown as Record<string, unknown>).createdAt).toBe(5000);
  });

  it('does not touch edges whose source is a different parent', () => {
    const edges: ProjectEdge[] = [
      { source: 'OTHER', target: 'B', kind: 'branch', anchorMessageId: 'gone', createdAt: 100 },
    ] as unknown as ProjectEdge[];
    const out = cleanupOrphanedAnchors(edges, 'A', new Set());
    expect((out[0] as unknown as Record<string, unknown>).anchorMessageId).toBe('gone');
  });
});

describe('computeSurvivingMessageIds — mirrors retry-trim at chatReducers.ts:416-440', () => {
  const msgs = [msg('u1', 'user'), msg('a1'), msg('u2', 'user'), msg('a2')];

  it('with fromIndex, keeps strictly before fromIndex', () => {
    expect(computeSurvivingMessageIds(msgs, 2)).toEqual(new Set(['u1', 'a1']));
  });

  it('without fromIndex, when last two are user+assistant, drops both', () => {
    expect(computeSurvivingMessageIds(msgs, undefined)).toEqual(new Set(['u1', 'a1']));
  });

  it('without fromIndex, when only last is assistant, drops just that one', () => {
    const trailing = [msg('u1', 'user'), msg('a1'), msg('a2')];
    expect(computeSurvivingMessageIds(trailing, undefined)).toEqual(new Set(['u1', 'a1']));
  });

  it('empty messages returns empty set', () => {
    expect(computeSurvivingMessageIds([], undefined)).toEqual(new Set());
  });
});
