import React, { useRef, useState } from 'react';
import {
  AppWindow, ArrowDownUp, CalendarDays, Check, ChevronRight, CircleChevronDown, Clock, EyeOff, Folder, Gauge, Hash, Image, Link,
  ListFilter, MessagesSquare, Plus, SquareCheck, Tags, Trash2, Type, type LucideIcon,
} from 'lucide-react';
import { isTaskCoreColumn, type MichiDatabase, type MichiDbColumn, type MichiDbColumnType, type MichiDbView } from 'michi-shared';
import { DbMenuItem, DbPopover } from './DbPopover';
import { titleColumn } from './dbModel';
import { COLUMN_TYPE_LABEL, COLUMN_TYPE_ORDER, columnName, sortLabel } from './dbLabels';
import {
  addColumnOps,
  columnTypeOp,
  deleteColumnOp,
  filterByColumnOp,
  hideColumnOp,
  renameColumnOp,
  sortByColumnOp,
} from './dbOps';
import type { DbEdit } from './views/viewTypes';

export const TYPE_ICON: Record<MichiDbColumnType, LucideIcon> = {
  text: Type,
  number: Hash,
  date: CalendarDays,
  select: CircleChevronDown,
  multi: Tags,
  checkbox: SquareCheck,
  url: Link,
  progress: Gauge,
  app: AppWindow,
  image: Image,
  threads: MessagesSquare,
};

/** All threads' built-ins read by what they are, not their storage type. */
export function columnIcon(db: Pick<MichiDatabase, 'id' | 'kind'>, column: MichiDbColumn): LucideIcon {
  if (column.builtin && column.id === 'project') return Folder;
  if (column.builtin && column.id === 'lastActivity') return Clock;
  return TYPE_ICON[column.type];
}

const icon = (Icon: LucideIcon) => <Icon size={14} strokeWidth={1.7} />;

/**
 * A column's menu (header click): rename at the top, then Type ▸, sort both
 * ways, filter by it, hide it in this view, delete it. Built-in thread columns
 * can only be sorted, filtered and hidden; a task database's core columns can
 * be renamed too, but keep their type and stay; the title is never hidden.
 */
export function ColumnMenu({
  db,
  view,
  column,
  anchor,
  edit,
  onClose,
  onFilter,
}: {
  db: MichiDatabase;
  view: MichiDbView;
  column: MichiDbColumn;
  anchor: HTMLElement;
  edit: DbEdit;
  onClose: () => void;
  /** After "Filter by": open the filter panel on the new condition. */
  onFilter?: () => void;
}) {
  const own = !column.builtin;
  // A task database keeps its core columns and their types; their names can change.
  const core = isTaskCoreColumn(db, column);
  const isTitle = titleColumn(db)?.id === column.id;
  const name = columnName(db, column);
  const [draft, setDraft] = useState(name);
  const [typeMenu, setTypeMenu] = useState<HTMLElement | null>(null);
  const sent = useRef(false);

  const rename = () => {
    if (sent.current) return;
    const ops = renameColumnOp(column, draft);
    if (!ops.length) return;
    sent.current = true;
    void edit(ops, 'Renamed column');
  };
  const run = (fn: () => void) => {
    rename();
    onClose();
    fn();
  };

  return (
    <DbPopover anchor={anchor} label={`${name} column`} role="menu" width={240} onClose={() => { rename(); onClose(); }}>
      {own ? (
        <div className="michi-db-pop__field">
          <input
            data-autofocus
            className="michi-db-input"
            aria-label="Column name"
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                run(() => {});
              }
            }}
          />
        </div>
      ) : (
        <div className="michi-db-pop__caption">{name}</div>
      )}
      {own && !core && (
        <DbMenuItem
          icon={icon(TYPE_ICON[column.type])}
          label="Type"
          hint={<>{COLUMN_TYPE_LABEL[column.type]}<ChevronRight size={12} strokeWidth={1.8} /></>}
          onSelect={(item) => setTypeMenu((open) => (open ? null : item))}
        />
      )}
      <DbMenuItem icon={icon(ArrowDownUp)} label={`Sort ${sortLabel(db, column, 'asc')}`} onSelect={() => run(() => { void edit([sortByColumnOp(view, column, 'asc')], 'Sorted the view'); })} />
      <DbMenuItem icon={icon(ArrowDownUp)} label={`Sort ${sortLabel(db, column, 'desc')}`} onSelect={() => run(() => { void edit([sortByColumnOp(view, column, 'desc')], 'Sorted the view'); })} />
      <DbMenuItem
        icon={icon(ListFilter)}
        label={`Filter by ${name}`}
        onSelect={() => run(() => { void edit([filterByColumnOp(view, column)], 'Added a filter'); onFilter?.(); })}
      />
      {!isTitle && (
        <DbMenuItem icon={icon(EyeOff)} label="Hide in this view" onSelect={() => run(() => { void edit(hideColumnOp(db, view, column), `Hid ${name}`); })} />
      )}
      {own && !core && (
        <>
          <div className="michi-db-pop__sep" role="separator" />
          <DbMenuItem icon={icon(Trash2)} label="Delete column" danger onSelect={() => run(() => { void edit(deleteColumnOp(column), `Deleted column ${name}`); })} />
        </>
      )}
      {typeMenu && (
        <TypeMenu
          anchor={typeMenu}
          current={column.type}
          onClose={() => setTypeMenu(null)}
          onPick={(type) => {
            setTypeMenu(null);
            run(() => {
              const ops = columnTypeOp(column, type);
              if (ops.length) void edit(ops, `Changed ${name} to ${COLUMN_TYPE_LABEL[type]}`);
            });
          }}
        />
      )}
    </DbPopover>
  );
}

