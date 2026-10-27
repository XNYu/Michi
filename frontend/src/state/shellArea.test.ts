import { describe, expect, it } from 'vitest';
import { areaForPage, entryPageForArea } from './shellArea';

describe('shell areas', () => {
  it('maps every Spaces, Scheduled and Settings page to its area and the rest to Conversations', () => {
    expect(areaForPage('spaces')).toBe('spaces');
    expect(areaForPage('space')).toBe('spaces');
    expect(areaForPage('scheduled')).toBe('scheduled');
    expect(areaForPage('settings')).toBe('settings');
    for (const page of ['home', 'dashboard', 'threads', 'map', 'workspaces', 'trash'] as const) {
      expect(areaForPage(page)).toBe('conversations');
    }
  });

  it('returns Conversations to its last page and always opens Spaces on Home', () => {
    expect(entryPageForArea('conversations', 'dashboard')).toBe('dashboard');
    expect(entryPageForArea('conversations', 'space')).toBe('home');
    expect(entryPageForArea('spaces', 'dashboard')).toBe('spaces');
    expect(entryPageForArea('scheduled', 'home')).toBe('scheduled');
    expect(entryPageForArea('settings', 'home')).toBe('settings');
  });
});
