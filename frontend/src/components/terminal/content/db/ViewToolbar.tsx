import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, GripVertical, ListFilter, Rows3, SlidersHorizontal, X } from 'lucide-react';
import type { MichiDatabase, MichiDbColumn, MichiDbFilter, MichiDbFilterOp, MichiDbSort, MichiDbView, MichiDbViewConfig } from 'michi-shared';
import { DbPopover, DbSwitch } from './DbPopover';
import { boardGroupColumn, coverColumn, isActiveFilter, isThreadsDb, NO_VALUE_OPS, OPS_FOR, shownColumns, titleColumn, type CellValue } from './dbModel';
import { columnName, filterChipText, OP_LABEL, optionName, sortLabel } from './dbLabels';
import { toggleColumnOp, viewSave } from './dbOps';
import type { GroupPrefs } from './dbPrefs';
import type { DbEdit } from './views/viewTypes';

const GROUPABLE = new Set<MichiDbColumn['type']>(['select', 'multi', 'app', 'checkbox', 'date', 'number', 'progress', 'text']);

export type ToolbarPanel = 'filter' | 'sort' | 'group' | 'properties';
type Panel = ToolbarPanel;

/** Views that draw a row's columns (All threads' board and gallery draw their own fixed facts). */
function drawsColumns(db: MichiDatabase, view: MichiDbView): boolean {
  if (view.type === 'table' || view.type === 'list') return true;
  return (view.type === 'board' || view.type === 'gallery') && !isThreadsDb(db);
}

/**
 * What the view shows, each part in its own panel: Properties (which
 * columns), Filter (with its count), Sort, Group: <column>. Changes are saved on the view at once (Michi keeps
 * them); how groups read (counts, sums, empty groups) stays on this machine.
 */
export function ViewToolbar({
  db,
  view,
  config,
  edit,
  prefs,
  onPrefs,
  count,
  right,
  openPanel,
  onPanel,
}: {
  db: MichiDatabase;
  view: MichiDbView;
  config: MichiDbViewConfig;
  edit: DbEdit;
  prefs: GroupPrefs;
  onPrefs: (next: GroupPrefs) => void;
  /** Rows the view shows. */
  count: number;
  /** Drawn before the count (All threads' Chatted only switch). */
  right?: React.ReactNode;
  openPanel: Panel | null;
  onPanel: (panel: Panel | null) => void;
}) {
  const buttons = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const save = (next: MichiDbViewConfig, label: string) => { void edit([viewSave(view, next)], label); };
  const active = view.config.filters.filter((f) => isActiveFilter(db.columns, f)).length;
  const group = config.group ? db.columns.find((c) => c.id === config.group) : undefined;
  const sorted = view.config.sorts.filter((s) => db.columns.some((c) => c.id === s.column));
  const unit = isThreadsDb(db) ? 'thread' : 'row';

  const tool = (panel: Panel, icon: React.ReactNode, label: React.ReactNode, on: boolean, name: string) => (
    <button
      ref={(el) => { buttons.current[panel] = el; }}
      type="button"
      className="michi-db-tool"
      data-on={on ? 'true' : undefined}
      aria-haspopup="dialog"
      aria-expanded={openPanel === panel}
      aria-label={name}
      onClick={() => onPanel(openPanel === panel ? null : panel)}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="michi-db-toolbar" role="toolbar" aria-label="View settings">
      {right}
      {drawsColumns(db, view) && tool('properties', <SlidersHorizontal size={13} strokeWidth={1.7} aria-hidden="true" />, 'Properties', !!view.config.visible, 'Properties')}
      {tool('filter', <ListFilter size={13} strokeWidth={1.7} aria-hidden="true" />, <>Filter{active > 0 && <span className="michi-db-tool__count">{active}</span>}</>, active > 0, active ? `Filter, ${active} on` : 'Filter')}
      {tool('sort', <ArrowUpDown size={13} strokeWidth={1.7} aria-hidden="true" />, 'Sort', sorted.length > 0, 'Sort')}
      {tool('group', <Rows3 size={13} strokeWidth={1.7} aria-hidden="true" />, <>{group ? `Group: ${columnName(db, group)}` : 'Group'}</>, !!group, group ? `Group: ${columnName(db, group)}` : 'Group')}
      <span className="michi-db-count michi-db-mono">{count} {unit}{count === 1 ? '' : 's'}</span>

      {openPanel === 'properties' && buttons.current.properties && (
        <DbPopover anchor={buttons.current.properties} label="Properties" align="end" width={260} onClose={() => onPanel(null)}>
          <PropertiesPanel db={db} view={view} edit={edit} />
        </DbPopover>
      )}
      {openPanel === 'filter' && buttons.current.filter && (
        <DbPopover anchor={buttons.current.filter} label="Filter" align="end" width={440} onClose={() => onPanel(null)}>
          <FilterPanel db={db} config={view.config} save={save} />
        </DbPopover>
      )}
      {openPanel === 'sort' && buttons.current.sort && (
        <DbPopover anchor={buttons.current.sort} label="Sort" align="end" width={320} onClose={() => onPanel(null)}>
          <SortPanel db={db} config={view.config} save={save} />
        </DbPopover>
      )}
      {openPanel === 'group' && buttons.current.group && (
        <DbPopover anchor={buttons.current.group} label="Group" align="end" width={260} onClose={() => onPanel(null)}>
          <GroupPanel db={db} view={view} config={config} save={save} prefs={prefs} onPrefs={onPrefs} />
        </DbPopover>
      )}
    </div>
  );
}

