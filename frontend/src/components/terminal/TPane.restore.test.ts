import { describe, it, expect } from 'vitest';
import { resolvePaneRestore, type PaneScrollEntry } from './TPane';

// resolvePaneRestore decides where a freshly-mounted idle pane lands:
// first message newer than the saved lastSeen horizon ("unseen"), else
// the bottom. The horizon deliberately comes from the pane's own save
// cache rather than node.viewedAt — activateTree resets viewedAt to
// Date.now() in the same click that opens the pane, so viewedAt is
// always "just now" by the time the pane can read it.

const entry = (over: Partial<PaneScrollEntry> = {}): PaneScrollEntry => ({
  anchorId: 'm2',
  offset: -40,
  atBottom: false,
  lastSeen: 1000,
  ...over,
});

const msgs = [
  { id: 'm1', createdAt: 500 },
  { id: 'm2', createdAt: 900 },
  { id: 'm3', createdAt: 1000 },
];

describe('resolvePaneRestore', () => {
  it('messages without createdAt are never unseen → bottom', () => {
    const legacyMsgs = [{ id: 'm1' }, { id: 'm2' }];
    const got = resolvePaneRestore(entry(), legacyMsgs);
    expect(got?.kind).toBe('bottom');
  });
});
