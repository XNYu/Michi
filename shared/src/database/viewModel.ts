import {
  MICHI_DB_FILTER_OPS,
  MICHI_THREADS_DB,
  MICHI_THREAD_WRITABLE_STATES,
  type MichiDatabase,
  type MichiDbCellValue,
  type MichiDbColumn,
  type MichiDbColumnOption,
  type MichiDbColumnType,
  type MichiDbDateValue,
  type MichiDbFilter,
  type MichiDbFilterOp,
  type MichiDbRow,
  type MichiDbView,
  type MichiDbViewConfig,
} from '../databaseModel';

// Browser-safe database filtering, sorting and grouping shared by Michi
// views and native assistant reads. This module has no UI or service dependency.

export type CellValue = MichiDbCellValue;
/** A conversation a Conversations cell links, as it stands now: whether it waits on the person, and its title. */
export type ConversationLookup = (nodeId: string) => { waiting: boolean; title: string } | undefined;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LIST_MAX = 50;
const STR_MAX = 2000;
const ID_MAX = 200;

export function isDateValue(v: unknown): v is MichiDbDateValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { start?: unknown }).start === 'string';
}

export function isBlank(v: CellValue | undefined): boolean {
  return v == null
    || (typeof v === 'string' && v.trim() === '')
    || (Array.isArray(v) && v.length === 0)
    || (isDateValue(v) && !v.start.trim());
}

export function cellOf(row: MichiDbRow, id: string): CellValue {
  return Object.prototype.hasOwnProperty.call(row.values, id) ? row.values[id] : null;
}

const num = (v: CellValue | undefined) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const startOf = (v: CellValue | undefined) => (isDateValue(v) ? v.start : typeof v === 'string' ? v : null);
const pad2 = (n: number) => String(n).padStart(2, '0');

export const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function dayTime(s: string): number {
  const m = DAY.exec(s);
  if (!m) return NaN;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return localDay(d) === s ? d.getTime() : NaN;
}

export const timeOf = (s: string) => (DAY.test(s) ? dayTime(s) : Date.parse(s));

/** The local day a date string falls on, `YYYY-MM-DD`; null when it is no date. */
export function dayOf(s: string): string | null {
  if (DAY.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : localDay(new Date(t));
}

/** A plain day on either side compares by day, so "after Oct 17" does not take Oct 17 09:00. */
function dateCmp(v: CellValue | undefined, t: CellValue | undefined): number {
  const a = startOf(v);
  const b = startOf(t);
  if (!a || !b) return NaN;
  if (DAY.test(a) || DAY.test(b)) {
    const x = dayOf(a);
    const y = dayOf(b);
    return x && y ? (x < y ? -1 : x > y ? 1 : 0) : NaN;
  }
  return timeOf(a) - timeOf(b);
}

function findOption(options: MichiDbColumnOption[] | undefined, raw: string): MichiDbColumnOption | undefined {
  const s = raw.trim();
  const l = s.toLowerCase();
  const list = options ?? [];
  return list.find((o) => o.value === s)
    ?? list.find((o) => o.label === s)
    ?? list.find((o) => o.value.toLowerCase() === l || o.label?.toLowerCase() === l);
}

const clip = (s: string, n = STR_MAX) => (s.length > n ? s.slice(0, n).replace(/[\ud800-\udbff]$/, '') : s);

function plain(v: CellValue | undefined): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (isDateValue(v)) return v.end ? `${v.start} → ${v.end}` : v.start;
  return String(v);
}

/** The option's label as Michi stores it (value when it has none). Display names go through dbLabels. */
export function optionLabel(column: MichiDbColumn, value: string): string {
  return column.options?.find((o) => o.value === value)?.label ?? value;
}

