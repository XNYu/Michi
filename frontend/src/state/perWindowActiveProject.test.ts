import { beforeEach, describe, expect, it } from 'vitest';
import { readActiveProjectId, writeActiveProjectId } from './workspacePersistence';

beforeEach(() => {
  window.localStorage.clear();
});

describe('per-window activeProjectId', () => {
  it('namespaces active projects by baseKey/user', () => {
    writeActiveProjectId('base:user-a', 'win-1', 'projA');
    writeActiveProjectId('base:user-b', 'win-1', 'projB');
    expect(readActiveProjectId('base:user-a', 'win-1', null)).toBe('projA');
    expect(readActiveProjectId('base:user-b', 'win-1', null)).toBe('projB');
  });
});
