import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerPermissionControl } from './ComposerPermissionControl';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ComposerPermissionControl runtime ownership', () => {
  it('requires setup when the approval grant is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ approvals: false }) })));
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    const status = await screen.findByText('Crew setup required');
    expect(status.title).toContain('sessionApproval');
    expect(screen.queryByText('Crew approvals')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Permissions: Ask' })).toBeNull();
  });

  it('offers Ask after required MCP and approvals are configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ approvals: true, mcpDeclared: true, mcpRouted: true }) })));
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Permissions: Ask' })).toBeTruthy();
  });

  it('requires setup when the MCP route is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ approvals: true, mcpDeclared: true, mcpRouted: false }) })));
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    expect((await screen.findByText('Crew setup required')).title).toContain('Stub / Routed');
    expect(screen.queryByRole('button', { name: 'Permissions: Ask' })).toBeNull();
  });

  it('shows Sync when installed App is older and refreshes after returning from Crew', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ approvals: true, mcpDeclared: true, mcpRouted: true,
      updateRequired: true, installedVersion: '0.5.0', expectedVersion: '0.6.0' }) }));
    vi.stubGlobal('fetch', fetcher);
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    expect((await screen.findByText('Sync Crew App')).title).toContain('0.6.0');
    fetcher.mockImplementation(async () => ({ ok: true, json: async () => ({ approvals: true, mcpDeclared: true, mcpRouted: true,
      updateRequired: false, installedVersion: '0.6.0', expectedVersion: '0.6.0' }) }));
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('button', { name: 'Permissions: Ask' })).toBeTruthy();
  });

  it('distinguishes status loading from a backend failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    expect(screen.getByText('Checking Crew setup…')).toBeTruthy();
    expect((await screen.findByText('Crew setup unavailable')).title).toContain('backend connection');
  });

  it('preserves the Kiro permission selector', () => {
    render(<ComposerPermissionControl mode="ask" runtimeIds={['kiro']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Permissions: Ask' })).toBeTruthy();
  });

  it('warns on the choices that restart Claude while a workflow runs', async () => {
    const hint = 'Claude restarts on your next message, which stops the running workflow.';
    render(<ComposerPermissionControl mode="ask" runtimeIds={['claude']} onChange={vi.fn()} yoloRestartHint={hint} />);
    const chip = screen.getByRole('button', { name: 'Permissions: Ask' });
    expect(chip.title).toContain(hint);
    fireEvent.click(chip);
    expect((await screen.findByText(/full access where the runtime supports it/)).textContent).toContain(hint);
    expect(screen.getByText(/Keep the runtime’s existing sandbox/).textContent).not.toContain(hint);
  });

  it('keeps the global selector for other registered runtimes alongside Crew', () => {
    render(<ComposerPermissionControl scope="global" mode="yolo" runtimeIds={['crew', 'codex']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Permissions: YOLO' })).toBeTruthy();
  });
  it('offers Approve for me after Ask on Kiro V3 and saves the choice', async () => {
    const onChange = vi.fn();
    render(<ComposerPermissionControl mode="ask" runtimeIds={['kiro']} approveForMeRuntimeIds={['kiro']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Ask' }));
    const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '');
    expect(labels.findIndex((text) => text.startsWith('Ask'))).toBeLessThan(labels.findIndex((text) => text.startsWith('Approve for me')));
    expect(labels.findIndex((text) => text.startsWith('Approve for me'))).toBeLessThan(labels.findIndex((text) => text.startsWith('Trust')));
    fireEvent.click(screen.getByText('Approve for me'));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('approve'));
  });

  it('shows Approve for me as the current choice, with the Ask shield', () => {
    render(<ComposerPermissionControl mode="approve" runtimeIds={['kiro']} approveForMeRuntimeIds={['kiro']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Permissions: Approve for me' })).toBeTruthy();
  });

  it('shows and offers only Ask on a runtime without Approve for me', async () => {
    render(<ComposerPermissionControl mode="approve" runtimeIds={['claude']} approveForMeRuntimeIds={['kiro']} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Ask' }));
    await screen.findAllByRole('menuitem');
    expect(screen.queryByText('Approve for me')).toBeNull();
  });

  it('notes in the global setting that other runtimes use Ask', async () => {
    render(<ComposerPermissionControl scope="global" mode="ask" runtimeIds={['kiro', 'codex']} approveForMeRuntimeIds={['kiro']} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Ask' }));
    expect((await screen.findByText(/Kiro approves routine work/)).textContent).toContain('Other runtimes use Ask.');
  });
});