/** A cell as plain text, for copying and handing to the assistant: option labels, progress as a percentage, a range as `start → end`. */
export function cellText(column: MichiDbColumn, value: CellValue | undefined, label: (column: MichiDbColumn, value: string) => string = optionLabel): string {
  if (value == null) return '';
  if (column.type === 'progress' && typeof value === 'number') return `${Math.round(value * 100)}%`;
  if (typeof value === 'string') return column.type === 'select' || column.type === 'multi' || column.type === 'app' ? label(column, value) : value;
  if (Array.isArray(value)) return value.map((v) => label(column, v)).join(', ');
  return plain(value);
}

const YES = new Set(['true', 'yes', 'y', '1', '✓', 'checked']);
const NO = new Set(['false', 'no', 'n', '0', 'unchecked']);
const FAIL = { value: null, ok: false } as const;

function httpUrl(raw: string, httpsOnly: boolean): string | null {
  // A bare domain is what people paste; anything else without a scheme is not a link.
  const s = /^[a-z][a-z\d+.-]*:/i.test(raw) || !/^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(raw) ? raw : `https://${raw}`;
  try {
    const p = new URL(s).protocol;
    return p === 'https:' || (!httpsOnly && p === 'http:') ? clip(s) : null;
  } catch {
    return null;
  }
}

function normDate(raw: string): string | null {
  const s = raw.trim();
  if (DAY.test(s)) return Number.isNaN(dayTime(s)) ? null : s;
  // Date.parse alone reads "5" as May 2001, so a four-digit year is required.
  if (!/\d{4}/.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return /\d:\d\d/.test(s) ? new Date(t).toISOString() : localDay(new Date(t));
}

/** Turns a value into what a column of type `to` holds. Empty is always fine (null); what cannot be kept is {value: null, ok: false}. */
export function convertValue(value: CellValue, to: MichiDbColumnType, options?: MichiDbColumnOption[]): { value: CellValue; ok: boolean } {
  if (isBlank(value)) return { value: null, ok: true };
  const done = (v: CellValue | undefined) => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? FAIL : { value: v, ok: true });
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : null;
  switch (to) {
    case 'text': return done(clip(plain(value)));
    case 'number': return done(typeof value === 'boolean' ? Number(value) : s === null ? NaN : Number(s));
    case 'progress': {
      const n = s === null ? NaN : s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
      return Number.isFinite(n) ? done(Math.min(1, Math.max(0, n))) : FAIL;
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return done(value);
      if (typeof value === 'number') return done(value !== 0);
      const l = s?.toLowerCase() ?? '';
      return YES.has(l) ? done(true) : NO.has(l) ? done(false) : FAIL;
    }
    case 'date': {
      const parts = isDateValue(value) ? [value.start, value.end] : typeof value === 'string' ? value.split('→') : [];
      if (!parts.length || parts.length > 2) return FAIL;
      const start = normDate(parts[0]!);
      const end = parts[1] === undefined || parts[1].trim() === '' ? undefined : normDate(parts[1]);
      if (!start || end === null) return FAIL;
      return done(end === undefined ? { start } : timeOf(end) < timeOf(start) ? { start: end, end: start } : { start, end });
    }
    case 'select':
      return done((Array.isArray(value) ? value.map((x) => findOption(options, x)).find(Boolean) : s === null ? undefined : findOption(options, s))?.value);
    case 'multi': {
      const parts = Array.isArray(value) ? value : s === null ? [] : findOption(options, s) ? [s] : s.split(/[,，、]/);
      const out = [...new Set(parts.flatMap((p) => {
        const o = findOption(options, p);
        return o ? [o.value] : [];
      }))].slice(0, LIST_MAX);
      return done(out.length ? out : null);
    }
    case 'url': return done(s === null ? null : httpUrl(s, false));
    case 'image': return done(s === null ? null : httpUrl(s, true));
    case 'app': return done(s === null ? null : clip(findOption(options, s)?.value ?? s, ID_MAX));
    case 'threads': {
      if (!Array.isArray(value)) return FAIL;
      const ids = [...new Set(value.map((id) => id.trim()).filter(Boolean))].slice(0, LIST_MAX);
      return done(ids.length ? ids : null);
    }
  }
}

