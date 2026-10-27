import React, { useState } from 'react';
import type { MichiDatabase, MichiDbColumn, MichiDbEditOp, MichiDbRow } from 'michi-shared';
import { DbPopover } from './DbPopover';
import { cellEditable, isThreadsDb, writableOptions, type CellValue } from './dbModel';
import { columnName, optionName } from './dbLabels';
import { setColumnOps } from './dbOps';
import type { DbEdit } from './views/viewTypes';
import { useBatchBarPresence } from '../threads/batchBarPresence';
import '../threads/threads.css';

/** All threads' rows get one value at a time only for these; a title is each thread's own. */
const THREADS_BATCH_COLUMNS = new Set(['state', 'next']);

/** The columns "Set …" can give every picked row: on All threads only Status and Next, elsewhere any a person can change. */
export function batchColumns(db: MichiDatabase): MichiDbColumn[] {
  // A Conversations cell is linked one conversation at a time, from the task's details.
  const editable = db.columns.filter((c) => cellEditable(c) && c.type !== 'threads');
  return isThreadsDb(db) ? editable.filter((c) => c.builtin && THREADS_BATCH_COLUMNS.has(c.id)) : editable;
}

/** The column "Set …" starts on: the view's grouping when it can change, else the first select a person can set, else the first one it can set. */
export function defaultSetColumn(db: MichiDatabase, group: MichiDbColumn | undefined): MichiDbColumn | undefined {
  const editable = batchColumns(db);
  if (group && editable.includes(group)) return group;
  return editable.find((c) => c.type === 'select' && !c.builtin) ?? editable.find((c) => c.type === 'select') ?? editable[0];
}

export interface BatchAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Michi's inverted selection bar for picked rows: the count, then only what
 * the selection can do. `Set <column>…` gives every picked row one value in a
 * single edit.
 */
export function RowsBatchBar({
  db,
  rows,
  unit,
  group,
  edit,
  notice,
  before,
  after,
  onClear,
}: {
  db: MichiDatabase;
  rows: MichiDbRow[];
  /** `thread` on All threads, `row` elsewhere. */
  unit: string;
  group?: MichiDbColumn;
  edit: DbEdit;
  notice: (text: string) => void;
  /** Actions before Set… (All threads: Archive, Ignore). */
  before?: BatchAction[];
  /** Actions after Set… (Delete, Hand to agent…, Copy). */
  after?: BatchAction[];
  onClear: () => void;
}) {
  useBatchBarPresence();
  const count = rows.length;
  const label = `${count} ${unit}${count === 1 ? '' : 's'}`;
  const setColumn = defaultSetColumn(db, group);
  const [setting, setSetting] = useState<HTMLElement | null>(null);
  return (
    <div role="toolbar" aria-label={`${label} selected`} className="michi-batch michi-db-batch">
      <span className="michi-batch__count">{label}</span>
      <span className="michi-batch__sep" aria-hidden="true" />
      {before?.map((a) => <BatchButton key={a.label} action={a} />)}
      {setColumn && (
        <button
          type="button"
          className="michi-batch__btn"
          aria-haspopup="dialog"
          aria-expanded={setting != null}
          onClick={(event) => { const el = event.currentTarget; setSetting((open) => (open ? null : el)); }}
        >
          Set {columnName(db, setColumn)}…
        </button>
      )}
      {after?.map((a) => <BatchButton key={a.label} action={a} />)}
      <button type="button" className="michi-batch__btn michi-batch__close" aria-label="Clear selection" onClick={onClear}>×</button>
      {setting && setColumn && (
        <DbPopover anchor={setting} label={`Set a value on ${label}`} width={280} onClose={() => setSetting(null)}>
          <SetValueForm
            db={db}
            rows={rows}
            start={setColumn}
            unit={unit}
            onDone={(ops, column) => {
              setSetting(null);
              void edit(ops, `Set ${columnName(db, column)} on ${label}`);
            }}
            onRefused={notice}
          />
        </DbPopover>
      )}
    </div>
  );
}

