import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PageDto } from 'michi-shared';
import { NativePageDocument } from './NativePageDocument';

const initial: PageDto = {
  id: 'page', workspaceId: 'ws', parentId: null, position: 0, title: 'Notes', color: null,
  updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 2, viewVersion: 2,
  blocks: ['A', 'B', 'C'].map(id => ({ id, rev: 1, type: 'markdown', text: id })),
};

beforeEach(() => {
  class Pointer extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', Pointer);
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function harness(page = initial, onEdit = vi.fn().mockResolvedValue('ok')) {
  const draw = (value: PageDto) => <main>
    <NativePageDocument page={value} visibleBlocks={value.blocks.slice(0, 1)} onEdit={onEdit} onOpenPage={() => {}} renderDatabaseRef={() => null} />
    <NativePageDocument page={value} visibleBlocks={value.blocks.slice(1)} onEdit={onEdit} onOpenPage={() => {}} renderDatabaseRef={() => null} />
  </main>;
  const view = render(draw(page));
  const rect = (top: number, height: number) => ({ left: 20, right: 620, top, bottom: top + height, width: 600, height, x: 20, y: top, toJSON() {} });
  vi.spyOn(view.container.querySelector('main')!, 'getBoundingClientRect').mockReturnValue(rect(0, 600));
  view.container.querySelectorAll<HTMLElement>('[data-block-id]').forEach((block, index) => {
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(rect(80 + index * 120, 100));
  });
  const handle = screen.getAllByRole('button', { name: 'Block menu' })[2];
  const start = () => {
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 30, clientY: 340, button: 0 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 30, clientY: 90 });
  };
  return { ...view, start, handle, onEdit, redraw: (value: PageDto) => view.rerender(draw(value)) };
}

describe('native block pointer sorting', () => {
  it('moves across Home segments using the full page order and suppresses the trailing menu click', async () => {
    const view = harness();
    view.start();
    expect(document.querySelector('.native-page-drop')).toBeTruthy();
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 30, clientY: 90 });
    await waitFor(() => expect(view.onEdit).toHaveBeenCalledWith([{ op: 'move', id: 'C', after: null, expectRev: 1 }], 2));
    fireEvent.click(view.handle);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('.native-page-drop')).toBeNull();
  });

  it('cancels with Escape without writing or opening the menu', () => {
    const view = harness();
    view.start();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(document, { pointerId: 1 });
    fireEvent.click(view.handle);
    expect(view.onEdit).not.toHaveBeenCalled();
    expect(document.querySelector('.native-page-drop')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('refuses an outdated drop when the page changes during the drag', () => {
    const view = harness();
    view.start();
    view.redraw({ ...initial, revision: 3 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(view.onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('The page changed while dragging. Try again.');
  });

  it('keeps the original order when saving the drop fails', async () => {
    const view = harness(initial, vi.fn().mockResolvedValue('failed'));
    view.start();
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect((await screen.findByRole('alert')).textContent).toBe('Could not move this block. Try again.');
    expect([...view.container.querySelectorAll<HTMLElement>('[data-block-id]')].map(block => block.dataset.blockId)).toEqual(['A', 'B', 'C']);
  });
});