// ── Filters ──────────────────────────────────────────────────────────

/** Operators that take no value. */
export const NO_VALUE_OPS: ReadonlySet<MichiDbFilterOp> = new Set(['empty', 'not-empty', 'checked', 'unchecked', 'waiting']);

/** The conditions that make sense for each type, most useful first. */
export const OPS_FOR: Record<MichiDbColumnType, MichiDbFilterOp[]> = {
  text: ['contains', 'not-contains', 'is', 'is-not', 'empty', 'not-empty'],
  url: ['contains', 'not-contains', 'empty', 'not-empty'],
  image: ['empty', 'not-empty'],
  app: ['is', 'is-not', 'empty', 'not-empty'],
  number: ['is', 'is-not', 'gt', 'lt', 'empty', 'not-empty'],
  progress: ['gt', 'lt', 'is', 'empty', 'not-empty'],
  date: ['is', 'before', 'after', 'empty', 'not-empty'],
  select: ['is', 'is-not', 'empty', 'not-empty'],
  multi: ['contains', 'not-contains', 'empty', 'not-empty'],
  checkbox: ['checked', 'unchecked'],
  threads: ['waiting', 'contains', 'not-contains', 'empty', 'not-empty'],
};

const optValue = (c: MichiDbColumn, v: CellValue | undefined) => {
  const s = plain(v).trim();
  return findOption(c.options, s)?.value ?? s;
};

export const isThreadsDb = (db: Pick<MichiDatabase, 'id' | 'kind'>) => db.kind === 'threads' || db.id === MICHI_THREADS_DB;

/**
 * All threads' columns that hold an agent's one-liner (where the thread
 * stopped, what is next), often copied from its Markdown answer: read as
 * plain words, as Home and the board show them. Editing keeps the value as written.
 */
export const isAgentOneLiner = (db: Pick<MichiDatabase, 'id' | 'kind'>, c: MichiDbColumn) =>
  isThreadsDb(db) && !!c.builtin && (c.id === 'stoppedAt' || c.id === 'next');

function eq(c: MichiDbColumn, v: CellValue, t: CellValue | undefined): boolean {
  switch (c.type) {
    case 'checkbox': return (v === true) === (convertValue(t ?? null, 'checkbox').value === true);
    case 'multi': {
      const want = (Array.isArray(t) ? t : [t]).map((x) => optValue(c, x));
      return Array.isArray(v) && want.every((w) => v.includes(w));
    }
    case 'number':
    case 'progress': return num(v) === num(t);
    case 'date': return dateCmp(v, t) === 0;
    case 'select':
    case 'app': return !isBlank(v) && plain(v) === optValue(c, t);
    default: return !isBlank(v) && plain(v) === plain(t);
  }
}

/** `oneLiner`: an agent's one-liner, matched by the words it shows (isAgentOneLiner). `conversation`: linked conversations as they stand now. */
function matches(c: MichiDbColumn, f: MichiDbFilter, v: CellValue, oneLiner = false, oneLineText: (value: string) => string = (value) => value, conversation?: ConversationLookup): boolean {
  const t = f.value;
  switch (f.op) {
    case 'is': return eq(c, v, t);
    case 'is-not': return !eq(c, v, t);
    case 'contains':
    case 'not-contains': {
      const needle = plain(t).trim().toLowerCase();
      const hit = c.type === 'multi' ? eq(c, v, t)
        : c.type === 'threads' ? Array.isArray(v) && v.some((id) => id.toLowerCase() === needle || (conversation?.(id)?.title.toLowerCase().includes(needle) ?? false))
        : !isBlank(v) && (oneLiner ? [oneLineText(plain(v))] : [plain(v), cellText(c, v)]).some((x) => x.toLowerCase().includes(needle));
      return f.op === 'contains' ? hit : !hit;
    }
    case 'empty': return c.type === 'checkbox' ? v !== true : isBlank(v);
    case 'not-empty': return c.type === 'checkbox' ? v === true : !isBlank(v);
    case 'gt':
    case 'lt': {
      const d = c.type === 'date' ? dateCmp(v, t) : num(v) - num(t);
      return f.op === 'gt' ? d > 0 : d < 0;
    }
    case 'before': return dateCmp(v, t) < 0;
    case 'after': return dateCmp(v, t) > 0;
    case 'checked': return v === true;
    case 'unchecked': return v !== true;
    case 'waiting': return c.type === 'threads' && Array.isArray(v) && v.some((id) => conversation?.(id)?.waiting === true);
  }
}

