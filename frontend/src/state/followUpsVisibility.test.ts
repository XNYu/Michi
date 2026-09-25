import { describe, expect, it } from 'vitest';
import { shouldShowFollowUps } from './followUpsVisibility';

describe('shouldShowFollowUps', () => {
  it('shows once the answer boundary is complete and visible text is caught up', () => {
    expect(shouldShowFollowUps(3, false, false)).toBe(true);
  });
});
