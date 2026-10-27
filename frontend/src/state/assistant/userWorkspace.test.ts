import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../chatTypes';
import {
  rememberUserWorkspace,
  resetUserWorkspaceForTests,
  userWorkspaceToReturnTo,
  useReturnFromSystemWorkspace,
} from './userWorkspace';

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, chatIds: [], edges: [], createdAt: 1, trees: [], activeTreeId: null, ...extra };
}

const sys = project('sys', { system: 'assistant' });
const a = project('a');
const b = project('b');

afterEach(() => resetUserWorkspaceForTests());

describe('the workspace to return to', () => {
  it('is the last user workspace that was active, else the first live one', () => {
    expect(userWorkspaceToReturnTo([sys, a, b])).toBe('a');
    rememberUserWorkspace(b);
    rememberUserWorkspace(sys);
    expect(userWorkspaceToReturnTo([sys, a, b])).toBe('b');
    expect(userWorkspaceToReturnTo([sys, a, { ...b, archivedAt: 1 }])).toBe('a');
    expect(userWorkspaceToReturnTo([sys])).toBeNull();
  });

  it('is selected while the system workspace is active and the caller asks', () => {
    rememberUserWorkspace(b);
    const selectProject = vi.fn();
    const { rerender } = renderHook(
      ({ enabled, active }: { enabled: boolean; active: Project }) => useReturnFromSystemWorkspace(enabled, active, [sys, a, b], selectProject),
      { initialProps: { enabled: false, active: sys } },
    );
    expect(selectProject).not.toHaveBeenCalled();
    rerender({ enabled: true, active: sys });
    expect(selectProject).toHaveBeenCalledWith('b');
    selectProject.mockClear();
    rerender({ enabled: true, active: a });
    expect(selectProject).not.toHaveBeenCalled();
  });
});
