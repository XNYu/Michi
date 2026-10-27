const BLOCK_META = new Set(['id', 'rev', 'sources', 'edit']);

/** Whether a stored block snapshot (with its id, rev and sources) shows the task board, inside containers too. */
export function blockShowsTaskBoard(block: Record<string, unknown>): boolean {
  const content = parsePageBlockInput(Object.fromEntries(Object.entries(block).filter(([key]) => !BLOCK_META.has(key))));
  return !!content && containsTaskView([content]);
}

/**
 * A workspace's task database: one native database per workspace with fixed
 * core columns (the task, its status, the conversations it links, its next
 * step) and three default views. People add their own columns and views; the
 * core columns keep their ids and types so agents and the UI can rely on them.
 */
import type { MichiDbCellValue, MichiDbColumnOption } from '../databaseModel';
import { parsePageBlockInput, type PageBlock, type PageBlockInput } from './blocks';
import type { PageDatabase, PageDatabaseColumn, PageDatabaseRole, PageDatabaseRow, PageDatabaseView } from './database';
import type { PageChangeDto } from './types';

export const TASK_DATABASE_ROLE: PageDatabaseRole = 'tasks';
export const TASK_DATABASE_TITLE = 'Tasks';

/** The core columns' fixed ids. */
export const TASK_COLUMN = { task: 'task', status: 'status', threads: 'threads', next: 'next' } as const;