/** A filter that counts: on a column that is there, with a value unless its operator needs none; `waiting` only counts on a threads column. */
export function isActiveFilter(columns: readonly MichiDbColumn[], f: MichiDbFilter): boolean {
  const column = columns.find((c) => c.id === f.column);
  return !!column && (f.op !== 'waiting' || column.type === 'threads') && MICHI_DB_FILTER_OPS.includes(f.op) && (NO_VALUE_OPS.has(f.op) || !isBlank(f.value));
}

// ── Sorting ──────────────────────────────────────────────────────────

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Orders two non-empty cells of a column. Values of the wrong type sort after
 * the right ones. An agent's one-liner (`oneLiner`) sorts by the words it shows.
 */
function comparator(c: MichiDbColumn, oneLiner = false, oneLineText: (value: string) => string = (value) => value): (a: CellValue, b: CellValue) => number {
  if (oneLiner) {
    const shown = new Map<string, string>();
    const words = (v: CellValue) => {
      const s = plain(v);
      let w = shown.get(s);
      if (w === undefined) shown.set(s, (w = oneLineText(s)));
      return w;
    };
    return (a, b) => collator.compare(words(a), words(b));
  }
  const text = (a: CellValue, b: CellValue) => collator.compare(cellText(c, a), cellText(c, b));
  const finite = (x: number, y: number, a: CellValue, b: CellValue) =>
    Number.isFinite(x) && Number.isFinite(y) ? x - y : Number.isFinite(x) ? -1 : Number.isFinite(y) ? 1 : text(a, b);
  switch (c.type) {
    case 'number':
    case 'progress': return (a, b) => finite(num(a), num(b), a, b);
    case 'date': return (a, b) => {
      const x = startOf(a);
      const y = startOf(b);
      return finite(x ? timeOf(x) : NaN, y ? timeOf(y) : NaN, a, b);
    };
    case 'checkbox': return (a, b) => Number(a === true) - Number(b === true);
    case 'select':
    case 'multi':
    case 'app': {
      const rank = new Map((c.options ?? []).map((o, i) => [o.value, i]));
      const r = (v: CellValue) => rank.get(Array.isArray(v) ? v[0] : plain(v)) ?? Infinity;
      return (a, b) => {
        const x = r(a);
        const y = r(b);
        return x === y ? text(a, b) : x < y ? -1 : 1;
      };
    }
    default: return text;
  }
}

export const byPosition = (a: { id: string; position: number }, b: { id: string; position: number }) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ── Grouping ─────────────────────────────────────────────────────────

/**
 * `key` is what dropping a card on the group writes back as the cell: the
 * option value, 'true'/'false' for a checkbox, null for an empty cell. An
 * ungrouped view is one group with key null.
 */
export interface DbGroup {
  key: string | null;
  label: string;
  rows: MichiDbRow[];
  count: number;
  /** Number and progress columns summed over the group's rows. */
  sums: Record<string, number>;
}

function keysOf(c: MichiDbColumn, v: CellValue): string[] {
  if (isBlank(v)) return [];
  if (Array.isArray(v)) return [...new Set(v)];
  if (c.type === 'date') {
    const s = startOf(v)!;
    return [dayOf(s) ?? s];
  }
  if (c.type === 'number' || c.type === 'progress') {
    const n = num(v);
    return [Number.isFinite(n) ? String(n) : plain(v)];
  }
  return [plain(v)];
}

