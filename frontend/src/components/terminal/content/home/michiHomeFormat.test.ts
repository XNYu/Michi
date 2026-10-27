import { describe, it, expect } from 'vitest';
import { michiHomeEyebrow } from './michiHomeFormat';

const HOUR = 3_600_000;
// Tue Oct 20 2026, 15:00 local time.
const now = new Date(2026, 9, 20, 15, 0).getTime();

describe('michiHomeEyebrow', () => {
  it('names the day and how long ago Home was last left', () => {
    expect(michiHomeEyebrow(now, now - 3 * HOUR)).toBe('Tue, Oct 20 · last looked 3h ago');
  });

  it('says just now inside the first minute', () => {
    expect(michiHomeEyebrow(now, now - 20_000)).toBe('Tue, Oct 20 · last looked just now');
  });

  it('drops the last-looked part on a first visit', () => {
    expect(michiHomeEyebrow(now, null)).toBe('Tue, Oct 20');
  });

  it('counts days and weeks the way row ages do', () => {
    expect(michiHomeEyebrow(now, now - 50 * HOUR)).toBe('Tue, Oct 20 · last looked 2d ago');
    expect(michiHomeEyebrow(now, now - 15 * 24 * HOUR)).toBe('Tue, Oct 20 · last looked 2w ago');
  });
});
