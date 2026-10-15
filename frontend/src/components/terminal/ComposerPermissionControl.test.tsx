import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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

  it('keeps the global selector for other registered runtimes alongside Crew', () => {
    render(<ComposerPermissionControl scope="global" mode="yolo" runtimeIds={['crew', 'codex']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Permissions: YOLO' })).toBeTruthy();
  });
});