function BatchButton({ action }: { action: BatchAction }) {
  return (
    <button type="button" className="michi-batch__btn" data-danger={action.danger ? 'true' : undefined} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

const picks = (c: MichiDbColumn) => c.type === 'select' || c.type === 'multi' || (c.type === 'app' && !!c.options?.length);

/** Choose a column (any a person can set), then its value; one edit for every picked row. */
function SetValueForm({
  db,
  rows,
  start,
  unit,
  onDone,
  onRefused,
}: {
  db: MichiDatabase;
  rows: MichiDbRow[];
  start: MichiDbColumn;
  unit: string;
  onDone: (ops: MichiDbEditOp[], column: MichiDbColumn) => void;
  onRefused: (reason: string) => void;
}) {
  const columns = batchColumns(db);
  const [columnId, setColumnId] = useState(start.id);
  const column = columns.find((c) => c.id === columnId) ?? start;
  const allowed = writableOptions(db, column);
  const firstOption = (c: MichiDbColumn) => {
    const ok = writableOptions(db, c);
    return c.options?.find((o) => !ok || ok.has(o.value))?.value ?? '';
  };
  const [raw, setRaw] = useState<string>(() => (column.type === 'checkbox' ? 'true' : picks(column) && allowed ? firstOption(column) : ''));

  const valueOf = (): CellValue => {
    if (raw === '') return null;
    switch (column.type) {
      case 'checkbox': return raw === 'true';
      case 'multi': return [raw];
      case 'progress': return Number(raw) / 100;
      case 'number': return Number(raw);
      case 'date': return { start: raw };
      default: return raw;
    }
  };
  const apply = () => {
    const check = setColumnOps(db, rows, column, valueOf());
    if (!check.ok) {
      onRefused(check.reason);
      return;
    }
    onDone(check.ops, column);
  };
  return (
    <form className="michi-db-form" onSubmit={(event) => { event.preventDefault(); apply(); }}>
      {columns.length > 1 && (
        <label className="michi-db-form__row">
          <span>Column</span>
          <select
            data-autofocus
            className="michi-db-select"
            value={column.id}
            onChange={(event) => {
              const next = columns.find((c) => c.id === event.currentTarget.value);
              if (!next) return;
              setColumnId(next.id);
              setRaw(next.type === 'checkbox' ? 'true' : picks(next) && writableOptions(db, next) ? firstOption(next) : '');
            }}
          >
            {columns.map((c) => <option key={c.id} value={c.id}>{columnName(db, c)}</option>)}
          </select>
        </label>
      )}
      <label className="michi-db-form__row">
        <span>Set to</span>
        {picks(column) ? (
          <select className="michi-db-select" value={raw} onChange={(event) => setRaw(event.currentTarget.value)}>
            {!allowed && <option value="">Empty</option>}
            {(column.options ?? []).filter((o) => !allowed || allowed.has(o.value)).map((o) => (
              <option key={o.value} value={o.value}>{optionName(db, column, o.value)}</option>
            ))}
          </select>
        ) : column.type === 'checkbox' ? (
          <select className="michi-db-select" value={raw} onChange={(event) => setRaw(event.currentTarget.value)}>
            <option value="true">Checked</option>
            <option value="false">Not checked</option>
          </select>
        ) : (
          <input
            className="michi-db-input"
            type={column.type === 'date' ? 'date' : column.type === 'number' || column.type === 'progress' ? 'number' : 'text'}
            placeholder={column.type === 'progress' ? '%' : 'Empty clears it'}
            value={raw}
            onChange={(event) => setRaw(event.currentTarget.value)}
          />
        )}
      </label>
      <div className="michi-db-form__actions">
        <button type="submit" className="michi-db-btn michi-db-btn--primary">
          Set on {rows.length} {unit}{rows.length === 1 ? '' : 's'}
        </button>
      </div>
    </form>
  );
}