/** The view's conditions as removable chips, and Clear. */
export function FilterChips({ db, view, edit }: { db: MichiDatabase; view: MichiDbView; edit: DbEdit }) {
  const filters = view.config.filters;
  const shown = filters.map((f, i) => ({ f, i })).filter(({ f }) => isActiveFilter(db.columns, f));
  if (!shown.length) return null;
  const put = (next: MichiDbFilter[], label: string) => { void edit([viewSave(view, { ...view.config, filters: next })], label); };
  return (
    <div className="michi-db-chips" role="group" aria-label="Filters">
      {shown.map(({ f, i }) => {
        const text = filterChipText(db, db.columns, f);
        return (
          <span key={i} className="michi-db-chip">
            {text}
            <button type="button" className="michi-db-chip__x" aria-label={`Remove filter ${text}`} onClick={() => put(filters.filter((_, j) => j !== i), 'Removed a filter')}>
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
        );
      })}
      <button type="button" className="michi-db-link-btn" onClick={() => put([], 'Cleared the filters')}>Clear</button>
    </div>
  );
}

// ── Properties ───────────────────────────────────────────────────────

/**
 * The columns a view can draw besides its title: a gallery card shows no
 * text column (nor the cover, drawn as its picture), and a board card leaves
 * out the column its lanes are grouped by.
 */
function drawableColumns(db: MichiDatabase, view: MichiDbView): MichiDbColumn[] {
  const title = titleColumn(db)?.id;
  const rest = db.columns.filter((c) => c.id !== title);
  if (view.type === 'gallery') {
    const cover = coverColumn(db, view.config)?.id;
    return rest.filter((c) => c.type !== 'text' && c.id !== cover);
  }
  if (view.type === 'board') {
    const by = boardGroupColumn(db, view.config)?.id;
    return rest.filter((c) => c.id !== by);
  }
  return rest;
}

