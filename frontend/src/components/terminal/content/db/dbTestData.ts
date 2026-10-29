import type {
  MichiDatabase,
  MichiDbColumn,
  MichiDbEditOp,
  MichiDbRow,
  MichiDbView,
  MichiDbViewConfig,
  MichiThreadState,
} from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { cellEditable, isThreadsDb, sameValue } from './dbModel';

/** Sample rows used to exercise computed and editable columns. */
export interface SampleThread {
  id: string; projectId: string; title: string; state: MichiThreadState;
  doneBy?: 'user' | 'agent'; lastActivityAt: number | null;
  idleDays: number; stoppedAt: string; next: string | null;
  source: { app: string; via?: string } | null;
}

export const STATE_OPTIONS = [
  { value: 'waiting', label: '等你', color: 'blue' as const },
  { value: 'stalled', label: '停住', color: 'amber' as const },
  { value: 'doing', label: '推进中', color: 'violet' as const },
  { value: 'done', label: '做完', color: 'green' as const },
  { value: 'idea', label: '只聊过', color: 'gray' as const },
];

export function threadColumns(projects: Array<{ id: string; title: string }> = [{ id: 'p1', title: 'agent-desk' }]): MichiDbColumn[] {
  return [
    { id: 'title', name: '标题', type: 'text', builtin: true, editable: true },
    { id: 'project', name: '项目', type: 'select', options: projects.map((p) => ({ value: p.id, label: p.title })), builtin: true, editable: false },
    { id: 'state', name: '状态', type: 'select', options: STATE_OPTIONS, builtin: true, editable: true },
    { id: 'app', name: 'App', type: 'app', builtin: true, editable: false },
    { id: 'lastActivity', name: '最近活动', type: 'date', builtin: true, editable: false },
    { id: 'next', name: '下一步', type: 'text', builtin: true, editable: true },
    { id: 'stoppedAt', name: '停在', type: 'text', builtin: true, editable: false },
    { id: 'code', name: '代码', type: 'text', builtin: true, editable: false },
  ];
}

const recent = () => [{ column: 'lastActivity', dir: 'desc' as const }];

export function threadViews(): MichiDbView[] {
  return [
    { id: 'threads-board', name: '看板', type: 'board', position: 0, config: { filters: [], match: 'all', sorts: recent(), group: 'state', visible: ['title', 'project', 'state', 'app', 'lastActivity'] } },
    { id: 'threads-table', name: '表格', type: 'table', position: 1, config: { filters: [], match: 'all', sorts: recent() } },
    { id: 'threads-timeline', name: '时间线', type: 'timeline', position: 2, config: { filters: [], match: 'all', sorts: recent(), group: 'project', date: 'lastActivity' } },
    { id: 'v-cal', name: '日历', type: 'calendar', position: 3, config: { filters: [], match: 'all', sorts: recent(), date: 'lastActivity' } },
  ];
}

/** A thread as its row: Michi's own values (`threadValues`). */
export function threadRow(t: SampleThread, extra: Record<string, MichiDbRow['values'][string]> = {}): MichiDbRow {
  const values: MichiDbRow['values'] = { title: t.title, project: t.projectId, state: t.state, ...extra };
  if (t.source) values.app = t.source.via ?? t.source.app;
  if (t.lastActivityAt !== null) values.lastActivity = { start: new Date(t.lastActivityAt).toISOString() };
  if (t.next) values.next = t.next;
  if (t.stoppedAt) values.stoppedAt = t.stoppedAt;
  return { id: t.id, values, position: t.lastActivityAt === null ? Number.MAX_SAFE_INTEGER : -t.lastActivityAt, updatedAt: 1 };
}

export function threadsDatabase(threads: SampleThread[], opts: { columns?: MichiDbColumn[]; views?: MichiDbView[]; rows?: MichiDbRow[] } = {}): MichiDatabase {
  return {
    id: 'threads',
    title: '全部',
    kind: 'threads',
    projectId: null,
    columns: opts.columns ?? threadColumns(),
    views: opts.views ?? threadViews(),
    rows: opts.rows ?? threads.map((t) => threadRow(t)),
    updatedAt: 1,
  };
}

export function userDatabase(extra: Partial<MichiDatabase> = {}): MichiDatabase {
  return {
    id: 'db_trip',
    title: '旅行清单',
    kind: 'user',
    projectId: null,
    columns: [
      { id: 'c_name', name: '名称', type: 'text' },
      { id: 'c_pri', name: 'Priority', type: 'select', options: [{ value: 'High', color: 'violet' }, { value: 'Normal' }, { value: 'Low' }] },
      { id: 'c_due', name: 'Due', type: 'date' },
      { id: 'c_effort', name: 'Effort', type: 'number' },
      { id: 'c_tags', name: 'Tags', type: 'multi', options: [{ value: 'trip' }, { value: 'desk' }] },
      { id: 'c_done', name: 'Reviewed', type: 'checkbox' },
    ],
    views: [{ id: 'table', name: '表格', type: 'table', position: 0, config: { filters: [], match: 'all', sorts: [] } }],
    rows: [
      { id: 'r1', values: { c_name: 'Book the hotel', c_pri: 'High', c_due: { start: '2026-10-25', end: '2026-10-27' }, c_effort: 3, c_tags: ['trip'] }, position: 0, updatedAt: 1, body: 'Kanra or **Ace**' },
      { id: 'r2', values: { c_name: 'Pack', c_pri: 'Low', c_effort: 2 }, position: 1, updatedAt: 1 },
      { id: 'r3', values: { c_name: 'Rail pass', c_done: true }, position: 2, updatedAt: 1 },
    ],
    updatedAt: 1,
    ...extra,
  };
}

