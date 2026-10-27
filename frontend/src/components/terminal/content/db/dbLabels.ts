import type {
  MichiDatabase,
  MichiDbColumn,
  MichiDbColumnType,
  MichiDbFilter,
  MichiDbFilterOp,
  MichiDbOptionColor,
  MichiDbView,
  MichiDbViewType,
  MichiThreadState,
} from 'michi-shared';
import { michiStateLabel } from '../michiFormat';
import { isDateValue, isThreadsDb, NO_VALUE_OPS, optionLabel, type CellValue } from './dbModel';

// What the database UI calls things. Michi names its built-in columns, default
// views and empty groups in Chinese; Michi's UI is English, so those read in
// English here. Names a person typed (or the agent wrote) stay as they are.

type DbRef = Pick<MichiDatabase, 'id' | 'kind'>;

const THREAD_COLUMN_NAMES: Record<string, string> = {
  title: 'Title',
  project: 'Workspace',
  state: 'Status',
  app: 'App',
  lastActivity: 'Last activity',
  next: 'Next',
  stoppedAt: 'Stopped at',
  code: 'Code',
};

const THREAD_VIEW_NAMES: Record<string, string> = {
  'threads-board': 'By status',
  'threads-table': 'Table',
  'threads-timeline': 'Timeline',
};

export const VIEW_TYPE_LABEL: Record<MichiDbViewType, string> = {
  table: 'Table',
  board: 'Board',
  list: 'List',
  calendar: 'Calendar',
  gallery: 'Gallery',
  timeline: 'Timeline',
  custom: 'Custom',
};

export const COLUMN_TYPE_LABEL: Record<MichiDbColumnType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Select',
  multi: 'Multi-select',
  checkbox: 'Checkbox',
  url: 'Link',
  progress: 'Progress',
  app: 'App',
  image: 'Image',
  threads: 'Conversations',
};

/** The type menu's order (the mock's). Conversations is not among them: only a task database has that column. */
export const COLUMN_TYPE_ORDER: MichiDbColumnType[] = ['text', 'number', 'date', 'select', 'multi', 'checkbox', 'url', 'progress', 'app', 'image'];

// Michi's own default names, as its UI and its "new database" make them.
const MICHI_VIEW_DEFAULTS: Record<string, MichiDbViewType> = {
  表格: 'table', 看板: 'board', 列表: 'list', 日历: 'calendar', 画廊: 'gallery', 时间线: 'timeline', 自定义: 'custom',
};
const MICHI_COLUMN_DEFAULTS: Record<string, string> = {
  名称: 'Name', 文本: 'Text', 数字: 'Number', 日期: 'Date', 单选: 'Select', 多选: 'Multi-select', 勾选: 'Checkbox',
  链接: 'Link', 进度: 'Progress', 图片: 'Image',
};

/** `看板 2` → `Board 2`. */
function defaultViewName(name: string): string | null {
  const m = /^(\S+?)( \d+)?$/.exec(name.trim());
  const type = m ? MICHI_VIEW_DEFAULTS[m[1]] : undefined;
  return type ? `${VIEW_TYPE_LABEL[type]}${m?.[2] ?? ''}` : null;
}

export function columnName(db: DbRef, column: MichiDbColumn): string {
  if (isThreadsDb(db) && column.builtin && THREAD_COLUMN_NAMES[column.id]) return THREAD_COLUMN_NAMES[column.id];
  return MICHI_COLUMN_DEFAULTS[column.name.trim()] ?? column.name;
}

export function viewName(db: DbRef, view: MichiDbView): string {
  const builtin = isThreadsDb(db) ? THREAD_VIEW_NAMES[view.id] : undefined;
  const byType = defaultViewName(view.name);
  // A built-in view has its English name while it keeps Michi's default one.
  if (builtin && byType !== null) return builtin;
  return byType ?? view.name;
}

/** "All threads" for the threads database (Michi calls it 全部); a person's title otherwise. */
export function databaseTitle(db: Pick<MichiDatabase, 'id' | 'kind' | 'title'>): string {
  return isThreadsDb(db) ? 'All threads' : db.title.trim() || 'Untitled';
}

export function databaseSummaryTitle(summary: { id: string; title: string }): string {
  return summary.id === 'threads' ? 'All threads' : summary.title.trim() || 'Untitled';
}

/** An option as people read it. All threads' states use Michi's state names. */
export function optionName(db: DbRef, column: MichiDbColumn, value: string, doneBy?: 'user' | 'agent'): string {
  if (isThreadsDb(db) && column.builtin && column.id === 'state') return michiStateLabel(value as MichiThreadState, doneBy);
  return optionLabel(column, value);
}