/** Option-backed groups are all there, empty or not, so a board always has a column to drop into. Other values follow, then empty. */
function group(c: MichiDbColumn | undefined, rows: MichiDbRow[], sumCols: MichiDbColumn[]): DbGroup[] {
  const mk = (key: string | null, label: string, rs: MichiDbRow[]): DbGroup => ({
    key,
    label,
    rows: rs,
    count: rs.length,
    sums: Object.fromEntries(sumCols.map((s) => [s.id, rs.reduce((t, r) => {
      const n = num(cellOf(r, s.id));
      return Number.isFinite(n) ? t + n : t;
    }, 0)])),
  });
  if (!c) return [mk(null, '', rows)];
  if (c.type === 'checkbox') {
    return [mk('true', 'Yes', rows.filter((r) => cellOf(r, c.id) === true)), mk('false', 'No', rows.filter((r) => cellOf(r, c.id) !== true))];
  }
  const buckets = new Map<string, MichiDbRow[]>();
  const empty: MichiDbRow[] = [];
  for (const r of rows) {
    const keys = keysOf(c, cellOf(r, c.id));
    if (!keys.length) empty.push(r);
    for (const k of keys) {
      const b = buckets.get(k);
      if (b) b.push(r);
      else buckets.set(k, [r]);
    }
  }
  const opts = c.type === 'select' || c.type === 'multi' || c.type === 'app' ? c.options ?? [] : [];
  const known = new Set(opts.map((o) => o.value));
  const order = c.type === 'number' || c.type === 'progress'
    ? (a: string, b: string) => Number(a) - Number(b) || collator.compare(a, b)
    : c.type === 'date' ? (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0) : collator.compare;
  const rest = [...buckets.keys()].filter((k) => !known.has(k)).sort(order);
  return [
    ...opts.map((o) => mk(o.value, o.label ?? o.value, buckets.get(o.value) ?? [])),
    ...rest.map((k) => mk(k, optionLabel(c, k), buckets.get(k)!)),
    ...(empty.length ? [mk(null, '', empty)] : []),
  ];
}

/**
 * Filter, then sort (empty last whichever way, position breaks ties), then
 * group. A condition on a missing column, or one still waiting for its value,
 * is left out; with none left every row passes.
 */
export function applyView(
  db: Pick<MichiDatabase, 'columns' | 'rows'> & Partial<Pick<MichiDatabase, 'id' | 'kind'>>,
  config: MichiDbViewConfig,
  options: {
    isOneLiner?: (db: Pick<MichiDatabase, 'id' | 'kind'>, column: MichiDbColumn) => boolean;
    oneLineText?: (value: string) => string;
    /** Linked conversations as they stand now; without it no conversation waits. */
    conversation?: ConversationLookup;
  } = {},
): DbGroup[] {
  const byId = new Map(db.columns.map((c) => [c.id, c]));
  const oneLiner = (c: MichiDbColumn) => db.id !== undefined && db.kind !== undefined && (options.isOneLiner?.({ id: db.id, kind: db.kind }, c) ?? false);
  const filters = (config.filters ?? []).flatMap((f) => {
    const c = byId.get(f.column);
    return c && isActiveFilter(db.columns, f) ? [{ c, f }] : [];
  });
  const hit = (r: MichiDbRow) => {
    const test = (x: { c: MichiDbColumn; f: MichiDbFilter }) => matches(x.c, x.f, cellOf(r, x.c.id), oneLiner(x.c), options.oneLineText, options.conversation);
    return config.match === 'any' ? filters.some(test) : filters.every(test);
  };
  const sorts = (config.sorts ?? []).flatMap((s) => {
    const c = byId.get(s.column);
    return c ? [{ c, dir: s.dir === 'desc' ? -1 : 1, cmp: comparator(c, oneLiner(c), options.oneLineText) }] : [];
  });
  const rows = (filters.length ? db.rows.filter(hit) : db.rows.slice()).sort((a, b) => {
    for (const s of sorts) {
      // A checkbox has no empty: unset is unchecked.
      const x = cellOf(a, s.c.id);
      const y = cellOf(b, s.c.id);
      const ex = s.c.type !== 'checkbox' && isBlank(x);
      const ey = s.c.type !== 'checkbox' && isBlank(y);
      if (ex || ey) {
        if (ex && ey) continue;
        return ex ? 1 : -1;
      }
      const d = s.cmp(x, y);
      if (d) return d * s.dir;
    }
    return byPosition(a, b);
  });
  const sumCols = db.columns.filter((c) => c.type === 'number' || c.type === 'progress');
  return group(config.group === undefined ? undefined : byId.get(config.group), rows, sumCols);
}

