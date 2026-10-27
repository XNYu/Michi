import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageComponent } from 'michi-shared';
import { ComponentLibrary } from './ComponentLibrary';

const api = vi.hoisted(() => ({
  deletePageComponent: vi.fn(), listPageComponentReferences: vi.fn(), listPageComponents: vi.fn(),
  readPageComponent: vi.fn(), savePageComponent: vi.fn(), updatePageComponent: vi.fn(),
}));
vi.mock('../../../../services/api/pageComponents', () => api);

const component: PageComponent = {
  id: 'component-1', ownerUserId: 'owner-1', workspaceId: 'workspace-1', name: 'Risk card', description: 'Risk summary',
  enabled: true, activeVersion: 3, libraryRevision: 4, revocationEpoch: 0, deletedAt: null, versions: 3, createdAt: 1, updatedAt: 2,
};

describe('ComponentLibrary insertion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listPageComponents.mockResolvedValue({ revision: 4, items: [component] });
    api.readPageComponent.mockResolvedValue({ component, version: { componentId: component.id, version: 3, code: 'root.textContent = data.label', propsSchema: null, source: { kind: 'user' }, createdAt: 2 } });
    api.listPageComponentReferences.mockResolvedValue([]);
  });

  it('shows isolated sample preview and inserts the selected enabled active version', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" onInsert={onInsert} />);
    fireEvent.click(await screen.findByRole('button', { name: /Risk card/ }));
    await waitFor(() => expect(api.readPageComponent).toHaveBeenCalled());
    expect(screen.getByText('Sample preview · isolated data')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insert selected component' }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(component, 3));
  });

  it('inserts the selected historical version after previewing its source', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    api.readPageComponent.mockImplementation(async (_componentId: string, _workspaceId: string, _connectionId: string, version?: number) => ({
      component,
      version: { componentId: component.id, version: version ?? 3, code: `root.textContent = 'v${version ?? 3}'`, propsSchema: null, source: { kind: 'user' }, createdAt: 2 },
    }));
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" onInsert={onInsert} />);
    fireEvent.click(await screen.findByRole('button', { name: /Risk card/ }));
    await waitFor(() => expect(api.readPageComponent).toHaveBeenCalledWith(component.id, 'workspace-1', 'local', 3));
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: '1' } });
    await waitFor(() => expect(api.readPageComponent).toHaveBeenCalledWith(component.id, 'workspace-1', 'local', 1));
    fireEvent.click(screen.getByRole('button', { name: 'Insert selected component' }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(component, 1));
  });

  it('shows user-saved provenance and opens the original generated source', async () => {
    const onOpenSource = vi.fn();
    api.readPageComponent.mockImplementation(async (_componentId: string, _workspaceId: string, _connectionId: string, version?: number) => ({
      component,
      version: {
        componentId: component.id, version: version ?? 3, code: 'root.textContent = "source"', propsSchema: null,
        source: version === 1 ? { kind: 'chat' as const, nodeId: 'node-original', turnId: 'turn-1', assistantId: 'answer-1' } : { kind: 'user' as const }, createdAt: 2,
      },
    }));
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" onOpenSource={onOpenSource} />);
    fireEvent.click(await screen.findByRole('button', { name: /Risk card/ }));
    expect(await screen.findByText('Saved by you')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: '1' } });
    const openSource = await screen.findByRole('button', { name: 'Open source message' });
    expect(screen.getByText('Created in chat')).toBeTruthy();
    fireEvent.click(openSource);
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'node-original', turnId: 'turn-1', assistantId: 'answer-1' });
  });

  it('does not allow inserting a disabled component', async () => {
    api.listPageComponents.mockResolvedValue({ revision: 4, items: [{ ...component, enabled: false }] });
    const onInsert = vi.fn();
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" onInsert={onInsert} />);
    fireEvent.click(await screen.findByRole('button', { name: /Risk card/ }));
    const insert = await screen.findByRole('button', { name: 'Insert selected component' });
    expect((insert as HTMLButtonElement).disabled).toBe(true);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('refreshes cross-window version changes without overwriting the draft and blocks stale active insertion', async () => {
    const onInsert = vi.fn();
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" onInsert={onInsert} />);
    fireEvent.click(await screen.findByRole('button', { name: /Risk card/ }));
    await screen.findByLabelText('Component code');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My edited risk card' } });
    fireEvent.change(screen.getByLabelText('Component code'), { target: { value: 'root.textContent = "unsaved"' } });
    api.listPageComponents.mockResolvedValue({ revision: 5, items: [{ ...component, activeVersion: 4, versions: 4, libraryRevision: 5 }] });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findByRole('alert')).textContent).toContain('active version changed in another window');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My edited risk card');
    expect((screen.getByLabelText('Component code') as HTMLTextAreaElement).value).toBe('root.textContent = "unsaved"');
    expect((screen.getByLabelText('Version') as HTMLSelectElement).value).toBe('3');
    expect((screen.getByRole('button', { name: 'Insert selected component' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Insert selected component' }));
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('refreshes after a library conflict and preserves unsaved component fields', async () => {
    api.savePageComponent.mockRejectedValueOnce({ status: 409, message: 'Library revision conflict' });
    api.listPageComponents
      .mockResolvedValueOnce({ revision: 4, items: [component] })
      .mockResolvedValueOnce({ revision: 5, items: [{ ...component, activeVersion: 4, versions: 4, libraryRevision: 5 }] });
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" />);
    fireEvent.click(screen.getByRole('button', { name: /New component/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft name' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Draft description' } });
    fireEvent.change(screen.getByLabelText('Component code'), { target: { value: 'root.textContent = "draft"' } });
    if (!screen.queryByRole('button', { name: 'Save component' })) fireEvent.click(screen.getByRole('button', { name: /New component/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed in another window');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Draft name');
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Draft description');
    expect((screen.getByLabelText('Component code') as HTMLTextAreaElement).value).toBe('root.textContent = "draft"');
    expect(api.listPageComponents).toHaveBeenCalledTimes(2);
  });

  it('forces a post-save refresh after an older library read finishes', async () => {
    const saved: PageComponent = { ...component, id: 'saved-component', name: 'Freshly saved', activeVersion: 1, versions: 1, libraryRevision: 5 };
    api.savePageComponent.mockResolvedValueOnce({ component: saved, version: { componentId: saved.id, version: 1, code: 'root.textContent = "saved"', propsSchema: null, source: { kind: 'user' }, createdAt: 3 }, revision: 5 });
    let resolveOld!: (value: { revision: number; items: PageComponent[] }) => void;
    api.listPageComponents
      .mockResolvedValueOnce({ revision: 4, items: [component] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ revision: 5, items: [component, saved] });
    render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" />);
    await screen.findByRole('button', { name: /Risk card/ });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.listPageComponents).toHaveBeenCalledTimes(2));
    if (!screen.queryByRole('button', { name: 'Save component' })) fireEvent.click(screen.getByRole('button', { name: /New component/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }));
    await waitFor(() => expect(api.savePageComponent).toHaveBeenCalledOnce());
    resolveOld({ revision: 4, items: [component] });
    expect(await screen.findByRole('button', { name: /Freshly saved/ })).toBeTruthy();
    await waitFor(() => expect(api.listPageComponents).toHaveBeenCalledTimes(3));
  });

  it('ignores an old workspace library read after identity changes', async () => {
    let resolveOld!: (value: { revision: number; items: PageComponent[] }) => void;
    api.listPageComponents
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ revision: 8, items: [{ ...component, id: 'new-component', workspaceId: 'workspace-2', name: 'New workspace component' }] });
    const { rerender } = render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" />);
    rerender(<ComponentLibrary workspaceId="workspace-2" connectionId="local" />);
    expect(await screen.findByText('New workspace component')).toBeTruthy();
    resolveOld({ revision: 4, items: [component] });
    await waitFor(() => expect(screen.queryByText('Risk card')).toBeNull());
    expect(screen.getByText('New workspace component')).toBeTruthy();
  });

  it('does not call onSaved when a pending save resolves after unmount', async () => {
    let resolveSave!: (value: { component: PageComponent; version: { componentId: string; version: number; code: string; propsSchema: null; source: { kind: 'user' }; createdAt: number }; revision: number }) => void;
    api.savePageComponent.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    const onSaved = vi.fn();
    const { unmount } = render(<ComponentLibrary workspaceId="workspace-1" connectionId="local" onSaved={onSaved} />);
    if (!screen.queryByRole('button', { name: 'Save component' })) fireEvent.click(screen.getByRole('button', { name: /New component/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }));
    await waitFor(() => expect(api.savePageComponent).toHaveBeenCalledOnce());
    unmount();
    resolveSave({ component, version: { componentId: component.id, version: 3, code: 'root.textContent = "saved"', propsSchema: null, source: { kind: 'user' }, createdAt: 2 }, revision: 4 });
    await act(async () => { await Promise.resolve(); });
    expect(onSaved).not.toHaveBeenCalled();
  });
});