/** The four statuses every task database keeps; options a person adds count as not done, and agents leave them alone. */
export const TASK_STATUSES = ['todo', 'doing', 'waiting', 'done'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

/** The default views' fixed ids. */
export const TASK_VIEW = { board: 'tasks-board', table: 'tasks-table', needsYou: 'tasks-needs-you' } as const;

export const TASK_LIMITS = { threads: 20 } as const;

const CORE: ReadonlyArray<readonly [string, PageDatabaseColumn['type'], string]> = [
  [TASK_COLUMN.task, 'text', 'Task'],
  [TASK_COLUMN.status, 'select', 'Status'],
  [TASK_COLUMN.threads, 'threads', 'Conversations'],
  [TASK_COLUMN.next, 'text', 'Next step'],
];
const CORE_IDS: ReadonlySet<string> = new Set(CORE.map(([id]) => id));

export function taskDatabaseColumns(): PageDatabaseColumn[] {
  return [
    { id: TASK_COLUMN.task, name: 'Task', type: 'text', width: 280 },
    { id: TASK_COLUMN.status, name: 'Status', type: 'select', options: [
      { value: 'todo', label: 'To do', color: 'gray' },
      { value: 'doing', label: 'In progress', color: 'blue' },
      { value: 'waiting', label: 'Waiting on you', color: 'amber' },
      { value: 'done', label: 'Done', color: 'green' },
    ] },
    { id: TASK_COLUMN.threads, name: 'Conversations', type: 'threads', width: 260 },
    { id: TASK_COLUMN.next, name: 'Next step', type: 'text', width: 260 },
  ];
}

/** Board by status, a table, and Needs you: waiting on you, or linking a conversation that waits on you. */
export function taskDatabaseViews(): PageDatabaseView[] {
  return [
    { id: TASK_VIEW.board, name: 'Board', type: 'board', position: 0, config: { filters: [], match: 'all', sorts: [], group: TASK_COLUMN.status } },
    { id: TASK_VIEW.table, name: 'Table', type: 'table', position: 1, config: { filters: [], match: 'all', sorts: [] } },
    { id: TASK_VIEW.needsYou, name: 'Needs you', type: 'list', position: 2, config: {
      filters: [{ column: TASK_COLUMN.status, op: 'is', value: 'waiting' }, { column: TASK_COLUMN.threads, op: 'waiting' }],
      match: 'any', sorts: [],
    } },
  ];
}

/** Why a database's columns do not fit its role, in words for whoever changed them; null when they fit. */
export function databaseRoleProblem(database: Pick<PageDatabase, 'columns'>, role: PageDatabaseRole | null | undefined): string | null {
  const threads = database.columns.filter((column) => column.type === 'threads');
  if (role !== TASK_DATABASE_ROLE) return threads.length ? 'Only a task database has a Conversations column' : null;
  if (threads.some((column) => column.id !== TASK_COLUMN.threads)) return 'A task database has one Conversations column';
  for (const [id, type, name] of CORE) {
    const column = database.columns.find((candidate) => candidate.id === id);
    if (!column) return `A task database keeps its ${name} column`;
    if (column.type !== type) return `The ${name} column of a task database keeps its type`;
  }
  const status = database.columns.find((column) => column.id === TASK_COLUMN.status)!;
  const values = new Set((status.options ?? []).map((option) => option.value));
  if (TASK_STATUSES.some((value) => !values.has(value))) return 'A task database keeps To do, In progress, Waiting on you and Done';
  return null;
}

/** The conversations a task links, as its Conversations cell holds them. */
export function taskThreadIds(value: MichiDbCellValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : [];
}

/** A linked conversation waits on the person only while it waits; a stalled one (waiting for days, or failed) has its own glyph. */
export function conversationWaitsOnYou(state: string | null | undefined): boolean {
  return state === 'waiting';
}

/** Whether a page shows the task board anywhere, inside containers too. */
export function containsTaskView(blocks: ReadonlyArray<PageBlock | PageBlockInput>): boolean {
  return blocks.some((block) => {
    switch (block.type) {
      case 'task-view': return true;
      case 'toggle': return containsTaskView(block.blocks);
      case 'columns': return block.columns.some((column) => containsTaskView(column));
      case 'tabs': return block.tabs.some((tab) => containsTaskView(tab.blocks));
      case 'grid': return block.regions.some((region) => containsTaskView(region.blocks));
      default: return false;
    }
  });
}

export const isTaskDb = (db: { role?: string | null }): boolean => db.role === TASK_DATABASE_ROLE;

/** A task database's core column: it keeps its id and type; its name and width may change. */
export const isTaskCoreColumn = (db: { role?: string | null }, column: { id: string }): boolean => isTaskDb(db) && CORE_IDS.has(column.id);

/** list_tasks: tasks one read returns by default, and at most. */
export const TASK_LIST_LIMITS = { default: 50, max: 200 } as const;

/** One task as a task list returns it: enough to answer about it, and to edit it with edit_database. */
export interface TaskListItem {
  workspaceId: string;
  workspaceName: string;
  databaseId: string;
  rowId: string;
  /** The row's revision: edit_database takes it as expectRev. */
  rev: number;
  task: string;
  status: string | null;
  /** The person set the status (an agent only suggests changes to it), an agent did, or nobody has yet. */
  statusSetBy: 'user' | 'agent' | null;
  next: string;
  conversationIds: string[];
  /** The linked conversations of the task's workspace that wait on the person now. */
  waitingConversationIds: string[];
  /** Waiting on you, or linking a conversation that waits on you now. */
  needsYou: boolean;
  /** Whether the task has notes; read_database returns them. */
  hasNotes: boolean;
  updatedAt: number;
}

/** A workspace with a task database that a read across workspaces left out, and why. */
export interface TaskListSkip {
  workspaceId: string;
  workspaceName: string;
  reason: 'archived' | 'navigation-off';
}

export interface TaskListResult {
  items: TaskListItem[];
  /** Pass back as cursor for the next tasks; null after the last. */
  nextCursor: string | null;
  skippedWorkspaces: TaskListSkip[];
}

/** All tasks: the id of its merged database, and its one column of its own. */
export const ALL_TASKS_DATABASE_ID = 'all-tasks';
export const ALL_TASKS_COLUMN = { workspace: 'workspace' } as const;

/** One workspace's task database, as All tasks reads it. */
export interface AllTasksSource {
  workspaceId: string;
  workspaceName: string;
  databaseId: string;
  revision: number;
  /** Its statuses: the four core ones, and any a person added. */
  statuses: MichiDbColumnOption[];
}

/** Every task database of the person's live workspaces, and All tasks' own views. */
export interface AllTasksDto {
  sources: AllTasksSource[];
  rows: Array<{ databaseId: string; row: PageDatabaseRow }>;
  /** Saved per person; the three task views until they save one. */
  views: PageDatabaseView[];
  viewsRevision: number;
}

/**
 * All tasks' columns: the core columns, every status any task database has
 * (the four core ones first), and the workspace each task belongs to.
 */
export function allTasksColumns(sources: ReadonlyArray<Pick<AllTasksSource, 'workspaceId' | 'workspaceName' | 'statuses'>>): PageDatabaseColumn[] {
  const columns = taskDatabaseColumns();
  const status = columns.find((column) => column.id === TASK_COLUMN.status)!;
  const options = [...(status.options ?? [])];
  for (const source of sources) {
    for (const option of source.statuses) {
      if (!options.some((known) => known.value === option.value)) options.push({ ...option });
    }
  }
  status.options = options;
  return [...columns, {
    id: ALL_TASKS_COLUMN.workspace, name: 'Workspace', type: 'select',
    options: sources.map((source) => ({ value: source.workspaceId, label: source.workspaceName })),
  }];
}

/** How long a board marks what the Meta agent's upkeep added or changed: a day. */
export const TASK_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Suggestions and upkeep changes one activity read looks at, newest first. */
export const TASK_ACTIVITY_LIMITS = { suggestions: 200, upkeepChanges: 2000 } as const;

/** A task the Meta agent's upkeep added (new) or changed (updated) lately; `at` is its latest such change. */
export interface TaskMark {
  rowId: string;
  kind: 'new' | 'updated';
  at: number;
}

/** The Meta agent's latest upkeep of a task database: one batch, what it did, and the conversation it read. */
export interface TaskUpkeep {
  batchId: string;
  at: number;
  added: number;
  updated: number;
  removed: number;
  /** Its suggestions still waiting on the person. */
  suggested: number;
  /** The conversation it read, while that is still there. */
  source: { nodeId: string; turnId: string; assistantId: string; title: string } | null;
}

/** What a task board shows of the Meta agent's upkeep. */
export interface TaskActivity {
  /** Suggestions waiting on the tasks, from any agent, newest first. */
  suggestions: PageChangeDto[];
  marks: TaskMark[];
  /** null once any of it was undone, when it is over a day old, or when it has nothing left to say. */
  latestUpkeep: TaskUpkeep | null;
}

/** Who made a task: the person, the Meta agent (its upkeep or the Pages Assistant), or an agent in a chat. */
export interface TaskOrigin {
  by: 'you' | 'meta-agent' | 'agent';
  /** The conversations it linked when it was made; for upkeep that linked none, the ones it read. */
  conversations: number;
  at: number;
}