// ── Columns and views ────────────────────────────────────────────────

/** Built-in columns are the thread's, so only those marked editable take a value; any other column is editable unless locked. */
export const cellEditable = (c: MichiDbColumn) => (c.builtin ? c.editable === true : c.editable !== false);

/** A thread's state on All threads, which Michi mostly works out itself. */
export const isThreadState = (db: Pick<MichiDatabase, 'id' | 'kind'>, c: MichiDbColumn) => isThreadsDb(db) && !!c.builtin && c.id === 'state';

/** The values a person may give a cell; empty for "anything". On All threads' state, only In progress and Done. */
export function writableOptions(db: Pick<MichiDatabase, 'id' | 'kind'>, c: MichiDbColumn): ReadonlySet<string> | null {
  return isThreadState(db, c) ? new Set<string>(MICHI_THREAD_WRITABLE_STATES) : null;
}

/** The column that names a row: a thread's title, otherwise the first text column (the first column when there is none). Never hidden. */
export function titleColumn(db: Pick<MichiDatabase, 'id' | 'kind' | 'columns'>): MichiDbColumn | undefined {
  return (isThreadsDb(db) ? db.columns.find((c) => c.id === 'title') : undefined)
    ?? db.columns.find((c) => c.type === 'text')
    ?? db.columns[0];
}

/** Kinds of value short enough to sit beside a title on one line. */
const SHORT_COLUMN_TYPES: ReadonlySet<MichiDbColumn['type']> = new Set(['select', 'app', 'date', 'number', 'checkbox', 'progress']);

/**
 * What a list shows before any column is chosen: the title, All threads'
 * status (its dot), project, app and age, or a database's first two short
 * columns. Long text and the rest wait until the view picks them.
 */
export function listDefaultColumns(db: Pick<MichiDatabase, 'id' | 'kind' | 'columns'>): string[] {
  const title = titleColumn(db)?.id;
  if (isThreadsDb(db)) {
    return ['state', 'project', 'app', 'lastActivity'].filter((id) => db.columns.some((c) => c.id === id && c.builtin));
  }
  return db.columns.filter((c) => c.id !== title && SHORT_COLUMN_TYPES.has(c.type)).slice(0, 2).map((c) => c.id);
}

/**
 * Columns the view shows, in the database's order. `visible` unset means
 * all, except in a list, which starts from `listDefaultColumns`.
 */
export function shownColumns(
  db: Pick<MichiDatabase, 'id' | 'kind' | 'columns'>,
  config: MichiDbViewConfig,
  type?: MichiDbView['type'],
): MichiDbColumn[] {
  const visible = config.visible ?? (type === 'list' ? listDefaultColumns(db) : undefined);
  if (!visible) return db.columns;
  const keep = new Set(visible);
  const title = titleColumn(db)?.id;
  return db.columns.filter((c) => keep.has(c.id) || c.id === title);
}

