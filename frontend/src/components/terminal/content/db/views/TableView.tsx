import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { MichiDbColumn, MichiDbEditOp, MichiDbRow } from 'michi-shared';
import { threadItemProps } from '../../threads/threadItem';
import { CellEditor } from '../CellEditor';
import { CellView } from '../CellView';
import { AddColumnButton, ColumnMenu, columnIcon } from '../ColumnMenu';
import { cellEditable, cellOf, isThreadsDb, shownColumns, startValues, titleColumn, type CellValue } from '../dbModel';
import { columnName, viewName } from '../dbLabels';
import { addRowOp, cellEditLabel, cellEditOps } from '../dbOps';
import { GroupHeading, groupSums, rowTitle, } from './RowBits';
import type { DbViewProps } from './viewTypes';

type Spot = { row: string; col: string };
const spotKey = (s: Spot) => `${s.row}\n${s.col}`;

/**
 * The table: a checkbox per row, a header menu per column (and `+` to add
 * one), group heading rows with counts and sums, and cells edited where they
 * sit (click or Enter). The title is the row's way in: a click opens the row
 * (the thread's peek); it is edited with a double-click, Enter while the cell
 * has focus, or its Rename button. On All threads only Title, Status (In progress /
 * Done) and Next take edits, plus columns a person added; its rows are
 * threads, so there is no New row. All tasks has neither a New row nor a `+`
 * for a column: tasks and columns are added in a workspace's own database.
 */
/**
 * How long a mouse click on an editable title waits before opening its row,
 * so the second click of a double-click (rename) can cancel it.
 */
export const DOUBLE_CLICK_MS = 300;

