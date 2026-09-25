import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeProjectKey,
  mergeIndexProjectIds,
  readActiveProjectId,
  writeActiveProjectId,
} from './workspacePersistence';

beforeEach(() => {
  window.localStorage.clear();
});

describe('per-window activeProjectId', () => {
  it('round-trips the active project under a per-window key', () => {
    writeActiveProjectId('base', 'win-1', 'projA');
    expect(readActiveProjectId('base', 'win-1', null)).toBe('projA');
    expect(window.localStorage.getItem(activeProjectKey('base', 'win-1'))).toBe('projA');
  });

  it('keeps active projects independent across windows', () => {
    writeActiveProjectId('base', 'win-1', 'projA');
    writeActiveProjectId('base', 'win-2', 'projB');
    expect(readActiveProjectId('base', 'win-1', null)).toBe('projA');
    expect(readActiveProjectId('base', 'win-2', null)).toBe('projB');
  });

  it('writing null clears the per-window key', () => {
    writeActiveProjectId('base', 'win-1', 'projA');
    writeActiveProjectId('base', 'win-1', null);
    expect(readActiveProjectId('base', 'win-1', 'legacyFallback')).toBe('legacyFallback');
  });
});

describe('mergeIndexProjectIds', () => {
  it('keeps disk-only ids by default', () => {
    expect(mergeIndexProjectIds(['a', 'b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
  });

  it('returns memory ids when disk is empty', () => {
    expect(mergeIndexProjectIds([], ['x', 'y'])).toEqual(['x', 'y']);
  });
});
