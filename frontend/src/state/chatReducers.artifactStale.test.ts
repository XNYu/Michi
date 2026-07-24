import { describe, it, expect } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

// Live-refresh badge state: the artifact watcher marks a node stale when its
// file changes on disk (badge shows), removed when it's deleted. Content is
// never auto-replaced — the user clicks to reload, which fires artifact-loaded.

function seedArtifact(): Record<string, ChatNodeState> {
  return reduceNodes({}, {
    type: 'create-artifact',
    nodeId: 'a1',
    projectId: 'p1',
    filePath: '.artifacts/notes.md',
  });
}

describe('artifact-mark-stale / artifact-mark-removed', () => {
  it('marks an artifact node pending-refresh without touching content', () => {
    const seeded = seedArtifact();
    const next = reduceNodes(seeded, { type: 'artifact-mark-stale', nodeId: 'a1' });
    expect(next.a1.artifact!.pendingRefresh).toBe(true);
    expect(next.a1.artifact!.content).toBeNull(); // hint only, no reload
    expect(next.a1.artifact!.status).toBe('idle');
  });

  it('is idempotent: a second stale mark returns the same nodes reference', () => {
    const seeded = seedArtifact();
    const once = reduceNodes(seeded, { type: 'artifact-mark-stale', nodeId: 'a1' });
    const twice = reduceNodes(once, { type: 'artifact-mark-stale', nodeId: 'a1' });
    expect(twice).toBe(once); // no wasted re-render on repeated edits
  });

  it('artifact-loaded clears the pending-refresh badge (fresh read is truth)', () => {
    const stale = reduceNodes(seedArtifact(), { type: 'artifact-mark-stale', nodeId: 'a1' });
    const loaded = reduceNodes(stale, {
      type: 'artifact-loaded',
      nodeId: 'a1',
      content: '# hi',
      basename: 'notes.md',
      extension: 'md',
      size: 4,
      modifiedAt: 123,
    });
    expect(loaded.a1.artifact!.pendingRefresh).toBe(false);
    expect(loaded.a1.artifact!.removed).toBe(false);
    expect(loaded.a1.artifact!.content).toBe('# hi');
  });

  it('marks removed and clears any pending-refresh flag', () => {
    const stale = reduceNodes(seedArtifact(), { type: 'artifact-mark-stale', nodeId: 'a1' });
    const removed = reduceNodes(stale, { type: 'artifact-mark-removed', nodeId: 'a1' });
    expect(removed.a1.artifact!.removed).toBe(true);
    expect(removed.a1.artifact!.pendingRefresh).toBe(false);
  });

  it('a change after removal (file recreated) clears removed and re-arms the badge', () => {
    const removed = reduceNodes(seedArtifact(), { type: 'artifact-mark-removed', nodeId: 'a1' });
    const back = reduceNodes(removed, { type: 'artifact-mark-stale', nodeId: 'a1' });
    expect(back.a1.artifact!.removed).toBe(false);
    expect(back.a1.artifact!.pendingRefresh).toBe(true);
  });

  it('is a no-op on non-artifact / missing nodes', () => {
    const chat = reduceNodes({}, { type: 'create', nodeId: 'c1', projectId: 'p1' });
    expect(reduceNodes(chat, { type: 'artifact-mark-stale', nodeId: 'c1' })).toBe(chat);
    expect(reduceNodes(chat, { type: 'artifact-mark-removed', nodeId: 'missing' })).toBe(chat);
  });
});