export function TableView(props: DbViewProps & { onFilterPanel?: () => void }) {
  const { db, view, config, groups, groupColumn, prefs, edit, handlers, notice, onFilterPanel } = props;
  const columns = useMemo(() => shownColumns(db, config), [db, config]);
  const title = titleColumn(db);
  const [editing, setEditing] = useState<Spot | null>(null);
  const [menu, setMenu] = useState<{ column: MichiDbColumn; anchor: HTMLElement } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);

  // A title clicked with the mouse opens its row a moment later, unless
  // another click (anywhere) or an edit comes first. One per table: a later
  // title click takes it over.
  const pendingOpen = useRef<(() => void) | null>(null);
  const cancelOpen = useCallback(() => {
    pendingOpen.current?.();
    pendingOpen.current = null;
  }, []);
  const openLater = useCallback((open: () => void) => {
    cancelOpen();
    const timer = window.setTimeout(() => {
      cancelOpen();
      open();
    }, DOUBLE_CLICK_MS);
    // Capture: the click that scheduled this has already passed the document.
    document.addEventListener('click', cancelOpen, { capture: true, once: true });
    pendingOpen.current = () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', cancelOpen, { capture: true });
    };
  }, [cancelOpen]);
  useEffect(() => cancelOpen, [cancelOpen]);
  const startEdit = (spot: Spot) => {
    cancelOpen();
    setEditing(spot);
  };

  // Other filters or another order: the rows start again from the top, clear of the sticky header.
  const arrangement = JSON.stringify([config.filters, config.match, config.sorts, config.group]);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [arrangement]);

  // After an edit, the cell keeps focus so the keyboard can go on from it.
  useLayoutEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = null;
    Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? []).find((el) => el.dataset.cell === key)?.focus({ preventScroll: true });
  });

  const stop = (spot: Spot) => {
    setEditing(null);
    focusNext.current = spotKey(spot);
  };
  const save = (row: MichiDbRow, column: MichiDbColumn, value: CellValue, extra?: MichiDbEditOp[]) => {
    stop({ row: row.id, col: column.id });
    const check = cellEditOps(db, row, column, value, extra);
    if (!check.ok) {
      notice(check.reason);
      return;
    }
    if (check.ops.length) void edit(check.ops, cellEditLabel(db, column, value));
  };
  const addRow = () => {
    const { id, op } = addRowOp(startValues(db, config));
    void edit([op], 'Added a row');
    if (title) startEdit({ row: id, col: title.id });
  };

  const grouped = config.group !== undefined && !!groupColumn;
  const rows = groups.reduce((n, g) => n + g.rows.length, 0);
  const span = columns.length + 2;
  const visibleIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => handlers.selected.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => handlers.selected.has(id));

  return (
    <div className="michi-db-table" ref={scroller}>
      <table className="michi-db-grid" aria-label={viewName(db, view)}>
        <colgroup>
          <col style={{ width: 34 }} />
          {columns.map((c) => <col key={c.id} style={{ width: c.width ?? (c.id === title?.id ? 300 : undefined) }} />)}
          <col style={{ width: 40 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="michi-db-th michi-db-th--check">
              <SelectAll
                checked={allSelected}
                mixed={someSelected}
                onChange={(on) => {
                  for (const id of visibleIds) {
                    if (handlers.selected.has(id) !== on) handlers.onItemToggle(id);
                  }
                }}
              />
            </th>
            {columns.map((c) => {
              const Icon = columnIcon(db, c);
              return (
                <th key={c.id} scope="col" className="michi-db-th" data-own={c.builtin ? undefined : 'true'}>
                  <button
                    type="button"
                    className="michi-db-th__btn"
                    aria-haspopup="menu"
                    aria-expanded={menu?.column.id === c.id}
                    onClick={(event) => {
                      const anchor = event.currentTarget;
                      setMenu((open) => (open?.column.id === c.id ? null : { column: c, anchor }));
                    }}
                  >
                    <Icon size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span className="michi-db-th__name">{columnName(db, c)}</span>
                  </button>
                </th>
              );
            })}
            <th scope="col" className="michi-db-th michi-db-th--add">
              {!db.merged && <AddColumnButton db={db} view={view} edit={edit} />}
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <React.Fragment key={g.key ?? '\u0000'}>
              {grouped && (
                <tr className="michi-db-group-row">
                  <th colSpan={span} scope="rowgroup">
                    <GroupHeading
                      db={db}
                      column={groupColumn}
                      group={g}
                      showCount={prefs.showCounts}
                      sums={groupSums(db, g, db.columns, prefs.sums)}
                    />
                  </th>
                </tr>
              )}
              {g.rows.map((row) => (
                <TableRow
                  key={`${g.key ?? ''}\n${row.id}`}
                  {...props}
                  row={row}
                  columns={columns}
                  editing={editing?.row === row.id ? editing.col : null}
                  onEdit={(col) => startEdit({ row: row.id, col })}
                  openLater={openLater}
                  cancelOpen={cancelOpen}
                  onSave={(column, value, extra) => save(row, column, value, extra)}
                  onCancel={(col) => stop({ row: row.id, col })}
                />
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      {rows === 0 && <p className="michi-db-empty">{db.rows.length ? 'Nothing matches these filters' : isThreadsDb(db) ? 'No threads yet' : 'No rows yet'}</p>}
      {!isThreadsDb(db) && !db.merged && (
        <button type="button" className="michi-db-new-row" onClick={addRow}>+ New row</button>
      )}
      {menu && (
        <ColumnMenu
          db={db}
          view={view}
          column={menu.column}
          anchor={menu.anchor}
          edit={edit}
          onClose={() => setMenu(null)}
          onFilter={onFilterPanel}
        />
      )}
    </div>
  );
}

function SelectAll({ checked, mixed, onChange }: { checked: boolean; mixed: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="michi-db-check"
      aria-label="Select all"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

function TableRow({
  db,
  row,
  columns,
  handlers,
  threadOf,
  now,
  notice,
  editing,
  onEdit,
  openLater,
  cancelOpen,
  onSave,
  onCancel,
}: DbViewProps & {
  row: MichiDbRow;
  columns: MichiDbColumn[];
  editing: string | null;
  onEdit: (col: string) => void;
  openLater: (open: () => void) => void;
  cancelOpen: () => void;
  onSave: (column: MichiDbColumn, value: CellValue, extra?: MichiDbEditOp[]) => void;
  onCancel: (col: string) => void;
}) {
  const thread = threadOf(row.id);
  const title = titleColumn(db);
  const selected = handlers.selected.has(row.id);
  return (
    <tr className="michi-db-row michi-item" {...threadItemProps(row.id, handlers, 'row')}>
      <td className="michi-db-td michi-db-td--check">
        <input
          type="checkbox"
          className="michi-db-check"
          aria-label={`Select ${rowTitle(db, row)}`}
          checked={selected}
          onChange={() => handlers.onItemToggle(row.id)}
          onClick={(event) => event.stopPropagation()}
        />

      </td>
      {columns.map((c) => (
        <Cell
          key={c.id}
          db={db}
          row={row}
          column={c}
          thread={thread}
          now={now}
          isTitle={c.id === title?.id}
          editing={editing === c.id}
          onOpen={() => handlers.onItemOpen(row.id)}
          openLater={openLater}
          cancelOpen={cancelOpen}
          onEdit={() => onEdit(c.id)}
          onSave={(value, extra) => onSave(c, value, extra)}
          onCancel={() => onCancel(c.id)}
          onRefused={notice}
        />
      ))}
      <td className="michi-db-td michi-db-td--fill" />
    </tr>
  );
}

function Cell({
  db,
  row,
  column: c,
  thread,
  now,
  isTitle,
  editing,
  onOpen,
  openLater,
  cancelOpen,
  onEdit,
  onSave,
  onCancel,
  onRefused,
}: {
  db: DbViewProps['db'];
  row: MichiDbRow;
  column: MichiDbColumn;
  thread: ReturnType<DbViewProps['threadOf']>;
  now: number;
  isTitle: boolean;
  editing: boolean;
  onOpen: () => void;
  openLater: (open: () => void) => void;
  cancelOpen: () => void;
  onEdit: () => void;
  onSave: (value: CellValue, extra?: MichiDbEditOp[]) => void;
  onCancel: () => void;
  onRefused: (reason: string) => void;
}) {
  const td = useRef<HTMLTableCellElement>(null);
  const value = cellOf(row, c.id);
  const can = cellEditable(c);
  const live = can && c.type !== 'checkbox';
  const spot = spotKey({ row: row.id, col: c.id });
  return (
    <td ref={td} className="michi-db-td" data-type={c.type} data-editing={editing ? 'true' : undefined}>
      {editing ? (
        <CellEditor db={db} column={c} value={value} row={row} anchor={td.current} onSave={onSave} onCancel={onCancel} onRefused={onRefused} />
      ) : (
        <div
          className="michi-db-cell"
          data-cell={spot}
          data-editable={live ? 'true' : undefined}
          data-title={isTitle ? 'true' : undefined}
          tabIndex={live ? 0 : -1}
          title={isTitle ? rowTitle(db, row) : undefined}
          // A plain click edits a cell, except the title's, which opens the row
          // as any click on the row does, once a double-click (rename) is ruled
          // out; ⌘/Shift-clicks select.
          onClick={live ? (event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.stopPropagation();
            if (!isTitle) {
              onEdit();
              return;
            }
            cancelOpen();
            if (event.detail > 1) return; // a double-click's second click: its dblclick renames
            if (event.detail === 0) {
              onOpen(); // not a mouse click: nothing to wait for
              return;
            }
            openLater(onOpen);
          } : undefined}
          onDoubleClick={live && isTitle ? (event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.stopPropagation();
            cancelOpen();
            onEdit();
          } : undefined}
          onKeyDown={(event) => {
            if (!live || event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' || event.key === 'F2') {
              event.preventDefault();
              event.stopPropagation();
              onEdit();
            }
          }}
        >
          <CellView db={db} column={c} value={value} thread={thread} now={now} onToggle={can ? (on) => onSave(on) : undefined} />
          {isTitle && live && (
            <button
              type="button"
              className="michi-db-open"
              aria-label={`Rename ${rowTitle(db, row)}`}
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Pencil size={11} strokeWidth={1.8} aria-hidden="true" />
              Rename
            </button>
          )}
        </div>
      )}
    </td>
  );
}
