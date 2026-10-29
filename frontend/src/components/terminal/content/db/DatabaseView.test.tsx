import React, { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MichiDatabase, MichiDbEditOp, MichiDbView } from 'michi-shared';
import { DatabaseView, type DatabaseViewServices } from './DatabaseView';
import { DOUBLE_CLICK_MS } from './views/TableView';
import { findBoardCard } from './views/BoardView';
import { applyOpsLocally, userDatabase } from './dbTestData';

const michiState = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));

const NOW = new Date(2026, 9, 21, 15, 0).getTime();
const edits = vi.fn();

/** DatabaseView over a database that takes every edit, as Michi would. */
function Harness({ initial, services, onAddCustomView }: { initial: MichiDatabase; services?: DatabaseViewServices; onAddCustomView?: () => void }) {
  const [db, setDb] = useState(initial);
  const [viewId, setViewId] = useState<string | null>(null);
  const edit = async (ops: MichiDbEditOp[], label: string) => {
    edits(ops, label);
    setDb((d) => applyOpsLocally(d, ops, 2));
    return true;
  };
  return <DatabaseView db={db} edit={edit} viewId={viewId} onViewChange={setViewId} threadOf={() => undefined} now={NOW} services={services} onAddCustomView={onAddCustomView} />;
}

function withView(view: Partial<MichiDbView>): MichiDatabase {
  const db = userDatabase();
  return { ...db, views: [{ ...db.views[0], ...view }] };
}

function setup(db: MichiDatabase = userDatabase()) {
  return render(<Harness initial={db} />);
}

const lastOps = () => edits.mock.calls[edits.mock.calls.length - 1][0] as MichiDbEditOp[];
const lastLabel = () => edits.mock.calls[edits.mock.calls.length - 1][1] as string;
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);
const rowNames = () => screen.getAllByRole('row').slice(1).flatMap((r) => {
  const t = r.querySelector('td:nth-child(2) .michi-db-text')?.textContent;
  return t ? [t] : [];
});

beforeEach(() => {
  edits.mockReset();
  window.localStorage.clear();
  michiState.value = { setNotice: vi.fn(), peekThreadId: null, openPeek: vi.fn(), archive: vi.fn(), ignore: vi.fn() };
});

