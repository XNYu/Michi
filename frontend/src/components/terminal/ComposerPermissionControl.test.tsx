import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerPermissionControl } from './ComposerPermissionControl';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ComposerPermissionControl runtime ownership', () => {
  it('shows Crew-owned approvals without the official grant', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ approvals: false }) })));
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    expect(screen.getByText('Crew approvals')).toBeTruthy();
  });

  it('offers Ask only when the official grant is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ approvals: true }) })));
    render(<ComposerPermissionControl mode="ask" runtimeIds={['crew']} onChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Permissions: Ask' })).toBeTruthy();
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
