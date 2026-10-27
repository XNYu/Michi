/**
 * Every pane reads where the assistant's conversation lives; opening and
 * closing the ⌘J panel must not re-render them.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptAssistantInfo, resetAssistantStoreForTests, toggleAssistantPanel, useAssistantInfo } from './assistantStore';

const INFO = { nodeId: 'n1', workspaceId: 'w1', treeId: 't1', settings: { runtimeId: 'claude' as const, modelId: null, reasoning: null }, supportedRuntimes: ['claude' as const] };

afterEach(() => { act(() => resetAssistantStoreForTests()); });

describe('useAssistantInfo', () => {
  it('re-renders when the conversation changes, not when the panel opens or closes', () => {
    act(() => resetAssistantStoreForTests({ status: 'ready', info: INFO }));
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useAssistantInfo(); });
    expect(result.current).toBe(INFO);
    const before = renders;
    act(() => { toggleAssistantPanel(); });
    act(() => { toggleAssistantPanel(); });
    expect(renders).toBe(before);

    const next = { ...INFO, nodeId: 'n2' };
    act(() => adoptAssistantInfo(next));
    expect(result.current).toBe(next);
    expect(renders).toBe(before + 1);
  });
});
