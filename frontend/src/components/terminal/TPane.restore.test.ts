import { describe, it, expect } from 'vitest';
import { resolvePaneRestore, type PaneScrollEntry } from './TPane';

// resolvePaneRestore decides where a freshly-mounted idle pane lands:
// first message newer than the saved lastSeen horizon ("unseen"), else the
// saved anchor message, else the bottom. The horizon deliberately comes from
// the pane's own save cache rather than node.viewedAt — activateTree resets
// viewedAt to Date.now() in the same click that opens the pane, so viewedAt
// is always "just now" by the time the pane can read it.

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
  it('returns null when the node has no messages', () => {
    expect(resolvePaneRestore(entry(), [])).toBeNull();
    expect(resolvePaneRestore(undefined, [])).toBeNull();
  });

  it('first visit on this device (no saved entry) → bottom', () => {
    expect(resolvePaneRestore(undefined, msgs)).toEqual({ kind: 'bottom', offset: 0 });
  });

  it('left at the bottom, nothing new since → bottom', () => {
    expect(resolvePaneRestore(entry({ atBottom: true }), msgs)).toEqual({
      kind: 'bottom',
      offset: 0,
    });
  });

  it('left mid-history, nothing new since → saved anchor at saved offset', () => {
    expect(resolvePaneRestore(entry(), msgs)).toEqual({
      kind: 'anchor',
      anchorId: 'm2',
      offset: -40,
    });
  });

  it('messages arrived after the pane was left → first unseen message', () => {
    const newer = [...msgs, { id: 'm4', createdAt: 1500 }, { id: 'm5', createdAt: 1600 }];
    const got = resolvePaneRestore(entry(), newer);
    expect(got?.kind).toBe('unseen');
    expect(got?.anchorId).toBe('m4');
  });

  it('unseen wins even when the pane was left at the bottom', () => {
    const newer = [...msgs, { id: 'm4', createdAt: 1500 }];
    const got = resolvePaneRestore(entry({ atBottom: true }), newer);
    expect(got?.kind).toBe('unseen');
    expect(got?.anchorId).toBe('m4');
  });

  it('createdAt equal to the horizon counts as seen', () => {
    // m3.createdAt === lastSeen — strictly-newer only.
    const got = resolvePaneRestore(entry(), msgs);
    expect(got?.kind).toBe('anchor');
  });

  it('legacy save with lastSeen 0 never flags unseen (would false-positive on every message)', () => {
    const got = resolvePaneRestore(entry({ lastSeen: 0 }), msgs);
    expect(got?.kind).toBe('anchor');
  });

  it('messages without createdAt are never unseen', () => {
    const legacyMsgs = [{ id: 'm1' }, { id: 'm2' }];
    const got = resolvePaneRestore(entry(), legacyMsgs);
    expect(got?.kind).toBe('anchor');
  });

  it('saved entry with no usable anchor falls back to bottom', () => {
    const got = resolvePaneRestore(entry({ anchorId: null }), msgs);
    expect(got).toEqual({ kind: 'bottom', offset: 0 });
  });
});