/** What a board splits into columns by: the view's grouping, else the first single-select column. */
export function boardGroupColumn(db: Pick<MichiDatabase, 'columns'>, config: MichiDbViewConfig): MichiDbColumn | undefined {
  return db.columns.find((c) => c.id === config.group) ?? db.columns.find((c) => c.type === 'select');
}

export const dateColumns = (db: Pick<MichiDatabase, 'columns'>) => db.columns.filter((c) => c.type === 'date');

/** A date view's column: the view's `date` when it is a date column, else All threads' last activity, else the first date column. */
export function dateColumn(db: Pick<MichiDatabase, 'id' | 'kind' | 'columns'>, config: MichiDbViewConfig): MichiDbColumn | undefined {
  const dates = dateColumns(db);
  return dates.find((c) => c.id === config.date)
    ?? (isThreadsDb(db) ? dates.find((c) => c.id === 'lastActivity') : undefined)
    ?? dates[0];
}

export function planColumn(db: Pick<MichiDatabase, 'columns'>, config: MichiDbViewConfig): MichiDbColumn | undefined {
  return config.planDate ? dateColumns(db).find((c) => c.id === config.planDate) : undefined;
}

/** A gallery's cover: the view's `cover` column when it is an image column, else the first image column. */
export function coverColumn(db: Pick<MichiDatabase, 'columns'>, config: MichiDbViewConfig): MichiDbColumn | undefined {
  return db.columns.find((c) => c.id === config.cover && c.type === 'image') ?? db.columns.find((c) => c.type === 'image');
}

/** The config a view is drawn with: a board with no grouping of its own splits by the first single-select column. */
export function effectiveConfig(db: Pick<MichiDatabase, 'columns'>, view: MichiDbView): MichiDbViewConfig {
  if (view.type !== 'board') return view.config;
  const by = boardGroupColumn(db, view.config);
  return by && by.id !== view.config.group ? { ...view.config, group: by.id } : view.config;
}

export const emptyConfig = (): MichiDbViewConfig => ({ filters: [], match: 'all', sorts: [] });

/** A row made under simple conditions starts out meeting them, so it does not vanish as soon as it is made. */
export function startValues(db: Pick<MichiDatabase, 'columns'>, config: MichiDbViewConfig): Record<string, CellValue> {
  const values: Record<string, CellValue> = {};
  if (config.match !== 'any') {
    for (const f of config.filters) {
      if (f.op === 'is' && f.value != null && !Array.isArray(f.value) && db.columns.some((c) => c.id === f.column)) values[f.column] = f.value;
    }
  }
  return values;
}

export const sameValue = (a: CellValue | undefined, b: CellValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

let seq = 0;
/** Ids made here go with the op, so the screen and Michi agree on them before Michi has answered. */
export function newDbId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) ?? `${Date.now().toString(36)}${(++seq).toString(36)}`;
  return `${prefix}-${random}`;
}

/** The rows of a set of groups in reading order, each once (a multi-select row can sit in several groups). */
export function rowsInOrder(groups: readonly DbGroup[]): MichiDbRow[] {
  const seen = new Set<string>();
  const out: MichiDbRow[] = [];
  for (const g of groups) {
    for (const r of g.rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/**
 * The groups cut to the first `limit` rows in reading order (a big database
 * draws a page at a time). A row already drawn costs nothing where it shows
 * again (a multi-select row sits in each of its groups); `rest` is how many
 * rows are not drawn anywhere.
 */
export function limitGroups(groups: readonly DbGroup[], limit: number): { groups: DbGroup[]; rest: number } {
  const drawn = new Set<string>();
  const all = new Set<string>();
  const out = groups.map((g) => {
    const rows = g.rows.filter((r) => {
      all.add(r.id);
      if (drawn.has(r.id)) return true;
      if (drawn.size >= limit) return false;
      drawn.add(r.id);
      return true;
    });
    return rows.length === g.rows.length ? g : { ...g, rows };
  });
  return { groups: out, rest: all.size - drawn.size };
}
