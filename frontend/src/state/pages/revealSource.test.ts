import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consumePageHelperSource, revealPageSource, resetPageHelperSourcesForTests } from './revealSource';

describe('revealPageSource', () => {
  beforeEach(() => { vi.restoreAllMocks(); resetPageHelperSourcesForTests(); });
  it('opens the bound source node and scrolls to its exact assistant message, including older IDs', async () => {
    const reveal = vi.fn().mockResolvedValue(true);
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const opened = await revealPageSource(
      { backendConnectionId: 'remote-a', workspaceId: 'workspace' },
      { kind: 'helper', nodeId: 'node', turnId: 'turn-old', assistantId: 'answer-old' }, reveal,
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(opened).toBe(true);
    expect(reveal).toHaveBeenCalledWith('remote:remote-a:workspace', 'remote:remote-a:node');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'michi:scroll-to-message',
      detail: { nodeId: 'remote:remote-a:node', messageId: 'answer-old', messageIdx: -1 },
    }));
  });

  it('keeps missing sources unavailable without dispatching a scroll', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    expect(await revealPageSource({ backendConnectionId: 'local', workspaceId: 'w' }, {
      kind: 'chat', nodeId: 'deleted', turnId: 't', assistantId: 'a',
    }, vi.fn().mockResolvedValue(false))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('routes a bound helper to its owning page and waits for that exact helper pane', async () => {
    const reveal = vi.fn().mockResolvedValue(true);
    const open = vi.fn();
    const source = { kind: 'helper' as const, nodeId: 'helper-node', turnId: 'old-turn', assistantId: 'old-answer' };
    await expect(revealPageSource(
      { backendConnectionId: 'remote-a', workspaceId: 'workspace' }, source, reveal,
      { pageId: 'page-7', open },
    )).resolves.toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
    expect(consumePageHelperSource({ backendConnectionId: 'remote-a', workspaceId: 'workspace' }, 'page-7', 'other-node')).toBeNull();
    const rendererNodeId = 'remote:remote-a:helper-node';
    expect(consumePageHelperSource({ backendConnectionId: 'remote-a', workspaceId: 'workspace' }, 'page-7', rendererNodeId)).toEqual({ ...source, nodeId: rendererNodeId });
    expect(consumePageHelperSource({ backendConnectionId: 'remote-a', workspaceId: 'workspace' }, 'page-7', rendererNodeId)).toBeNull();
  });
});
