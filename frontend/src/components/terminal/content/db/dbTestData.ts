import type { MichiDatabase, MichiDbColumn, MichiDbRow, MichiDbView, MichiThreadState } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';

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
