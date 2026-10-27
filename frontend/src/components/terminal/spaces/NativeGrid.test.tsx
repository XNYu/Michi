import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PageBlock, PageDto, PageEditOp } from 'michi-shared';
import { NativePageDocument } from './NativePageDocument';

const grid = (): Extract<PageBlock, { type: 'grid' }> => ({ id: 'grid', type: 'grid', rev: 3, regions: [
  { id: 'main', span: 8, title: 'Main', blocks: [{ type: 'checklist', items: [{ text: 'Review', done: false }] }] },
  { id: 'attention', span: 4, title: 'Attention', blocks: [{ type: 'toggle', title: 'Details', blocks: [{ type: 'heading', text: 'Risk' }] }] },
] });
const page = (block: PageBlock = grid(), revision = 4): PageDto => ({
  id: 'page', workspaceId: 'ws', parentId: null, position: 0, title: 'Work', color: null,
  updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision, viewVersion: revision,
  blocks: [block],
});
const pendingEdit = () => vi.fn((_ops: PageEditOp[], _revision: number) => new Promise<'ok'>(() => {}));
const editedGrid = (onEdit: ReturnType<typeof pendingEdit>) => {
  const op = onEdit.mock.calls[0][0][0];
  if (op.op !== 'update' || op.block.type !== 'grid') throw new Error('Expected a native grid update');
  return op.block;
};

beforeEach(() => {
  class Pointer extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', Pointer);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native responsive grid', () => {
  it('saves region widths and nested interactions through native versioned edits', () => {
    const onEdit = pendingEdit();
    render(<NativePageDocument page={page()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange layout' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Main width' }), { target: { value: '9' } });
    const next = grid();
    next.regions[0].span = 9;
    const { id, rev, ...content } = next;
    expect(onEdit).toHaveBeenCalledWith([{ op: 'update', id, expectRev: rev, block: content }], 4);
    expect((screen.getByRole('combobox', { name: 'Main width' }) as HTMLSelectElement).value).toBe('9');
    expect(screen.getByRole('checkbox', { name: 'Review' })).toBeTruthy();
  });

  it('keeps region ids and expanded child state when regions move', () => {
    const onEdit = pendingEdit();
    const { container } = render(<NativePageDocument page={page()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    const details = container.querySelector('details')!;
    details.open = true;
    const childId = details.parentElement?.dataset.blockId;
    fireEvent.click(screen.getByRole('button', { name: 'Arrange layout' }));
    expect(screen.getByRole('button', { name: 'Move Main earlier' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Attention earlier' }));
    expect([...container.querySelectorAll('[data-region-id]')].map(element => element.getAttribute('data-region-id'))).toEqual(['attention', 'main']);
    expect(container.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
    expect(details.parentElement?.dataset.blockId).toBe(childId);
    expect(editedGrid(onEdit).regions.map(region => region.id)).toEqual(['attention', 'main']);
  });

  it('updates a nested checklist in the owning grid without sending renderer child ids', () => {
    const onEdit = pendingEdit();
    render(<NativePageDocument page={page()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Review' }));
    const content = editedGrid(onEdit);
    expect(content.regions[0].blocks).toEqual([{ type: 'checklist', items: [{ text: 'Review', done: true }] }]);
    expect(content.regions[1]).toEqual(grid().regions[1]);
  });

  it('previews a pointer resize, ignores other pointers and saves once on release', () => {
    const onEdit = pendingEdit();
    const { container } = render(<NativePageDocument page={page()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    const layout = container.querySelector<HTMLElement>('.michi-doc-grid')!;
    layout.style.columnGap = '0px';
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({ width: 1200 } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange layout' }));
    const handle = screen.getByRole('button', { name: 'Drag to resize Main' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100 });
    expect(onEdit).not.toHaveBeenCalled();
    expect((screen.getByRole('combobox', { name: 'Main width' }) as HTMLSelectElement).value).toBe('7');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700 });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(editedGrid(onEdit).regions[0].span).toBe(7);
  });

  it('cancels a pointer resize without saving, and removes controls in read-only mode', () => {
    const onEdit = pendingEdit();
    const props = { page: page(), onEdit, onOpenPage: vi.fn(), renderDatabaseRef: () => null };
    const { container, rerender } = render(<NativePageDocument {...props} />);
    const layout = container.querySelector<HTMLElement>('.michi-doc-grid')!;
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({ width: 1200 } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange layout' }));
    const handle = screen.getByRole('button', { name: 'Drag to resize Main' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect((screen.getByRole('combobox', { name: 'Main width' }) as HTMLSelectElement).value).toBe('8');
    expect(onEdit).not.toHaveBeenCalled();
    rerender(<NativePageDocument {...props} readOnly />);
    expect(screen.queryByRole('button', { name: /arrang/i })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('keeps live content received during a drag and uses the current native revision', () => {
    const onEdit = pendingEdit();
    const draw = (value: PageDto) => <NativePageDocument page={value} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />;
    const { container, rerender } = render(draw(page()));
    const layout = container.querySelector<HTMLElement>('.michi-doc-grid')!;
    layout.style.columnGap = '0px';
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({ width: 1200 } as DOMRect);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange layout' }));
    const handle = screen.getByRole('button', { name: 'Drag to resize Main' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    const changed = grid();
    changed.rev = 4;
    changed.regions[0].blocks = [{ type: 'markdown', text: 'New server content' }];
    rerender(draw(page(changed, 5)));
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700 });
    expect(onEdit.mock.calls[0][0][0]).toMatchObject({ id: 'grid', expectRev: 4, block: { regions: [{ ...changed.regions[0], span: 7 }, changed.regions[1]] } });
    expect(onEdit.mock.calls[0][1]).toBe(5);
  });

  it('restores the saved layout and explains a refused save', async () => {
    const onEdit = vi.fn().mockResolvedValue('stale');
    render(<NativePageDocument page={page()} onEdit={onEdit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange layout' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Main width' }), { target: { value: '9' } });
    expect((await screen.findByRole('alert')).textContent).toContain('page changed');
    expect((screen.getByRole('combobox', { name: 'Main width' }) as HTMLSelectElement).value).toBe('8');
  });

  it('includes headings in grid regions in the native contents navigation', async () => {
    const current = page();
    current.blocks.unshift({ id: 'contents', rev: 1, type: 'toc' });
    const { container } = render(<NativePageDocument page={current} onEdit={pendingEdit()} onOpenPage={vi.fn()} renderDatabaseRef={() => null} />);
    const contents = screen.getByRole('navigation', { name: 'Contents' });
    fireEvent.click(within(contents).getByRole('button', { name: 'Risk' }));
    await waitFor(() => expect(container.querySelector('details')?.open).toBe(true));
    expect(container.querySelector('[data-flash]')).toBeTruthy();
  });
});