/** Which columns this view shows; the title always does. */
function PropertiesPanel({ db, view, edit }: { db: MichiDatabase; view: MichiDbView; edit: DbEdit }) {
  const shown = new Set(shownColumns(db, view.config, view.type).map((c) => c.id));
  return (
    <div className="michi-db-panel">
      <span className="michi-db-panel__cap">Properties</span>
      {drawableColumns(db, view).map((c) => (
        <DbSwitch
          key={c.id}
          label={columnName(db, c)}
          checked={shown.has(c.id)}
          onChange={(on) => {
            const ops = toggleColumnOp(db, view, c, on);
            if (ops.length) void edit(ops, `${on ? 'Showed' : 'Hid'} ${columnName(db, c)}`);
          }}
        />
      ))}
    </div>
  );
}

// ── Filter ───────────────────────────────────────────────────────────

/**
 * The conditions being edited. One still waiting for a value (or for an
 * operator that needs none) stays in the panel only: the shared view gets a
 * condition once it means something. A change made elsewhere meanwhile (a
 * chip's ×, an undo) starts the list over from what is saved, keeping the
 * unfinished ones.
 */
function useFilterDrafts(db: MichiDatabase, config: MichiDbViewConfig, save: (c: MichiDbViewConfig, label: string) => void) {
  const complete = (f: MichiDbFilter) => isActiveFilter(db.columns, f);
  const savedKey = JSON.stringify(config.filters);
  const [draft, setDraft] = useState({ key: savedKey, rules: config.filters });
  let rules = draft.rules;
  if (draft.key !== savedKey) {
    rules = [...config.filters, ...draft.rules.filter((f) => !complete(f))];
    setDraft({ key: savedKey, rules });
  }
  const put = (next: MichiDbFilter[], match = config.match) => {
    const kept = next.filter(complete);
    const key = JSON.stringify(kept);
    setDraft({ key, rules: next });
    if (key !== savedKey || match !== config.match) save({ ...config, filters: kept, match }, 'Changed the filters');
  };
  return { rules, put };
}