function TypeMenu({ anchor, current, onPick, onClose }: { anchor: HTMLElement; current: MichiDbColumnType; onPick: (t: MichiDbColumnType) => void; onClose: () => void }) {
  return (
    <DbPopover anchor={anchor} label="Column type" role="menu" width={200} onClose={onClose}>
      <div className="michi-db-pop__caption">Type</div>
      {COLUMN_TYPE_ORDER.map((t) => (
        <DbMenuItem
          key={t}
          icon={icon(TYPE_ICON[t])}
          label={COLUMN_TYPE_LABEL[t]}
          checked={t === current}
          hint={t === current ? <Check size={13} strokeWidth={2} /> : undefined}
          onSelect={() => onPick(t)}
        />
      ))}
    </DbPopover>
  );
}

/** The `+` at the end of the header: a name and a type; the column goes in after the last one shown. */
export function AddColumnButton({ db, view, edit }: { db: MichiDatabase; view: MichiDbView; edit: DbEdit }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<MichiDbColumnType>('text');
  const close = () => {
    setAnchor(null);
    setName('');
    setType('text');
  };
  const add = () => {
    const { ops } = addColumnOps(db, view, name, type);
    close();
    void edit(ops, 'Added a column');
  };
  return (
    <>
      <button
        type="button"
        className="michi-db-icon-btn"
        aria-label="Add column"
        aria-expanded={anchor != null}
        onClick={(event) => {
          event.stopPropagation();
          const el = event.currentTarget;
          setAnchor((open) => (open ? null : el));
        }}
      >
        <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {anchor && (
        <DbPopover anchor={anchor} label="Add column" width={260} align="end" onClose={close}>
          <form className="michi-db-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
            <input
              data-autofocus
              className="michi-db-input"
              aria-label="Column name"
              placeholder={COLUMN_TYPE_LABEL[type]}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <div className="michi-db-types" role="group" aria-label="Type">
              {COLUMN_TYPE_ORDER.map((t) => {
                const T = TYPE_ICON[t];
                return (
                  <button key={t} type="button" className="michi-db-type" aria-pressed={type === t} onClick={() => setType(t)}>
                    <T size={13} strokeWidth={1.7} aria-hidden="true" />
                    {COLUMN_TYPE_LABEL[t]}
                  </button>
                );
              })}
            </div>
            <div className="michi-db-form__actions">
              <button type="submit" className="michi-db-btn michi-db-btn--primary">Add</button>
            </div>
          </form>
        </DbPopover>
      )}
    </>
  );
}
