import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { setManageWorkspaceId, useManageWorkspaceId, _resetForTest } from './manageRoute';

describe('manageRoute', () => {
  beforeEach(() => _resetForTest());

  it('starts as null', () => {
    const { result } = renderHook(() => useManageWorkspaceId());
    expect(result.current).toBeNull();
  });

  it('updates subscribers when set', () => {
    const { result } = renderHook(() => useManageWorkspaceId());
    act(() => setManageWorkspaceId('ws-1'));
    expect(result.current).toBe('ws-1');
  });

  it('no-ops when set to current value', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useManageWorkspaceId();
    });
    act(() => setManageWorkspaceId('ws-1'));
    const after = renders;
    act(() => setManageWorkspaceId('ws-1'));
    expect(renders).toBe(after);
    expect(result.current).toBe('ws-1');
  });
});
