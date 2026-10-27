import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourcePreview } from '../../../state/sourceNav/sourceApi';

const api = vi.hoisted(() => ({ fetchSourcePreview: vi.fn() }));
vi.mock('../../../state/sourceNav/sourceApi', () => ({ fetchSourcePreview: api.fetchSourcePreview }));

import { SourcePopover } from './SourcePopover';
import type { SourcePopoverState } from '../../../state/sourceNav/sourceNav';

const preview = (extra: Partial<SourcePreview> = {}): SourcePreview => ({
  nodeId: 'n1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: '排查公证失败', runtimeId: 'claude', state: 'live',
  message: { id: 'm4', role: 'assistant', text: '补上 entitlement 并重新签名，公证通过（Accepted）。', truncated: false, turnId: 't4', at: Date.now() - 50 * 60_000 },
  ...extra,
});

function setup(state: Partial<SourcePopoverState> = {}) {
  const anchor = document.createElement('button');
  anchor.textContent = '“排查公证失败”';
  document.body.appendChild(anchor);
  const onClose = vi.fn();
  const onGo = vi.fn();
  const popover: SourcePopoverState = {
    target: { backendConnectionId: 'local', nodeId: 'n1', messageId: 'm4' }, anchor, page: null, origin: null, scroll: null, ...state,
  };
  render(<SourcePopover popover={popover} onClose={onClose} onGo={onGo} />);
  return { anchor, onClose, onGo };
}

beforeEach(() => { api.fetchSourcePreview.mockReset(); });
afterEach(() => { cleanup(); for (const node of [...document.body.children]) node.remove(); });

describe('SourcePopover', () => {
  it('shows the conversation, its runtime, workspace and age, the message and the two ways in', async () => {
    api.fetchSourcePreview.mockResolvedValue(preview());
    setup();
    expect(api.fetchSourcePreview).toHaveBeenCalledWith('local', { nodeId: 'n1', messageId: 'm4' }, expect.any(AbortSignal));
    const dialog = await screen.findByRole('dialog', { name: 'Source: 排查公证失败' });
    expect(dialog.textContent).toContain('Claude');
    expect(dialog.textContent).toContain('rabbitholes · 50m ago');
    expect(dialog.querySelector('blockquote')?.textContent).toContain('补上 entitlement 并重新签名，公证通过（Accepted）。');
    expect(dialog.textContent).toContain('Both open the conversation page, which has “Back to page”.');
    expect((screen.getByRole('button', { name: /Continue this chat/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Open full chat' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers the two ways in as Michi\'s small buttons on one row, Continue first and primary', async () => {
    api.fetchSourcePreview.mockResolvedValue(preview());
    setup();
    const dialog = await screen.findByRole('dialog');
    const buttons = [...dialog.querySelectorAll('.source-pop__actions > button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Continue this chat ', 'Open full chat']);
    expect(buttons.every((button) => button.classList.contains('ui-btn') && button.classList.contains('ui-btn--sm'))).toBe(true);
    expect(buttons[0]!.classList.contains('ui-btn--primary')).toBe(true);
    expect(buttons[1]!.classList.contains('ui-btn--primary')).toBe(false);
  });

  it('Continue asks for the composer, Open does not; both hand over the resolved conversation', async () => {
    const answer = preview();
    api.fetchSourcePreview.mockResolvedValue(answer);
    const { onGo } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Continue this chat/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }));
    expect(onGo.mock.calls).toEqual([[true, answer], [false, answer]]);
  });

  it('closes on Escape (back to its link), on a click outside and on ×, but not on a click inside or on its link', async () => {
    api.fetchSourcePreview.mockResolvedValue(preview());
    const { anchor, onClose } = setup();
    const dialog = await screen.findByRole('dialog');
    fireEvent.pointerDown(dialog);
    fireEvent.pointerDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(anchor);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['deleted', preview({ state: 'deleted' }), 'This conversation was deleted.'],
    ['purged', null, 'This conversation was deleted.'],
    ['archived', preview({ state: 'archived' }), 'This conversation is archived.'],
  ])('a %s conversation says so and cannot be opened', async (_label, answer, notice) => {
    api.fetchSourcePreview.mockResolvedValue(answer);
    setup();
    expect(await screen.findByText(notice)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Continue this chat/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Open full chat' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Back to page/)).toBeNull();
  });

  it('closes when the page under its link goes away', async () => {
    api.fetchSourcePreview.mockResolvedValue(preview());
    const { anchor, onClose } = setup();
    await screen.findByRole('dialog');
    anchor.remove();
    fireEvent(window, new Event('resize'));
    expect(onClose).toHaveBeenCalled();
  });

  it('opens under its link, a little to the left of it', async () => {
    api.fetchSourcePreview.mockResolvedValue(preview());
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () => ({ left: 300, right: 400, top: 200, bottom: 220, width: 100, height: 20, x: 300, y: 200, toJSON: () => ({}) });
    await act(async () => {
      render(<SourcePopover popover={{ target: { backendConnectionId: 'local', nodeId: 'n1', messageId: 'm4' }, anchor, page: null, origin: null, scroll: null }} onClose={vi.fn()} onGo={vi.fn()} />);
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.style.left).toBe('260px');
    expect(dialog.style.top).toBe('226px');
  });
});
