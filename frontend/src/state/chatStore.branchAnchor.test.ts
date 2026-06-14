import { describe, it, expect } from 'vitest';
import { makeBranchEdge } from './chatStore';

describe('makeBranchEdge', () => {
  it('stamps source/target/anchor/createdAt', () => {
    const edge = makeBranchEdge({ source: 'A', target: 'B', anchorMessageId: 'm1', createdAt: 1000 });
    expect(edge.source).toBe('A');
    expect(edge.target).toBe('B');
    expect(edge.anchorMessageId).toBe('m1');
    expect(edge.createdAt).toBe(1000);
  });

  it('omits kind when not specified (relies on default branch interpretation)', () => {
    const edge = makeBranchEdge({ source: 'A', target: 'B', createdAt: 1000 });
    expect(edge.kind).toBeUndefined();
  });

  it('sets kind=branch when explicitly requested', () => {
    const edge = makeBranchEdge({ source: 'A', target: 'B', createdAt: 1000, kind: 'branch' });
    expect(edge.kind).toBe('branch');
  });

  it('preserves anchorMessageId=undefined when not provided', () => {
    const edge = makeBranchEdge({ source: 'A', target: 'B', createdAt: 1000 });
    expect(edge.anchorMessageId).toBeUndefined();
  });
});
