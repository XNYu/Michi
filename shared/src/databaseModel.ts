

/** `threads`: conversation node ids (a task database's Conversations; only a task database has one). */
export const MICHI_DB_COLUMN_TYPES = ['text', 'number', 'date', 'select', 'multi', 'checkbox', 'url', 'progress', 'app', 'image', 'threads'] as const;
export const MICHI_DB_VIEW_TYPES = ['table', 'board', 'list', 'calendar', 'gallery', 'timeline', 'custom'] as const;
/** `waiting`: on a Conversations column, one of them waits on the person now. */
export const MICHI_DB_FILTER_OPS = [
  'is', 'is-not', 'contains', 'not-contains', 'empty', 'not-empty', 'gt', 'lt', 'before', 'after', 'checked', 'unchecked', 'waiting',
] as const;
export const MICHI_DB_OPTION_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'violet'] as const;

export type MichiDbColumnType = typeof MICHI_DB_COLUMN_TYPES[number];
export type MichiDbViewType = typeof MICHI_DB_VIEW_TYPES[number];
export type MichiDbFilterOp = typeof MICHI_DB_FILTER_OPS[number];
export type MichiDbOptionColor = typeof MICHI_DB_OPTION_COLORS[number];

/** `value` is what a cell stores, `label` what people see (value when absent). */
export interface MichiDbColumnOption {
  value: string;
  label?: string;
  color?: MichiDbOptionColor;
}

/**
 * A column. `builtin` columns of the threads database are computed from the
 * thread: only those with `editable: true` write back. Any other column is
 * editable unless `editable: false`.
 */
export interface MichiDbColumn {
  id: string;
  name: string;
  type: MichiDbColumnType;
  options?: MichiDbColumnOption[];
  builtin?: true;
  editable?: boolean;
  width?: number;
}

/** `start`/`end` are `YYYY-MM-DD` (a local day) or an ISO time. */
export interface MichiDbDateValue {
  start: string;
  end?: string;
}

export type MichiDbCellValue = string | number | boolean | string[] | MichiDbDateValue | null;

export interface MichiDbRow {
  id: string;
  values: Record<string, MichiDbCellValue>;
  /** Markdown. */
  body?: string;
  position: number;
  updatedAt: number;
  /** Native rows: when a person last set each cell; an agent only suggests changes to those. */
  edited?: Record<string, number>;
}

export interface MichiDbFilter {
  column: string;
  op: MichiDbFilterOp;
  value?: MichiDbCellValue;
}

export interface MichiDbSort {
  column: string;
  dir: 'asc' | 'desc';
}

/**
 * What a view shows. Michi validates this shape strictly (no other keys).
 * Timeline: `date` is the actual dates, `planDate` the plan (optional).
 */
export interface MichiDbViewConfig {
  filters: MichiDbFilter[];
  match: 'all' | 'any';
  sorts: MichiDbSort[];
  group?: string;
  /** Columns shown, in the database's order; unset means all. */
  visible?: string[];
  date?: string;
  planDate?: string;
  cover?: string;
  component?: string;
  code?: string;
}

export interface MichiDbView {
  id: string;
  name: string;
  type: MichiDbViewType;
  config: MichiDbViewConfig;
  position: number;
}

export type MichiDbKind = 'threads' | 'user' | 'page';

export interface MichiDatabase {
  id: string;
  title: string;
  icon?: string;
  projectId?: string | null;
  kind: MichiDbKind;
  /** `tasks`: the workspace's task database, with its fixed core columns. */
  role?: 'tasks';
  /** All tasks: tasks merged from every workspace's task database. Nothing is added, put in order or given new columns there. */
  merged?: true;
  columns: MichiDbColumn[];
  views: MichiDbView[];
  rows: MichiDbRow[];
  updatedAt: number;
}

export type MichiDbNewColumn = Omit<MichiDbColumn, 'id' | 'builtin'> & { id?: string };
export type MichiDbNewView = Omit<MichiDbView, 'id' | 'position'> & { id?: string };

/** Presentation edits emitted by the database UI; the native adapter adds revision checks before persistence. */
export type MichiDbEditOp =
  | { op: 'column.add'; column: MichiDbNewColumn; after?: string | null }
  | { op: 'column.update'; id: string; patch: Partial<Omit<MichiDbColumn, 'id' | 'builtin'>> }
  | { op: 'column.delete'; id: string }
  | { op: 'column.move'; id: string; after: string | null }
  | { op: 'option.add'; id: string; option: MichiDbColumnOption }
  | { op: 'row.add'; id?: string; values: Record<string, MichiDbCellValue>; body?: string; after?: string | null }
  | { op: 'row.update'; id: string; values?: Record<string, MichiDbCellValue>; body?: string }
  | { op: 'row.delete'; id: string }
  | { op: 'row.move'; id: string; after: string | null }
  | { op: 'view.save'; view: MichiDbNewView }
  | { op: 'view.delete'; id: string };

/** The id of the threads database ("All threads"). */
export const MICHI_THREADS_DB = 'threads';

/** The only thread states a person sets; Michi works the others out from the conversation. */
export const MICHI_THREAD_WRITABLE_STATES = ['doing', 'done'] as const;

/** Resource limits shared by Michi's database UI and persistence layer. */
export const MICHI_DB_LIMITS = {
  /** Ops in one edit. */
  editOps: 200,
  /** Bytes of one edit's ops as JSON: Michi's own cap, so one request stays small. */
  editBytes: 1_000_000,
  /** Row ids in one `?ids=` read. */
  readIds: 2000,
  columns: 100,
  views: 50,
  rows: 5000,
  /** Graphemes in a database or column name. */
  title: 100,
} as const;



/** A database without its columns, views and rows. */
export type MichiDbHead = Omit<MichiDatabase, 'columns' | 'views' | 'rows'>;