describe('the column menu', () => {
  it('renames a column', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    const name = screen.getByRole('textbox', { name: 'Column name' });
    fireEvent.change(name, { target: { value: 'Urgency' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(lastOps()).toEqual([{ op: 'column.update', id: 'c_pri', patch: { name: 'Urgency' } }]);
    expect(lastLabel()).toBe('Renamed column');
    expect(headers()).toContain('Urgency');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('changes a type from the Type submenu', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Type/ }));
    const types = screen.getByRole('menu', { name: 'Column type' });
    expect(within(types).getAllByRole('menuitemradio').map((m) => m.textContent)).toEqual(['Text', 'Number', 'Date', 'Select', 'Multi-select', 'Checkbox', 'Link', 'Progress', 'App', 'Image']);
    expect(within(types).getByRole('menuitemradio', { name: 'Number' }).getAttribute('aria-checked')).toBe('true');
    expect(within(types).getByRole('menuitemradio', { name: 'Text' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(types).getByRole('menuitemradio', { name: 'Progress' }));
    expect(lastOps()).toEqual([{ op: 'column.update', id: 'c_effort', patch: { type: 'progress' } }]);
    expect(lastLabel()).toBe('Changed Effort to Progress');
  });

  it('hides a column in this view and deletes one', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide in this view' }));
    expect(lastOps()[0]).toMatchObject({ op: 'view.save', view: { config: { visible: ['c_name', 'c_pri', 'c_due', 'c_effort', 'c_done'] } } });
    expect(headers()).not.toContain('Tags');

    fireEvent.click(screen.getByRole('button', { name: 'Due' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete column' }));
    expect(lastOps()).toEqual([{ op: 'column.delete', id: 'c_due' }]);
    expect(lastLabel()).toBe('Deleted column Due');
    expect(headers()).not.toContain('Due');
  });

  it('sorts by a column and opens the filter panel on a new condition', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort High → low' }));
    expect(rowNames()).toEqual(['Book the hotel', 'Pack', 'Rail pass']);
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort Low → high' }));
    expect(rowNames()).toEqual(['Pack', 'Book the hotel', 'Rail pass']);

    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by Priority' }));
    expect(lastOps()[0]).toMatchObject({ view: { config: { filters: [{ column: 'c_pri', op: 'is' }] } } });
    expect(screen.getByRole('dialog', { name: 'Filter' })).toBeTruthy();
  });

  it('adds a column with a name and a type', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    const panel = screen.getByRole('dialog', { name: 'Add column' });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Column name' }), { target: { value: 'Link' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Link' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    expect(lastOps()[0]).toMatchObject({ op: 'column.add', column: { name: 'Link', type: 'url' }, after: 'c_done' });
    expect(headers()).toContain('Link');
  });
});

describe('view creation adapters', () => {
  it('offers every view type, and Custom… only where the caller has custom views built', () => {
    const desk = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    expect(within(screen.getByRole('menu', { name: 'Add view' })).getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['Table', 'Board', 'List', 'Timeline', 'Calendar', 'Gallery']);
    desk.unmount();

    const onAddCustomView = vi.fn();
    render(<Harness initial={userDatabase()} services={{}} onAddCustomView={onAddCustomView} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Add view' })).getByRole('menuitem', { name: 'Custom…' }));
    expect(onAddCustomView).toHaveBeenCalledOnce();
    expect(edits).not.toHaveBeenCalled();
  });
});

describe('filters, sorts and groups', () => {
  it('starts the table from its first row when the filters change', () => {
    const { container } = setup();
    const table = container.querySelector('.michi-db-table') as HTMLElement;
    table.scrollTop = 120;
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
    const value = screen.getByRole('textbox', { name: 'Filter 1 value' });
    fireEvent.change(value, { target: { value: 'hotel' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(rowNames()).toEqual(['Book the hotel']);
    expect(table.scrollTop).toBe(0);
  });

  it('adds a condition, shows it as a chip, and takes it off', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
    // Nothing is saved on the shared view until the condition has a value.
    expect(edits).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    const value = screen.getByRole('textbox', { name: 'Filter 1 value' });
    fireEvent.change(value, { target: { value: 'hotel' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(lastOps()[0]).toMatchObject({ view: { config: { filters: [{ column: 'c_name', op: 'contains', value: 'hotel' }] } } });
    expect(rowNames()).toEqual(['Book the hotel']);
    expect(screen.getByText('1 row')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter, 1 on' })).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    const chips = screen.getByRole('group', { name: 'Filters' });
    expect(within(chips).getByText('Name contains hotel')).toBeTruthy();
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove filter Name contains hotel' }));
    expect(rowNames()).toHaveLength(3);
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
  });

  it('keeps an unfinished condition in the panel only, and saves one that needs no value at once', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter 1 column' }), { target: { value: 'c_pri' } });
    expect(edits).not.toHaveBeenCalled();
    // Removing it again: still nothing to save.
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter 1' }));
    expect(edits).not.toHaveBeenCalled();
    expect(screen.getByText('No filters')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter 1 condition' }), { target: { value: 'empty' } });
    expect(lastOps()).toMatchObject([{ view: { config: { filters: [{ column: 'c_name', op: 'empty' }] } } }]);
    expect(screen.getByRole('button', { name: 'Filter, 1 on' }).getAttribute('data-on')).toBe('true');

    // A second, unfinished one waits while the first stays saved.
    fireEvent.click(screen.getByRole('button', { name: '+ Add filter' }));
    expect(edits).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Filter 2 value' })).toBeTruthy();
  });

  it('matches any condition when asked', () => {
    setup(withView({ config: { filters: [{ column: 'c_pri', op: 'is', value: 'High' }, { column: 'c_done', op: 'checked' }], match: 'all', sorts: [] } }));
    expect(rowNames()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Filter, 2 on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Any of' }));
    expect(rowNames()).toEqual(['Book the hotel', 'Rail pass']);
  });

  it('orders by several sorts and removes one', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add sort' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort 1 column' }), { target: { value: 'c_effort' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort 1 direction' }), { target: { value: 'desc' } });
    expect(rowNames()).toEqual(['Book the hotel', 'Pack', 'Rail pass']);
    fireEvent.click(screen.getByRole('button', { name: '+ Add sort' }));
    expect(lastOps()[0]).toMatchObject({ view: { config: { sorts: [{ column: 'c_effort', dir: 'desc' }, { column: 'c_name', dir: 'asc' }] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove sort 1' }));
    expect(lastOps()[0]).toMatchObject({ view: { config: { sorts: [{ column: 'c_name', dir: 'asc' }] } } });
  });

  it('groups by a column with counts and sums, hiding empty groups by choice', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'c_pri' } });
    expect(screen.getByRole('button', { name: 'Group: Priority' })).toBeTruthy();
    const groups = () => Array.from(document.querySelectorAll('.michi-db-group-row')).map((g) => g.textContent);
    expect(groups()).toEqual(['High1', 'Low1', 'Empty1']);
    fireEvent.click(screen.getByRole('switch', { name: 'Sum of Effort' }));
    expect(groups()).toEqual(['High1· Effort 3', 'Low1· Effort 2', 'Empty1']);
    fireEvent.click(screen.getByRole('switch', { name: 'Hide empty groups' }));
    expect(groups()).toEqual(['High1· Effort 3', 'Normal0', 'Low1· Effort 2', 'Empty1']);
    fireEvent.click(screen.getByRole('switch', { name: 'Show counts' }));
    expect(groups()[0]).toBe('High· Effort 3');
    // Kept on this machine, per view.
    expect(JSON.parse(window.localStorage.getItem('michi:desk:db-group:db_trip:table')!)).toEqual({ showCounts: false, sums: ['c_effort'], hideEmpty: false });
  });
});

describe('cells', () => {
  it('edits a select with a new option, and toggles a checkbox', () => {
    setup();
    const row = screen.getByText('Pack').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByText('Low'));
    const find = screen.getByRole('textbox', { name: 'Find an option for Priority' });
    fireEvent.change(find, { target: { value: 'Someday' } });
    fireEvent.click(screen.getByRole('option', { name: 'Create “Someday”' }));
    expect(lastOps()).toEqual([
      { op: 'option.add', id: 'c_pri', option: { value: 'Someday' } },
      { op: 'row.update', id: 'r2', values: { c_pri: 'Someday' } },
    ]);
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Reviewed' }));
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r2', values: { c_done: true } }]);
  });

  it('refuses a link that is not one and gives up on Esc', () => {
    const db = userDatabase();
    setup({ ...db, columns: [...db.columns, { id: 'c_url', name: 'Site', type: 'url' }] });
    const row = screen.getByText('Pack').closest('tr') as HTMLElement;
    const cell = row.querySelector('[data-type="url"] .michi-db-cell') as HTMLElement;
    fireEvent.click(cell);
    const field = screen.getByRole('textbox', { name: 'Edit Site' });
    fireEvent.change(field, { target: { value: 'javascript:alert(1)' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe("That isn't a link");
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit Site' })).toBeNull();
    expect(edits).not.toHaveBeenCalled();
  });

  it('keeps a number cell open on Enter with something that is not a number', () => {
    setup();
    const row = screen.getByText('Pack').closest('tr') as HTMLElement;
    fireEvent.click(row.querySelector('[data-type="number"] .michi-db-cell') as HTMLElement);
    const field = screen.getByRole('textbox', { name: 'Edit Effort' });
    fireEvent.change(field, { target: { value: 'lots' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Type a number');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(edits).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '1,250' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r2', values: { c_effort: 1250 } }]);
  });

  it('gives up a number that is not one on leaving, and clears the cell only when emptied', () => {
    setup();
    const cell = () => (screen.getByText('Pack').closest('tr') as HTMLElement).querySelector('[data-type="number"] .michi-db-cell') as HTMLElement;
    fireEvent.click(cell());
    let field = screen.getByRole('textbox', { name: 'Edit Effort' });
    fireEvent.change(field, { target: { value: 'Infinity' } });
    fireEvent.blur(field);
    expect(screen.queryByRole('textbox', { name: 'Edit Effort' })).toBeNull();
    expect(edits).not.toHaveBeenCalled();
    fireEvent.click(cell());
    field = screen.getByRole('textbox', { name: 'Edit Effort' });
    fireEvent.change(field, { target: { value: '  ' } });
    fireEvent.blur(field);
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r2', values: { c_effort: null } }]);
  });

  it('opens a row from its title, and edits the title only on double-click, Enter or Rename', () => {
    setup();
    const cell = () => screen.getByText('Pack').closest('[data-cell]') as HTMLElement;
    fireEvent.click(screen.getByText('Pack'));
    expect(within(screen.getByRole('dialog', { name: /Row/ })).getByRole('heading', { level: 2 }).textContent).toBe('Pack');
    expect(screen.queryByRole('textbox', { name: 'Edit Name' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent.doubleClick(cell());
    const field = screen.getByRole('textbox', { name: 'Edit Name' });
    fireEvent.change(field, { target: { value: 'Pack light' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r2', values: { c_name: 'Pack light' } }]);

    fireEvent.keyDown(screen.getByText('Pack light').closest('[data-cell]') as HTMLElement, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit Name' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Rename Pack light' }));
    expect(screen.getByRole('textbox', { name: 'Edit Name' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
  });

  it('opens a row a moment after a mouse click on its title, so a double-click only renames', () => {
    vi.useFakeTimers();
    try {
      setup();
      const peek = () => screen.queryByRole('dialog', { name: /Row/ });
      const title = () => screen.getByText('Pack');
      // A double-click: two clicks (detail 1, then 2) and the dblclick.
      fireEvent.click(title(), { detail: 1 });
      fireEvent.click(title(), { detail: 2 });
      fireEvent.doubleClick(title(), { detail: 2 });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(peek()).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Edit Name' })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit Name' }), { key: 'Escape' });

      // One click opens it once the double-click window has passed.
      fireEvent.click(title(), { detail: 1 });
      expect(peek()).toBeNull();
      act(() => { vi.advanceTimersByTime(DOUBLE_CLICK_MS); });
      expect(peek()).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens only the last title clicked, and nothing once a cell is being edited', () => {
    vi.useFakeTimers();
    try {
      setup();
      const peekTitle = () => screen.queryByRole('dialog', { name: /Row/ })?.querySelector('h2')?.textContent ?? null;
      // One pending open per table: a later click takes it over.
      fireEvent.click(screen.getByText('Pack'), { detail: 1 });
      fireEvent.click(screen.getByText('Rail pass'), { detail: 1 });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(peekTitle()).toBe('Rail pass');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(peekTitle()).toBeNull();

      // A click on another cell starts editing it, and the title waiting to open doesn't.
      fireEvent.click(screen.getByText('Pack'), { detail: 1 });
      fireEvent.click(screen.getByText('Low'), { detail: 1 });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(peekTitle()).toBeNull();
      expect(document.querySelector('[data-editing="true"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds a row from the table and edits its name', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '+ New row' }));
    expect(lastOps()[0]).toMatchObject({ op: 'row.add' });
    const field = screen.getByRole('textbox', { name: 'Edit Name' });
    fireEvent.change(field, { target: { value: 'Visa' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(rowNames()).toContain('Visa');
  });
});

describe('long databases', () => {
  it('draws three hundred rows, then more on request', () => {
    const db = userDatabase();
    const rows = Array.from({ length: 305 }, (_, i) => ({ id: `n${i}`, values: { c_name: `Row ${i}` }, position: i, updatedAt: 1 }));
    setup({ ...db, rows });
    // Count the rendered rows without an accessibility scan of every cell/control.
    const body = screen.getByRole('table').querySelector('tbody')!;
    expect(body.querySelectorAll('tr')).toHaveLength(300);
    fireEvent.click(screen.getByText('5 more', { selector: 'button' }));
    expect(body.querySelectorAll('tr')).toHaveLength(305);
    expect(screen.queryByText(/more$/, { selector: 'button' })).toBeNull();
  });
});

describe('the rows batch bar', () => {
  it('sets a value, hands rows to the assistant and deletes them', async () => {
    setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book the hotel' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Pack' }));
    const bar = screen.getByRole('toolbar', { name: '2 rows selected' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Set Priority…', 'Delete', 'Hand to agent…', '×']);

    fireEvent.click(within(bar).getByRole('button', { name: 'Set Priority…' }));
    const form = screen.getByRole('dialog', { name: 'Set a value on 2 rows' });
    fireEvent.change(within(form).getByDisplayValue('Empty'), { target: { value: 'Normal' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Set on 2 rows' })); });
    expect(lastOps()).toEqual([
      { op: 'row.update', id: 'r1', values: { c_pri: 'Normal' } },
      { op: 'row.update', id: 'r2', values: { c_pri: 'Normal' } },
    ]);
    expect(lastLabel()).toBe('Set Priority on 2 rows');

    const heard = vi.fn();
    window.addEventListener('michi:assistant-open', heard);
    try {
      fireEvent.click(within(bar).getByRole('button', { name: 'Hand to agent…' }));
      const items = (heard.mock.calls[0][0] as CustomEvent).detail.attachments;
      expect(items.map((i: { kind: string; id: string }) => [i.kind, i.id])).toEqual([['row', 'db_trip:r1'], ['row', 'db_trip:r2']]);
      expect(items[0].text).toContain('Priority: Normal');
    } finally {
      window.removeEventListener('michi:assistant-open', heard);
    }

    fireEvent.click(within(bar).getByRole('button', { name: 'Delete' }));
    expect(lastOps()).toEqual([{ op: 'row.delete', id: 'r1' }, { op: 'row.delete', id: 'r2' }]);
    expect(rowNames()).toEqual(['Rail pass']);
    expect(screen.queryByRole('toolbar', { name: /selected/ })).toBeNull();
  });
});

describe('the row drawer', () => {
  it('uses injected native services and hides Michi assistant actions', () => {
    render(<Harness initial={userDatabase()} services={{ notice: vi.fn(), copyText: vi.fn().mockResolvedValue(undefined) }} />);
    fireEvent.click(screen.getByText('Book the hotel'));
    const drawer = screen.getByRole('dialog', { name: /Row/ });
    expect(within(drawer).queryByRole('button', { name: 'Hand to agent…' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book the hotel' }));
    const bar = screen.getByRole('toolbar', { name: '1 row selected' });
    expect(within(bar).queryByRole('button', { name: 'Hand to agent…' })).toBeNull();
  });

  it('shows every property and the body, each editable, and steps with ↑/↓', () => {
    setup();
    fireEvent.click(screen.getByText('Book the hotel'));
    const drawer = screen.getByRole('dialog', { name: /Row/ });
    expect(within(drawer).getByText('旅行清单')).toBeTruthy();
    expect(within(drawer).getByText('Oct 25 → 27')).toBeTruthy();
    expect(within(drawer).getByText('Ace').tagName).toBe('STRONG');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit Effort' }));
    const effort = within(drawer).getByRole('textbox', { name: 'Edit Effort' });
    fireEvent.change(effort, { target: { value: '4' } });
    fireEvent.keyDown(effort, { key: 'Enter' });
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r1', values: { c_effort: 4 } }]);

    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit' }));
    const notes = within(drawer).getByRole('textbox', { name: 'Notes' });
    fireEvent.change(notes, { target: { value: 'Kanra it is' } });
    fireEvent.blur(notes);
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r1', body: 'Kanra it is' }]);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(within(screen.getByRole('dialog', { name: /Row/ })).getByRole('heading', { level: 2 }).textContent).toBe('Pack');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Pack' })).toBeNull();
  });

  it('steps only through the rows the view draws', () => {
    const db = userDatabase();
    // Pack is dated in November: the October calendar does not draw it, nor Unpack (no date).
    const dated = { ...db, rows: db.rows.map((r) => (r.id === 'r2' ? { ...r, values: { ...r.values, c_due: { start: '2026-11-03' } } } : r)) };
    setup({ ...dated, views: [{ ...db.views[0], type: 'calendar', config: { filters: [], match: 'all', sorts: [], date: 'c_due' } }] });
    fireEvent.click(within(screen.getByRole('group', { name: 'October 25' })).getByText('Book the hotel'));
    const heading = () => within(screen.getByRole('dialog', { name: /Row/ })).getByRole('heading', { level: 2 }).textContent;
    expect(heading()).toBe('Book the hotel');
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(heading()).toBe('Book the hotel');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'November 3' })).getByText('Pack'));
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    expect(heading()).toBe('Pack');
  });

  it('a Shift-click range on a board takes only the cards it draws', () => {
    const db = userDatabase();
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `n${i}`, values: { c_name: `Card ${i}`, c_pri: 'High' }, position: i, updatedAt: 1 }));
    setup({ ...db, rows: [...rows, { id: 'z', values: { c_name: 'Low card', c_pri: 'Low' }, position: 300, updatedAt: 1 }], views: [{ ...db.views[0], type: 'board' }] });
    const card = (name: string) => screen.getByText(name).closest('[data-thread-id]') as HTMLElement;
    fireEvent.click(card('Card 0'), { metaKey: true });
    // Card 200-204 sit under "5 more" in High; the range runs on to Low's card.
    fireEvent.click(card('Low card'), { shiftKey: true });
    expect(screen.getByRole('toolbar', { name: '201 rows selected' })).toBeTruthy();
  });

  it('opens on a new row from New', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(lastOps()[0]).toMatchObject({ op: 'row.add', values: {} });
    expect(within(screen.getByRole('dialog', { name: /Row/ })).getByRole('heading', { level: 2 }).textContent).toBe('Untitled');
  });
});

describe('views of a database a person made', () => {
  it('renames a view and keeps the last one from being deleted', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'More for Table' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'View name' });
    fireEvent.change(field, { target: { value: 'Everything' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(lastOps()).toEqual([{ op: 'view.save', view: { id: 'table', name: 'Everything', type: 'table', config: { filters: [], match: 'all', sorts: [] } } }]);
    expect(screen.getByRole('tab', { name: 'Everything' })).toBeTruthy();
  });

  it('offers each board card to the keyboard and keeps Enter for opening it', () => {
    setup(withView({ type: 'board' }));
    const card = within(screen.getByRole('region', { name: 'High' })).getByText('Book the hotel').closest('[data-thread-id]') as HTMLElement;
    expect(card.getAttribute('aria-roledescription')).toBe('draggable card');
    expect(document.getElementById(card.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/Press Space to pick up this card/);
    fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });
    expect(within(screen.getByRole('dialog', { name: /Row/ })).getByRole('heading', { level: 2 }).textContent).toBe('Book the hotel');
  });

  it('adds a card at the foot of a board column, in that column', () => {
    setup(withView({ type: 'board' }));
    const low = () => screen.getByRole('region', { name: 'Low' });
    fireEvent.click(within(low()).getByRole('button', { name: 'New in Low' }));
    const field = within(low()).getByRole('textbox', { name: 'New in Low' });
    fireEvent.change(field, { target: { value: 'Buy adapters' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(lastOps()).toEqual([{ op: 'row.add', id: expect.any(String), values: { c_pri: 'Low', c_name: 'Buy adapters' } }]);
    expect(lastLabel()).toBe('Added a row');
    expect(within(low()).getByText('Buy adapters')).toBeTruthy();
    // Esc gives up without adding anything.
    const high = () => screen.getByRole('region', { name: 'High' });
    fireEvent.click(within(high()).getByRole('button', { name: 'New in High' }));
    fireEvent.keyDown(within(high()).getByRole('textbox', { name: 'New in High' }), { key: 'Escape' });
    expect(edits).toHaveBeenCalledTimes(1);
    // A board keeps empty columns to drop into.
    expect(screen.getByRole('region', { name: 'Normal' })).toBeTruthy();
  });

  it('hands focus back to the column\'s add button when the new-card field closes', async () => {
    setup(withView({ type: 'board' }));
    const low = () => screen.getByRole('region', { name: 'Low' });
    fireEvent.click(within(low()).getByRole('button', { name: 'New in Low' }));
    fireEvent.keyDown(within(low()).getByRole('textbox', { name: 'New in Low' }), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(within(low()).getByRole('button', { name: 'New in Low' })));
    fireEvent.click(within(low()).getByRole('button', { name: 'New in Low' }));
    const field = within(low()).getByRole('textbox', { name: 'New in Low' });
    fireEvent.change(field, { target: { value: 'Buy adapters' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(within(low()).getByRole('button', { name: 'New in Low' })));
  });

  it('does not wrongly take Enter while an input method is composing in the new-card field', () => {
    setup(withView({ type: 'board' }));
    const low = () => screen.getByRole('region', { name: 'Low' });
    fireEvent.click(within(low()).getByRole('button', { name: 'New in Low' }));
    const field = within(low()).getByRole('textbox', { name: 'New in Low' });
    fireEvent.change(field, { target: { value: 'ni' } });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(edits).not.toHaveBeenCalled();
    expect(within(low()).getByRole('textbox', { name: 'New in Low' })).toBeTruthy();
  });

  it('offers no new card on a board grouped by its own title column', () => {
    setup(withView({ type: 'board', config: { filters: [], match: 'all', sorts: [], group: 'c_name' } }));
    expect(document.querySelectorAll('.michi-db-col__add')).toHaveLength(0);
    expect(document.querySelectorAll('.michi-db-col').length).toBeGreaterThan(0);
  });

  it('finds the card a keyboard move left in its new column', () => {
    setup(withView({ type: 'board' }));
    const board = document.querySelector('.michi-db-board') as HTMLElement;
    const card = within(screen.getByRole('region', { name: 'High' })).getByText('Book the hotel').closest('.michi-card') as HTMLElement;
    expect(findBoardCard(board, 'High', card.getAttribute('data-thread-id') as string)).toBe(card);
    expect(findBoardCard(board, 'Low', card.getAttribute('data-thread-id') as string)).toBeNull();
    expect(findBoardCard(null, 'High', 'x')).toBeNull();
  });

  it('moves a calendar entry to another day, keeping its range', async () => {
    setup(withView({ type: 'calendar', config: { filters: [], match: 'all', sorts: [], date: 'c_due' } }));
    const from = screen.getByRole('group', { name: 'October 25' });
    const item = within(from).getByText('Book the hotel').closest('[data-thread-id]') as HTMLElement;
    fireEvent.dragStart(item);
    const to = screen.getByRole('group', { name: 'October 28' });
    fireEvent.dragOver(to);
    await act(async () => { fireEvent.drop(to); });
    expect(lastOps()).toEqual([{ op: 'row.update', id: 'r1', values: { c_due: { start: '2026-10-28', end: '2026-10-30' } } }]);
    expect(lastLabel()).toBe('Moved to Oct 28');
    expect(within(screen.getByRole('group', { name: 'October 28' })).getByText('Book the hotel')).toBeTruthy();
  });

  it('draws plan and actual on a timeline, and picks its date columns', () => {
    const db = userDatabase();
    const planned = {
      ...db,
      columns: [...db.columns, { id: 'c_plan', name: 'Plan', type: 'date' as const }],
      rows: db.rows.map((r) => (r.id === 'r1' ? { ...r, values: { ...r.values, c_plan: { start: '2026-10-24', end: '2026-10-26' } } } : r)),
      views: [{ ...db.views[0], type: 'timeline' as const, config: { filters: [], match: 'all' as const, sorts: [], date: 'c_due', planDate: 'c_plan' } }],
    };
    setup(planned);
    const grid = screen.getByRole('grid', { name: 'Table' });
    const lane = within(grid).getByText('Book the hotel').closest('[role="row"]') as HTMLElement;
    expect(lane.querySelector('.michi-db-tl__plan')).not.toBeNull();
    expect(lane.querySelector('.michi-db-tl__actual')?.getAttribute('data-over')).toBe('true');
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan' }), { target: { value: '' } });
    expect(lastOps()[0]).toMatchObject({ view: { config: { date: 'c_due' } } });
    expect((lastOps()[0] as Extract<MichiDbEditOp, { op: 'view.save' }>).view.config.planDate).toBeUndefined();
  });

  it('starts a list with the title and two short columns, and adds others from Properties', () => {
    setup(withView({ type: 'list' }));
    const row = () => screen.getByText('Book the hotel').closest('.michi-db-list__row') as HTMLElement;
    // Priority and Due; Effort, Tags and the rest wait to be chosen.
    expect(row().querySelector('.michi-db-facts--line')!.textContent).toBe('HighOct 25 → 27');
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    const panel = screen.getByRole('dialog', { name: 'Properties' });
    expect(within(panel).getByRole('switch', { name: 'Due' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(panel).getByRole('switch', { name: 'Effort' }));
    expect(lastOps()).toMatchObject([{ op: 'view.save', view: { type: 'list', config: { visible: ['c_name', 'c_pri', 'c_due', 'c_effort'] } } }]);
    expect(lastLabel()).toBe('Showed Effort');
    expect(row().querySelector('.michi-db-facts--line')!.textContent).toBe('HighOct 25 → 273');
    expect(screen.getByRole('button', { name: 'Properties' }).getAttribute('data-on')).toBe('true');
  });

  it('offers in Properties only the columns the view draws', () => {
    const switches = () => within(screen.getByRole('dialog', { name: 'Properties' })).getAllByRole('switch').map((s) => s.getAttribute('aria-label') ?? s.textContent);
    const withNote = (view: Partial<MichiDbView>) => {
      const db = withView(view);
      return { ...db, columns: [...db.columns, { id: 'c_note', name: 'Note', type: 'text' as const }] };
    };
    // A gallery card draws no text column.
    const gallery = setup(withNote({ type: 'gallery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    expect(switches()).toEqual(['Priority', 'Due', 'Effort', 'Tags', 'Reviewed']);
    gallery.unmount();
    // A board card leaves out the column it is grouped by.
    setup(withNote({ type: 'board', config: { filters: [], match: 'all', sorts: [], group: 'c_pri' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    expect(switches()).toEqual(['Due', 'Effort', 'Tags', 'Reviewed', 'Note']);
  });

  it('shows a gallery and a list, and a widget view as off', () => {
    const { unmount } = setup(withView({ type: 'gallery' }));
    expect(screen.getAllByText('Book the hotel')).toHaveLength(1);
    expect(screen.getByText('Kanra or Ace')).toBeTruthy();
    unmount();
    const list = setup(withView({ type: 'list' }));
    expect(screen.getByText('Rail pass')).toBeTruthy();
    list.unmount();
    setup(withView({ type: 'custom' }));
    expect(screen.getByText(/widgets are off/)).toBeTruthy();
  });
});
