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

  it('namespaces active projects by baseKey/user', () => {
    writeActiveProjectId('base:user-a', 'win-1', 'projA');
    writeActiveProjectId('base:user-b', 'win-1', 'projB');
    expect(readActiveProjectId('base:user-a', 'win-1', null)).toBe('projA');
    expect(readActiveProjectId('base:user-b', 'win-1', null)).toBe('projB');
  });

  it('falls back to the supplied legacy value when no per-window key exists', () => {
    expect(readActiveProjectId('base', 'win-1', 'legacyProj')).toBe('legacyProj');
  });

  it('writing null clears the per-window key', () => {
    writeActiveProjectId('base', 'win-1', 'projA');
    writeActiveProjectId('base', 'win-1', null);
    expect(readActiveProjectId('base', 'win-1', 'legacyFallback')).toBe('legacyFallback');
  });
});

describe('mergeIndexProjectIds', () => {
  it('unions disk ids with memory ids, preserving disk-first order', () => {
    expect(mergeIndexProjectIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('keeps disk-only ids by default', () => {
    expect(mergeIndexProjectIds(['a', 'b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
  });

  it('returns memory ids when disk is empty', () => {
    expect(mergeIndexProjectIds([], ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('returns disk ids when memory is empty', () => {
    expect(mergeIndexProjectIds(['x', 'y'], [])).toEqual(['x', 'y']);
  });

  it('dedupes repeated ids', () => {
    expect(mergeIndexProjectIds(['a', 'a', 'b'], ['b', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
