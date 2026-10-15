import { describe, expect, it } from 'vitest';
import { clearSpawnPromptFromComposerDraft, mergeLegacyComposerDraft, mergeWindowComposerDraft, selectWindowComposerDraft } from 'michi-shared';

describe('durable window composer drafts', () => {
  const first = JSON.stringify({ value: 'first window', mentions: [] });
  const second = JSON.stringify({ value: 'second window', mentions: [] });

  it('keeps independent drafts when windows edit, clear and reload the same node', () => {
    let saved = mergeWindowComposerDraft(null, 'window-a', first);
    saved = mergeWindowComposerDraft(saved, 'window-b', second);
    expect(selectWindowComposerDraft(saved, 'window-a')).toBe(first);
    expect(selectWindowComposerDraft(saved, 'window-b')).toBe(second);
    saved = mergeWindowComposerDraft(saved, 'window-a', null);
    expect(selectWindowComposerDraft(saved, 'window-a')).toBeNull();
    expect(selectWindowComposerDraft(saved, 'window-b')).toBe(second);
  });

  it('restores a legacy draft until a window explicitly clears or replaces it', () => {
    const saved = mergeWindowComposerDraft(first, 'window-a', null);
    expect(selectWindowComposerDraft(saved, 'window-a')).toBeNull();
    expect(selectWindowComposerDraft(saved, 'window-b')).toBe(saved);
    expect(JSON.parse(selectWindowComposerDraft(saved, 'window-b')!).value).toBe('first window');
  });

  it('preserves other windows when a legacy client writes or clears the shared draft', () => {
    const saved = mergeWindowComposerDraft(first, 'window-a', second);
    const cleared = mergeLegacyComposerDraft(saved, null);
    expect(selectWindowComposerDraft(cleared, 'window-a')).toBe(second);
    expect(JSON.parse(mergeLegacyComposerDraft(saved, first)!).__michiWindowDrafts['window-a']).toBe(second);
  });

  it('clears the agent spawn outbox without deleting unsent window drafts', () => {
    const saved = mergeWindowComposerDraft(JSON.stringify({ __michiPendingSpawnPrompt: 'agent prompt' }), 'window-a', first);
    const cleared = clearSpawnPromptFromComposerDraft(saved);
    expect(JSON.parse(cleared!).__michiPendingSpawnPrompt).toBeUndefined();
    expect(selectWindowComposerDraft(cleared, 'window-a')).toBe(first);
    expect(clearSpawnPromptFromComposerDraft(JSON.stringify({ __michiPendingSpawnPrompt: 'agent prompt' }))).toBeNull();
  });
});