/** A workspace's task database as the UI gets it. */
export function taskDatabase(rows: MichiDbRow[] = []): MichiDatabase {
  return {
    id: 'db-tasks', title: 'Tasks', kind: 'user', role: 'tasks', projectId: null,
    columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows, updatedAt: 1,
  };
}

// ── Drawn ahead of Michi's answer ─────────────────────────────────────

const put = (values: Record<string, unknown>, id: string, v: unknown) => {
  const { [id]: _drop, ...rest } = values;
  return (v === null || v === undefined ? rest : { ...rest, [id]: v }) as MichiDbRow['values'];
};

/** A deleted column leaves nothing behind in a view. */
function unref(c: MichiDbViewConfig, id: string): MichiDbViewConfig {
  const next: MichiDbViewConfig = {
    ...c,
    filters: (c.filters ?? []).filter((f) => f.column !== id),
    sorts: (c.sorts ?? []).filter((s) => s.column !== id),
    ...(c.visible ? { visible: c.visible.filter((x) => x !== id) } : {}),
  };
  for (const k of ['group', 'date', 'planDate', 'cover'] as const) if (next[k] === id) delete next[k];
  return next;
}

/**
 * The database as the ops will leave it, drawn at once while Michi applies
 * them for real. Michi's answer replaces it either way, so this only needs to
 * be right for what a person sees in the moment: values are not converted, and
 * an op this cannot place is left for Michi to decide.
 */
export function applyOpsLocally(db: MichiDatabase, ops: readonly MichiDbEditOp[], now: number): MichiDatabase {
  const threads = isThreadsDb(db);
  let { columns, rows, views } = db;
  const colAt = (id: string) => columns.findIndex((c) => c.id === id);
  const rowAt = (id: string) => rows.findIndex((r) => r.id === id);
  for (const op of ops) {
    switch (op.op) {
      case 'row.update': {
        const i = rowAt(op.id);
        if (i < 0) break;
        let values = rows[i].values;
        for (const [k, v] of Object.entries(op.values ?? {})) {
          const c = columns[colAt(k)];
          if (!c || !cellEditable(c)) continue;
          if (threads && c.builtin && c.id === 'state' && v !== 'doing' && v !== 'done') continue;
          values = put(values, k, v);
        }
        const next: MichiDbRow = { ...rows[i], values, updatedAt: now };
        if (op.body !== undefined) {
          if (op.body) next.body = op.body;
          else delete next.body;
        }
        if (sameValue(next.values as never, rows[i].values as never) && next.body === rows[i].body) break;
        rows = rows.map((r, j) => (j === i ? next : r));
        break;
      }
      case 'row.add': {
        if (threads || !op.id || rowAt(op.id) >= 0) break;
        const position = rows.reduce((m, r) => Math.max(m, r.position + 1), 0);
        const values = Object.fromEntries(Object.entries(op.values).filter(([, v]) => v !== null)) as MichiDbRow['values'];
        rows = [...rows, { id: op.id, values, ...(op.body ? { body: op.body } : {}), position, updatedAt: now }];
        break;
      }
      case 'row.delete':
        if (!threads) rows = rows.filter((r) => r.id !== op.id);
        break;
      case 'column.add': {
        const id = op.column.id;
        if (!id || colAt(id) >= 0) break;
        const column: MichiDbColumn = { ...op.column, id };
        const at = op.after === undefined ? columns.length : op.after === null ? 0 : colAt(op.after) + 1;
        columns = [...columns.slice(0, at), column, ...columns.slice(at)];
        break;
      }
      case 'column.update': {
        const i = colAt(op.id);
        if (i < 0) break;
        const c = columns[i];
        // A built-in column's name, type and options are the thread's; only its width is layout.
        const patch = c.builtin ? (op.patch.width !== undefined ? { width: op.patch.width } : {}) : op.patch;
        columns = columns.map((x, j) => (j === i ? { ...x, ...patch } : x));
        break;
      }
      case 'column.delete': {
        const c = columns[colAt(op.id)];
        if (!c || c.builtin) break;
        columns = columns.filter((x) => x.id !== op.id);
        rows = rows.map((r) => (Object.prototype.hasOwnProperty.call(r.values, op.id) ? { ...r, values: put(r.values, op.id, null) } : r));
        views = views.map((v) => ({ ...v, config: unref(v.config, op.id) }));
        break;
      }
      case 'option.add': {
        const i = colAt(op.id);
        const c = columns[i];
        if (!c || c.builtin || c.options?.some((o) => o.value === op.option.value)) break;
        columns = columns.map((x, j) => (j === i ? { ...x, options: [...(x.options ?? []), op.option] } : x));
        break;
      }
      case 'view.save': {
        const v = op.view;
        const i = v.id === undefined ? -1 : views.findIndex((x) => x.id === v.id);
        if (i >= 0) views = views.map((x, j) => (j === i ? { ...x, name: v.name, type: v.type, config: v.config } : x));
        else if (v.id) views = [...views, { id: v.id, name: v.name, type: v.type, config: v.config, position: views.reduce((m, x) => Math.max(m, x.position + 1), 0) }];
        break;
      }
      case 'view.delete':
        if (views.length > 1) views = views.filter((v) => v.id !== op.id);
        break;
      default:
        break;
    }
  }
  if (columns === db.columns && rows === db.rows && views === db.views) return db;
  return { ...db, columns, rows, views, updatedAt: now };
}
