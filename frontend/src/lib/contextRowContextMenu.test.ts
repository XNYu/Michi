import { describe, expect, it, vi } from 'vitest';
import { buildContextRowMenu } from './contextRowContextMenu';
import type { ArtifactEntry } from '../state/chatTypes';

const artifact = (pinnedAt?: number): ArtifactEntry => ({
  id: 'a1',
  name: 'brief',
  filePath: '.artifacts/brief.md',
  source: 'user',
  createdAt: 1,
  updatedAt: 1,
  pinnedAt,
});

describe('buildContextRowMenu favorite terminology', () => {
  it('adds a non-favorite artifact to favorites', () => {
    const onPin = vi.fn();
    const menu = buildContextRowMenu({
      context: artifact(),
      onPin,
      onRename: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(menu[0].label).toBe('Add to favorites');
    expect(menu[0].keys).toBe('F');
    menu[0].action();
    expect(onPin).toHaveBeenCalledOnce();
  });

  it('removes an existing favorite', () => {
    const menu = buildContextRowMenu({
      context: artifact(2),
      onPin: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(menu[0].label).toBe('Remove from favorites');
  });
});
