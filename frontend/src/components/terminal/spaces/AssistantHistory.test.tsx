import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantHistory } from './AssistantHistory';
import { getAssistantSnapshot, resetAssistantStoreForTests } from '../../../state/assistant/assistantStore';
const api = vi.hoisted(() => ({ list: vi.fn(), activate: vi.fn(), workspace: vi.fn(), install: vi.fn(), status: 'idle' }));
vi.mock('../../../services/api/assistant', async importOriginal => ({ ...(await importOriginal<typeof import('../../../services/api/assistant')>()), fetchAssistantConversations: api.list, activateAssistantConversation: api.activate }));
vi.mock('../../../services/api/persistence', () => ({ fetchWorkspace: api.workspace }));
vi.mock('../../../state/chatStore', () => ({ useChatActions: () => ({ installWorkspaceSnapshot: api.install }), useStructuralSelector: (selector: (nodes: unknown) => unknown) => selector({ current: { status: api.status } }) }));
const info = (nodeId = 'current') => ({ nodeId, workspaceId: 'assistant', treeId: `tree-${nodeId}`, settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] });
const row = (i: number) => ({ nodeId: `old-${i}`, title: `Previous question ${i}`, updatedAt: 1000 + i });
beforeEach(() => {
  api.list.mockReset().mockResolvedValue({ items: Array.from({ length: 5 }, (_, i) => row(i)), nextCursor: 'older' });
  api.activate.mockReset().mockImplementation(async id => info(id));
  api.workspace.mockReset().mockResolvedValue({ workspace: { id: 'assistant' } });
  api.install.mockReset(); api.status = 'idle';
  resetAssistantStoreForTests({ status: 'ready', info: info() });
});
describe('Assistant history', () => {
  it('only shows and loads history while the assistant is open, refreshing on reopen', async () => {
    const open = vi.fn();
    const view = render(<AssistantHistory onOpenAssistant={open} />);
    expect(screen.queryByRole('navigation', { name: 'Assistant conversations' })).toBeNull();
    expect(api.list).not.toHaveBeenCalled();

    view.rerender(<AssistantHistory onOpenAssistant={open} visible />);
    await screen.findByRole('button', { name: /Previous question 0/ });
    expect(api.list).toHaveBeenCalledOnce();

    view.rerender(<AssistantHistory onOpenAssistant={open} />);
    expect(screen.queryByRole('navigation', { name: 'Assistant conversations' })).toBeNull();
    expect(api.list).toHaveBeenCalledOnce();

    api.list.mockResolvedValue({ items: [row(6)], nextCursor: null });
    view.rerender(<AssistantHistory onOpenAssistant={open} visible />);
    await screen.findByRole('button', { name: /Previous question 6/ });
    expect(api.list).toHaveBeenCalledTimes(2);
  });
  it('shows five titles then loads more and resumes the selected transcript', async () => {
    const open = vi.fn();
    render(<AssistantHistory onOpenAssistant={open} visible />);
    await screen.findByRole('button', { name: /Previous question 4/ });
    expect(screen.getAllByRole('button', { name: /Previous question/ })).toHaveLength(5);
    api.list.mockResolvedValueOnce({ items: [row(5)], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByRole('button', { name: /Previous question 5/ });
    expect(api.list).toHaveBeenLastCalledWith('older');
    fireEvent.click(screen.getByRole('button', { name: /Previous question 5/ }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(api.activate).toHaveBeenCalledWith('old-5', 'current');
    expect(getAssistantSnapshot().info?.nodeId).toBe('old-5');
    expect(api.install).toHaveBeenCalledOnce();
  });
  it('keeps the current transcript selected until the workspace is installed', async () => {
    let resolveWorkspace!: (value: unknown) => void;
    api.workspace.mockReturnValue(new Promise(resolve => { resolveWorkspace = resolve; }));
    const open = vi.fn();
    render(<AssistantHistory onOpenAssistant={open} visible />);
    fireEvent.click(await screen.findByRole('button', { name: /Previous question 0/ }));
    await waitFor(() => expect(api.workspace).toHaveBeenCalledOnce());
    expect(getAssistantSnapshot().info?.nodeId).toBe('current');
    expect(open).not.toHaveBeenCalled();
    api.install.mockImplementation(() => {
      expect(getAssistantSnapshot().info?.nodeId).toBe('current');
    });
    await act(async () => { resolveWorkspace({ workspace: { id: 'assistant' } }); });
    expect(getAssistantSnapshot().info?.nodeId).toBe('old-0');
    expect(open).toHaveBeenCalledOnce();
  });
  it('follows successful activation when loading the workspace fails', async () => {
    api.workspace.mockRejectedValue(new Error('Could not load workspace'));
    const open = vi.fn();
    render(<AssistantHistory onOpenAssistant={open} visible />);
    fireEvent.click(await screen.findByRole('button', { name: /Previous question 0/ }));
    await screen.findByRole('alert');
    expect(getAssistantSnapshot().info?.nodeId).toBe('old-0');
    expect(api.install).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it('focuses the selected conversation without reloading its workspace', async () => {
    api.list.mockResolvedValue({ items: [{ ...row(0), nodeId: 'current' }], nextCursor: null });
    const open = vi.fn();
    render(<AssistantHistory onOpenAssistant={open} visible />);
    fireEvent.click(await screen.findByRole('button', { name: /Previous question 0/ }));
    expect(open).toHaveBeenCalledOnce();
    expect(api.activate).not.toHaveBeenCalled();
    expect(api.workspace).not.toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
  });
  it('keeps the active conversation on failure and blocks switching during an answer', async () => {
    const open = vi.fn();
    const view = render(<AssistantHistory onOpenAssistant={open} visible />);
    await screen.findByRole('button', { name: /Previous question 0/ });
    api.activate.mockRejectedValue(new Error('Still answering'));
    fireEvent.click(screen.getByRole('button', { name: /Previous question 0/ }));
    await screen.findByRole('alert');
    expect(open).not.toHaveBeenCalled();
    expect(getAssistantSnapshot().info?.nodeId).toBe('current');
    api.status = 'streaming';
    await act(async () => { view.rerender(<AssistantHistory onOpenAssistant={open} visible />); });
    expect((screen.getByRole('button', { name: /Previous question 0/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
