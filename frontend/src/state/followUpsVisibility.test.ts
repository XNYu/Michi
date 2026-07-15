import { describe, expect, it } from 'vitest';
import { shouldShowFollowUps } from './followUpsVisibility';

describe('shouldShowFollowUps', () => {
  it('stays hidden when no follow-ups have arrived', () => {
    expect(shouldShowFollowUps(0, false, false)).toBe(false);
  });

  it('waits while the runtime still owes a final visible answer boundary', () => {
    expect(shouldShowFollowUps(3, false, true)).toBe(false);
  });

  it('waits while visible assistant text is still catching up', () => {
    expect(shouldShowFollowUps(3, true, false)).toBe(false);
  });

  it('shows once the answer boundary is complete and visible text is caught up', () => {
    expect(shouldShowFollowUps(3, false, false)).toBe(true);
  });
});
