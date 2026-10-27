import { describe, it, expect } from 'vitest';
import { makeBranchEdge } from './chatStore';

describe('makeBranchEdge', () => {
  it('sets kind=branch when explicitly requested', () => {
    const edge = makeBranchEdge({ source: 'A', target: 'B', createdAt: 1000, kind: 'branch' });
    expect(edge.kind).toBe('branch');
  });
});