/** A group heading's words; an empty group reads "Empty". */
export function groupName(db: DbRef, column: MichiDbColumn | undefined, key: string | null, label: string): string {
  if (key === null) return column ? 'Empty' : '';
  if (!column) return label;
  if (column.type === 'checkbox') return key === 'true' ? 'Checked' : 'Not checked';
  if (column.type === 'date') return formatDay(key);
  if (column.type === 'select' || column.type === 'multi' || column.type === 'app') return optionName(db, column, key);
  return label;
}

// ── Dates ────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` is a local day; anything else is a time. Bad input gives null. */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** `Oct 21`; another year's day says its year. */
export function formatDay(s: string, now: Date = new Date()): string {
  const d = parseDay(s);
  if (!d) return s;
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** `Oct 25 → 27`, `Oct 30 → Nov 2`. */
export function formatDateValue(v: { start: string; end?: string }, now: Date = new Date()): string {
  if (!v.end) return formatDay(v.start, now);
  const a = parseDay(v.start);
  const b = parseDay(v.end);
  if (a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${formatDay(v.start, now)} → ${b.getDate()}`;
  return `${formatDay(v.start, now)} → ${formatDay(v.end, now)}`;
}

// ── Filters ──────────────────────────────────────────────────────────

export const OP_LABEL: Record<MichiDbFilterOp, string> = {
  is: 'is',
  'is-not': 'is not',
  contains: 'contains',
  'not-contains': "doesn't contain",
  empty: 'is empty',
  'not-empty': 'is not empty',
  gt: 'is more than',
  lt: 'is less than',
  before: 'is before',
  after: 'is after',
  checked: 'is checked',
  unchecked: 'is not checked',
  waiting: 'has one waiting on you',
};

/** A filter's value as its chip says it. */
export function filterValueText(db: DbRef, column: MichiDbColumn, value: CellValue | undefined): string {
  if (value == null) return '';
  if (column.type === 'progress' && typeof value === 'number') return `${Math.round(value * 100)}%`;
  if (column.type === 'date') return isDateValue(value) ? formatDateValue(value) : typeof value === 'string' ? formatDay(value) : String(value);
  if (Array.isArray(value)) return value.map((v) => optionName(db, column, v)).join(', ');
  if (typeof value === 'string' && (column.type === 'select' || column.type === 'multi' || column.type === 'app')) return optionName(db, column, value);
  return String(value);
}

/** `Status is Stalled`, `Due is empty`. */
export function filterChipText(db: DbRef, columns: readonly MichiDbColumn[], f: MichiDbFilter): string {
  const column = columns.find((c) => c.id === f.column);
  if (!column) return 'Removed column';
  const head = `${columnName(db, column)} ${OP_LABEL[f.op]}`;
  if (NO_VALUE_OPS.has(f.op)) return head;
  return `${head} ${filterValueText(db, column, f.value)}`.trim();
}

/** How a sort direction reads for a column's type. */
export function sortLabel(db: DbRef, column: MichiDbColumn, dir: 'asc' | 'desc'): string {
  switch (column.type) {
    case 'date': return dir === 'asc' ? 'Oldest first' : 'Newest first';
    case 'number':
    case 'progress': return dir === 'asc' ? 'Low → high' : 'High → low';
    case 'checkbox': return dir === 'asc' ? 'Unchecked first' : 'Checked first';
    case 'select':
    case 'multi':
    case 'app': {
      const options = column.options ?? [];
      if (options.length >= 2) {
        const first = optionName(db, column, options[0].value);
        const last = optionName(db, column, options[options.length - 1].value);
        return dir === 'asc' ? `${first} → ${last}` : `${last} → ${first}`;
      }
      return dir === 'asc' ? 'A → Z' : 'Z → A';
    }
    default: return dir === 'asc' ? 'A → Z' : 'Z → A';
  }
}

/** Option colours map to palette tokens, so every palette reads. */
export const OPTION_TONE: Record<MichiDbOptionColor, string> = {
  gray: 'var(--term-muted)',
  blue: 'var(--term-accent)',
  green: 'var(--term-digest)',
  amber: 'var(--term-select)',
  red: 'var(--term-danger)',
  violet: 'var(--term-mauve)',
};

const STATE_TONE: Record<MichiThreadState, string> = {
  waiting: 'var(--term-accent)',
  doing: 'var(--term-mid)',
  stalled: 'var(--term-mauve)',
  done: 'var(--term-digest)',
  idea: 'var(--term-faint)',
};

/** The colour an option shows in. A thread's state keeps Michi's state colours whatever its option says. */
export function optionTone(db: DbRef, column: MichiDbColumn, value: string): string | undefined {
  if (isThreadsDb(db) && column.builtin && column.id === 'state') return STATE_TONE[value as MichiThreadState];
  const color = column.options?.find((o) => o.value === value)?.color;
  return color ? OPTION_TONE[color] : undefined;
}
