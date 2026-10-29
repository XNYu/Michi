import React, { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PageBlock, PageDto, PageViewPresentation } from 'michi-shared';
import { NativePageDocument } from './NativePageDocument';

const action = (viewId = 'evidence', presentation: PageViewPresentation = 'drawer') => ({ type: 'open-view' as const, viewId, presentation });
const base = (presentation: PageViewPresentation = 'drawer'): PageDto => ({
  id: 'page-a', workspaceId: 'ws', parentId: null, position: 0, title: 'Comparison', color: null,
  updatedAt: 1, updatedBy: 'agent', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
  blocks: [
    { id: 'entry', rev: 1, type: 'view-link', label: 'Why A?', action: action('evidence', presentation) },
    { id: 'definition', rev: 1, type: 'view', viewId: 'evidence', title: 'Evidence', blockIds: ['notes', 'widget'] },
    { id: 'notes', rev: 1, type: 'markdown', text: 'Research supports A. [More](#view/more)', visibility: 'detail' },
    { id: 'widget', rev: 1, type: 'component', componentId: 'c', props: {}, visibility: 'detail' },
    { id: 'more-view', rev: 1, type: 'view', viewId: 'more', title: 'Sources', blockIds: ['more'] },
    { id: 'more', rev: 1, type: 'markdown', text: 'The original evidence.', visibility: 'detail' },
  ],
});
const edit = vi.fn(async () => 'ok' as const);
function Widget({ mounted }: { mounted: () => void }) {
  useEffect(mounted, [mounted]);
  const [value, setValue] = useState('');
  return <input aria-label="Local note" value={value} onChange={e => setValue(e.target.value)} />;
}
function document(page: PageDto, extra: Partial<React.ComponentProps<typeof NativePageDocument>> = {}) {
  return <NativePageDocument page={page} onEdit={edit} onOpenPage={vi.fn()} renderDatabaseRef={() => null} {...extra} />;
}

