import { expect, it } from 'vitest';
import { isFreshBranch } from './branchMotion';

it('recognises only a branch edge created in this moment', () => {
  const now = 10_000;
  expect(isFreshBranch([{ source: 'a', target: 'b', createdAt: now - 50 }], 'b', now)).toBe(true);
  expect(isFreshBranch([{ source: 'a', target: 'b', kind: 'branch', createdAt: now - 50 }], 'b', now)).toBe(true);
  // Reopened or hydrated: an old edge, or a historical one with no timestamp.
  expect(isFreshBranch([{ source: 'a', target: 'b', createdAt: now - 5000 }], 'b', now)).toBe(false);
  expect(isFreshBranch([{ source: 'a', target: 'b' }], 'b', now)).toBe(false);
  expect(isFreshBranch([{ source: 'a', target: 'b', kind: 'merge', createdAt: now }], 'b', now)).toBe(false);
  expect(isFreshBranch([{ source: 'a', target: 'c', createdAt: now }], 'b', now)).toBe(false);
  expect(isFreshBranch(undefined, 'b', now)).toBe(false);
});