function FilterPanel({ db, config, save }: { db: MichiDatabase; config: MichiDbViewConfig; save: (c: MichiDbViewConfig, label: string) => void }) {
  const { rules: filters, put } = useFilterDrafts(db, config, save);
  const set = (i: number, f: MichiDbFilter) => put(filters.map((x, j) => (j === i ? f : x)));
  const fresh = (c: MichiDbColumn): MichiDbFilter => ({ column: c.id, op: OPS_FOR[c.type][0] });
  const first = titleColumn(db) ?? db.columns[0];
  return (
    <div className="michi-db-panel">
      <div className="michi-db-panel__head">
        <span className="michi-db-panel__cap">Filter</span>
        <div className="michi-db-seg" role="group" aria-label="Match">
          {(['all', 'any'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={config.match === m} onClick={() => put(filters, m)}>
              {m === 'all' ? 'All of' : 'Any of'}
            </button>
          ))}
        </div>
      </div>
      {!filters.length && <p className="michi-db-panel__empty">No filters</p>}
      {filters.map((f, i) => {
        const c = db.columns.find((x) => x.id === f.column);
        return (
          <div key={i} className="michi-db-rule">
            <select
              className="michi-db-select"
              aria-label={`Filter ${i + 1} column`}
              value={f.column}
              onChange={(event) => {
                const next = db.columns.find((x) => x.id === event.currentTarget.value);
                if (next) set(i, fresh(next));
              }}
            >
              {!c && <option value={f.column}>Removed column</option>}
              {db.columns.map((x) => <option key={x.id} value={x.id}>{columnName(db, x)}</option>)}
            </select>
            {c && (
              <select
                className="michi-db-select"
                aria-label={`Filter ${i + 1} condition`}
                value={f.op}
                onChange={(event) => {
                  const op = event.currentTarget.value as MichiDbFilterOp;
                  set(i, NO_VALUE_OPS.has(op) ? { column: f.column, op } : { ...f, op });
                }}
              >
                {OPS_FOR[c.type].map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
            )}
            {c && !NO_VALUE_OPS.has(f.op) && (
              <ValueInput
                key={`${f.column}\n${f.op}`}
                db={db}
                column={c}
                filter={f}
                label={`Filter ${i + 1} value`}
                onChange={(value) => set(i, value === undefined ? { column: f.column, op: f.op } : { ...f, value })}
              />
            )}
            <button type="button" className="michi-db-icon-btn" aria-label={`Remove filter ${i + 1}`} onClick={() => put(filters.filter((_, j) => j !== i))}>
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {first && (
        <button type="button" className="michi-db-link-btn" onClick={() => put([...filters, fresh(first)])}>+ Add filter</button>
      )}
    </div>
  );
}

/** The value a condition waits for, by column type. Typed text is saved on Enter or leaving the field, not on every key. */
function ValueInput({ db, column: c, filter: f, label, onChange }: { db: MichiDatabase; column: MichiDbColumn; filter: MichiDbFilter; label: string; onChange: (value: CellValue | undefined) => void }) {
  if (c.type === 'select' || c.type === 'multi' || (c.type === 'app' && c.options?.length)) {
    const value = typeof f.value === 'string' ? f.value : Array.isArray(f.value) ? f.value[0] ?? '' : '';
    return (
      <select className="michi-db-select michi-db-rule__value" aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value || undefined)}>
        <option value="">Pick one</option>
        {(c.options ?? []).map((o) => <option key={o.value} value={o.value}>{optionName(db, c, o.value)}</option>)}
      </select>
    );
  }
  if (c.type === 'date') {
    return (
      <input
        type="date"
        className="michi-db-input michi-db-rule__value"
        aria-label={label}
        value={typeof f.value === 'string' ? f.value.slice(0, 10) : ''}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
      />
    );
  }
  if (c.type === 'number' || c.type === 'progress') {
    const pct = c.type === 'progress';
    const start = typeof f.value === 'number' ? String(pct ? Math.round(f.value * 100) : f.value) : '';
    return (
      <Typed
        label={label}
        start={start}
        placeholder={pct ? '%' : 'Value'}
        onCommit={(text) => {
          const n = Number(text);
          onChange(text.trim() === '' || !Number.isFinite(n) ? undefined : pct ? n / 100 : n);
        }}
      />
    );
  }
  return <Typed label={label} start={typeof f.value === 'string' ? f.value : ''} placeholder="Value" onCommit={(text) => onChange(text.trim() ? text : undefined)} />;
}

function Typed({ label, start, placeholder, onCommit }: { label: string; start: string; placeholder: string; onCommit: (text: string) => void }) {
  const [text, setText] = useState(start);
  const sent = useRef(start);
  const latest = useRef(text);
  latest.current = text;
  const commit = () => {
    if (latest.current === sent.current) return;
    sent.current = latest.current;
    onCommit(latest.current);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // The panel closing takes the field away without a blur; what was typed is kept all the same.
  useEffect(() => () => commitRef.current(), []);
  return (
    <input
      className="michi-db-input michi-db-rule__value"
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

// ── Sort ─────────────────────────────────────────────────────────────

function SortPanel({ db, config, save }: { db: MichiDatabase; config: MichiDbViewConfig; save: (c: MichiDbViewConfig, label: string) => void }) {
  const sorts = config.sorts;
  const put = (next: MichiDbSort[]) => save({ ...config, sorts: next }, 'Changed the sort');
  const unused = db.columns.find((c) => !sorts.some((s) => s.column === c.id));
  const dragFrom = useRef<number | null>(null);
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = sorts.slice();
    const [s] = next.splice(from, 1);
    next.splice(to, 0, s);
    put(next);
  };
  return (
    <div className="michi-db-panel">
      <span className="michi-db-panel__cap">Sort</span>
      {!sorts.length && <p className="michi-db-panel__empty">In the order rows were added</p>}
      {sorts.map((s, i) => {
        const c = db.columns.find((x) => x.id === s.column);
        return (
          <div
            key={`${s.column}\n${i}`}
            className="michi-db-rule"
            draggable
            onDragStart={() => { dragFrom.current = i; }}
            onDragOver={(event) => { if (dragFrom.current !== null) event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              const from = dragFrom.current;
              dragFrom.current = null;
              if (from !== null) move(from, i);
            }}
          >
            <span
              className="michi-db-grip"
              role="button"
              tabIndex={0}
              aria-label={`Move sort ${i + 1}`}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' && i > 0) { event.preventDefault(); move(i, i - 1); }
                if (event.key === 'ArrowDown' && i < sorts.length - 1) { event.preventDefault(); move(i, i + 1); }
              }}
            >
              <GripVertical size={13} strokeWidth={1.7} aria-hidden="true" />
            </span>
            <select
              className="michi-db-select michi-db-rule__grow"
              aria-label={`Sort ${i + 1} column`}
              value={s.column}
              onChange={(event) => put(sorts.map((x, j) => (j === i ? { ...x, column: event.currentTarget.value } : x)))}
            >
              {db.columns.map((x) => <option key={x.id} value={x.id}>{columnName(db, x)}</option>)}
            </select>
            {c && (
              <select
                className="michi-db-select"
                aria-label={`Sort ${i + 1} direction`}
                value={s.dir}
                onChange={(event) => put(sorts.map((x, j) => (j === i ? { ...x, dir: event.currentTarget.value === 'desc' ? 'desc' : 'asc' } : x)))}
              >
                <option value="asc">{sortLabel(db, c, 'asc')}</option>
                <option value="desc">{sortLabel(db, c, 'desc')}</option>
              </select>
            )}
            <button type="button" className="michi-db-icon-btn" aria-label={`Remove sort ${i + 1}`} onClick={() => put(sorts.filter((_, j) => j !== i))}>
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {unused && <button type="button" className="michi-db-link-btn" onClick={() => put([...sorts, { column: unused.id, dir: 'asc' }])}>+ Add sort</button>}
    </div>
  );
}

// ── Group ────────────────────────────────────────────────────────────

function GroupPanel({
  db,
  view,
  config,
  save,
  prefs,
  onPrefs,
}: {
  db: MichiDatabase;
  view: MichiDbView;
  config: MichiDbViewConfig;
  save: (c: MichiDbViewConfig, label: string) => void;
  prefs: GroupPrefs;
  onPrefs: (next: GroupPrefs) => void;
}) {
  const options = db.columns.filter((c) => GROUPABLE.has(c.type));
  const numbers = db.columns.filter((c) => c.type === 'number' || c.type === 'progress');
  // A board always splits by something; "None" only for the other views.
  const value = config.group && db.columns.some((c) => c.id === config.group) ? config.group : '';
  return (
    <div className="michi-db-panel">
      <span className="michi-db-panel__cap">Group</span>
      <select
        className="michi-db-select"
        aria-label="Group by"
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const { group: _drop, ...rest } = view.config;
          save(next ? { ...rest, group: next } : rest, 'Changed the grouping');
        }}
      >
        {view.type !== 'board' && <option value="">None</option>}
        {options.map((c) => <option key={c.id} value={c.id}>{columnName(db, c)}</option>)}
      </select>
      <DbSwitch label="Show counts" checked={prefs.showCounts} onChange={(on) => onPrefs({ ...prefs, showCounts: on })} />
      {numbers.map((c) => (
        <DbSwitch
          key={c.id}
          label={`${c.type === 'progress' ? 'Average of' : 'Sum of'} ${columnName(db, c)}`}
          checked={prefs.sums.includes(c.id)}
          onChange={(on) => onPrefs({ ...prefs, sums: on ? [...prefs.sums, c.id] : prefs.sums.filter((x) => x !== c.id) })}
        />
      ))}
      <DbSwitch label="Hide empty groups" checked={prefs.hideEmpty} onChange={(on) => onPrefs({ ...prefs, hideEmpty: on })} />
    </div>
  );
}