describe('native page views', () => {
  it.each(['inline', 'drawer', 'modal'] as const)('opens %s lazily and restores the trigger on close without writing', async presentation => {
    const mounted = vi.fn(), beforeWrites = edit.mock.calls.length;
    const result = render(document(base(presentation), { renderComponent: () => <Widget mounted={mounted} /> }));
    expect(screen.queryByText('Research supports A.')).toBeNull();
    expect(mounted).not.toHaveBeenCalled();
    const entry = screen.getByRole('link', { name: 'Why A?' }); entry.focus(); fireEvent.click(entry);
    const detail = screen.getByRole(presentation === 'inline' ? 'region' : 'dialog', { name: 'Evidence' });
    expect(within(detail).getByRole('textbox', { name: 'Local note' })).toBeTruthy();
    if (presentation === 'inline') expect(detail.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe('entry');
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(within(detail).getByRole('button', { name: presentation === 'inline' ? 'Close details' : 'Close' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Local note' })).toBeNull());
    await waitFor(() => expect(entry).toBe(globalThis.document.activeElement));
    expect(edit.mock.calls.length).toBe(beforeWrites);
    result.unmount();
  });

  it('reuses one panel for linked views and keeps local input on return and live refresh', async () => {
    const mounted = vi.fn(), page = base();
    const props = { renderComponent: () => <Widget mounted={mounted} /> };
    const rendered = render(document(page, props));
    fireEvent.click(screen.getByRole('link', { name: 'Why A?' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Local note' }), { target: { value: 'Keep this' } });
    fireEvent.click(screen.getByRole('link', { name: 'More' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Sources' }).textContent).toContain('The original evidence.');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('link', { name: 'More' })).toBe(globalThis.document.activeElement);
    expect((screen.getByRole('textbox', { name: 'Local note' }) as HTMLInputElement).value).toBe('Keep this');
    rendered.rerender(document({ ...page, viewVersion: 2, blocks: page.blocks.map(b => b.id === 'notes' ? { ...b, text: 'Updated evidence.' } as PageBlock : b) }, props));
    expect(screen.getByRole('dialog').textContent).toContain('Updated evidence.');
    expect((screen.getByRole('textbox', { name: 'Local note' }) as HTMLInputElement).value).toBe('Keep this');
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it('opens Markdown, metric and arbitrary block entries and leaves static content valid', () => {
    const page = base('modal');
    page.blocks.unshift(
      { id: 'md', rev: 1, type: 'markdown', text: '[Background](#view/evidence?presentation=modal) and [Web](https://example.com)' },
      { id: 'metrics', rev: 1, type: 'metrics', items: [{ label: 'Review', value: '2', action: action() }, { label: 'Static', value: '3' }] },
      { id: 'compare', rev: 1, type: 'compare', options: [{ name: 'A' }, { name: 'B' }], interaction: { label: 'Tradeoffs', action: action() } },
    );
    render(document(page));
    for (const label of ['Background', 'Review: 2', 'Tradeoffs']) {
      fireEvent.click(screen.getByRole('link', { name: label }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    }
    expect(screen.getByRole('link', { name: 'Web' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('isolates page identities and displays unavailable targets without stale data', () => {
    const page = base(), shown = render(document(page));
    fireEvent.click(screen.getByRole('link', { name: 'Why A?' }));
    shown.rerender(document({ ...page, blocks: page.blocks.filter(b => b.id !== 'notes') }));
    expect(screen.getByRole('dialog').textContent).toContain('Some content in this view is no longer available');
    shown.rerender(document({ ...page, blocks: page.blocks.filter(b => b.id !== 'definition') }));
    expect(screen.getByRole('dialog').textContent).toContain('no longer available');
    expect(screen.queryByText('Research supports A.')).toBeNull();
    shown.rerender(document({ ...base(), id: 'page-b' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    shown.rerender(document({ ...page, id: 'page-b', blocks: page.blocks.filter(b => b.type !== 'view') }));
    expect(screen.getByRole('link', { name: /Why A/ }).getAttribute('aria-disabled')).toBe('true');
  });

  it('places inline content below the entry in compact previews and gives repeated content distinct DOM identities', () => {
    const page = base('inline');
    page.blocks = page.blocks.map(b => b.id === 'notes' ? { ...b, visibility: undefined } : b);
    const result = render(document(page, { compact: true }));
    fireEvent.click(screen.getByRole('link', { name: 'Why A?' }));
    expect(screen.getByRole('region', { name: 'Evidence' }).closest('[data-block-id]')?.getAttribute('data-block-id')).toBe('entry');
    const notes = result.container.querySelectorAll('.michi-doc-block[data-block-id="notes"]');
    expect(notes).toHaveLength(2);
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('keeps native edits, exact sources and read-only permissions inside details', async () => {
    const page = base(), source = { nodeId: 'n', turnId: 't', assistantId: 'a' }, onEdit = vi.fn(async () => 'ok' as const), open = vi.fn();
    page.blocks = page.blocks.map(b => b.id === 'notes' ? { id: b.id, rev: b.rev, type: 'checklist', visibility: 'detail', items: [{ text: 'Verify evidence', done: false }], sources: [source] } as PageBlock : b);
    const result = render(document(page, { onEdit, onOpenSource: open, sourceLabel: () => 'Research source' }));
    fireEvent.click(screen.getByRole('link', { name: 'Why A?' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verify evidence' }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith([expect.objectContaining({ id: 'notes', expectRev: 1, block: expect.objectContaining({ visibility: 'detail' }) })], 1));
    const notes = screen.getByRole('dialog', { name: 'Evidence' }).querySelector('.michi-doc-block[data-block-id="notes"]')!;
    fireEvent.click(within(notes as HTMLElement).getByRole('button', { name: 'Sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Research source' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(source));
    result.unmount();
    render(document(page, { readOnly: true, onEdit }));
    fireEvent.click(screen.getByRole('link', { name: 'Why A?' }));
    const checkbox = screen.getByRole('checkbox', { name: 'Verify evidence' });
    expect(checkbox.getAttribute('aria-readonly')).toBe('true');
    onEdit.mockClear();
    fireEvent.click(checkbox);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
