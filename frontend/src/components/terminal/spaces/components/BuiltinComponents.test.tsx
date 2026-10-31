import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES, parsePageBlockInput } from 'michi-shared';
import { BuiltinComponents, builtinComponents } from './BuiltinComponents';

const NOW = new Date(2026, 9, 21, 12).getTime();
const cardOf = (name: string) => screen.getAllByRole('article').find((article) => article.querySelector('.component-catalog__caption h3')?.textContent === name)!;

describe('Built-in components', () => {
  it('lists every block a page shows, from the shared catalog', () => {
    const listed = builtinComponents(NOW).map((item) => item.type);
    const shown = PAGE_BLOCK_TYPES.filter((type) => PAGE_BLOCK_CATALOG[type].category !== 'references');
    expect([...listed].sort()).toEqual([...shown].sort());
    render(<BuiltinComponents now={NOW} />);
    expect(screen.getAllByRole('article')).toHaveLength(shown.length);
    for (const type of shown) expect(cardOf(PAGE_BLOCK_CATALOG[type].label)).toBeTruthy();
  });

  it('adds only blocks a page accepts', () => {
    for (const item of builtinComponents(NOW)) expect(parsePageBlockInput(item.block), item.type).toEqual(item.block);
  });

  it('filters real previews by category and search', () => {
    render(<BuiltinComponents now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decisions' }));
    expect(screen.getAllByRole('article').map((article) => article.querySelector('.component-catalog__caption code')?.textContent)).toEqual(['compare', 'conflict', 'actions', 'form', 'poll']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checklist' } });
    expect(screen.getByRole('status').textContent).toContain('No components match');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('preview interactions stay local and insertion uses the original block', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    render(<BuiltinComponents onInsert={onInsert} now={NOW} />);
    const card = cardOf('Checklist');
    const checkbox = within(card).getAllByRole('checkbox')[1];
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Add Checklist to the page' }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(PAGE_BLOCK_CATALOG.checklist.example));
    expect(onInsert.mock.calls[0][0].items[1].done).toBe(false);
  });

  it('picks an option and keeps a version in the preview', () => {
    render(<BuiltinComponents now={NOW} />);
    const compare = cardOf('Compare');
    fireEvent.click(within(compare).getAllByRole('button', { name: 'Pick this' })[1]);
    expect(within(compare).getByRole('button', { name: 'Picked' }).closest('li')?.textContent).toContain('Ace Hotel');
    const conflict = cardOf('Conflict');
    fireEvent.click(within(conflict).getByRole('radio', { name: /Nara/ }));
    fireEvent.click(within(conflict).getByRole('button', { name: 'Keep this' }));
    expect(within(conflict).getByText('Kept').closest('label')?.textContent).toContain('Nara');
  });

  it('previews grid widths and nested checklists locally, then inserts a valid default grid', async () => {
    const onInsert = vi.fn().mockResolvedValue(undefined);
    render(<BuiltinComponents onInsert={onInsert} now={NOW} />);
    // Keep unrelated previews from contributing work to this grid interaction test.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Responsive grid' } });
    const card = cardOf('Responsive grid');
    fireEvent.click(within(card).getByRole('checkbox', { name: 'Review the next step' }));
    expect(within(card).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(card).getByRole('button', { name: 'Arrange layout' }));
    fireEvent.change(within(card).getByRole('combobox', { name: 'Current work width' }), { target: { value: '7' } });
    expect(within(card).getByRole('combobox', { name: 'Current work width' })).toHaveProperty('value', '7');
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Add Responsive grid to the page' }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(PAGE_BLOCK_CATALOG.grid.example));
  }, 15_000); // Rendering the real gallery and editing its nested grid takes several seconds in jsdom.

  it('draws the plan in days around today and the thread cards from samples', () => {
    render(<BuiltinComponents onInsert={vi.fn()} now={NOW} />);
    const plan = cardOf('Plan vs actual');
    expect(within(plan).getByText('today')).toBeTruthy();
    expect(within(plan).getByText('Schema')).toBeTruthy();
    const threads = cardOf('Thread cards');
    expect(within(threads).getByText('S3 · Schema naming')).toBeTruthy();
    expect(within(threads).getByText('Running the last 9 suites.')).toBeTruthy();
    expect(within(threads).queryByRole('button', { name: /to the page/ })).toBeNull();
    expect(within(threads).getByText(/The assistant adds these/)).toBeTruthy();
  });

  it('keeps the gallery available after an insertion fails', async () => {
    render(<BuiltinComponents onInsert={vi.fn().mockRejectedValue(new Error('Page changed. Please retry.'))} now={NOW} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Metrics' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Metrics to the page' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Page changed. Please retry.');
    expect(screen.getByRole('button', { name: 'Add Metrics to the page' })).not.toHaveProperty('disabled', true);
  });
});
