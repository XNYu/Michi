import { taskDatabaseColumns, TASK_COLUMN } from 'michi-shared';
import type { ToolCallState } from '../chatTypes';
import { normalizeToolResultEnvelope, normalizeTurnToolName, parseTurnPageReceipt, type TaskWriteCounts } from '../../lib/turnPageReceipt';

/** Names the window knows for ids it sees in tool arguments. */
export interface ToolLineNames {
  workspace: (workspaceId: string) => string | null;
  page: (pageId: string) => string | null;
}

const TOOLS = [
  'list_pages', 'read_page', 'edit_page', 'create_page', 'read_database', 'edit_database', 'configure_database_view',
  'open_task_database', 'list_tasks',
  'list_page_components', 'read_page_component', 'save_page_component', 'layout_rules',
  'read_conversation_updates', 'start_conversation', 'list_workspaces', 'list_threads', 'search_messages',
  'read_node', 'read_node_overview', 'list_panes', 'inspect_pane', 'read_pane_output', 'wait_pane',
  'michi_docs',
] as const;
type Tool = typeof TOOLS[number];

function parse(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const clip = (text: string, max = 32): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The tool's own answer: the last object in its result envelope that has `key`, skipping runtime wrappers. */
function answer(tool: ToolCallState, keys: readonly string[]): Record<string, unknown> | null {
  const values = normalizeToolResultEnvelope(tool.output).filter((value): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value));
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (keys.some((key) => key in value) && !(Array.isArray(value.items) && value.items.some((item) => item && typeof item === 'object' && 'Json' in item))) return value;
  }
  return null;
}

function count(tool: ToolCallState, keys: readonly string[]): number | null {
  const value = answer(tool, keys);
  if (!value) return null;
  for (const key of keys) if (Array.isArray(value[key])) return (value[key] as unknown[]).length;
  return null;
}

function join(...parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(' · ');
}

/** The task statuses' default names, for the values a list_tasks call filters on. */
const STATUS_NAMES = new Map((taskDatabaseColumns().find((column) => column.id === TASK_COLUMN.status)?.options ?? [])
  .map((option) => [option.value, option.label ?? option.value] as const));

/** "5 new, 2 updated": what a write did to the task database; null when it applied nothing. */
function taskStepCounts(tasks: TaskWriteCounts): string | null {
  const parts = [
    tasks.added > 0 && `${tasks.added} new`,
    tasks.updated > 0 && `${tasks.updated} updated`,
    tasks.removed > 0 && `${tasks.removed} removed`,
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(', ') : null;
}

/** The backend's refusal of a page write while the first run still writes (firstRunHold.ts). */
const HELD = "HELD: the Meta agent's first-time generation";
const WRITE_TOOLS: ReadonlySet<Tool> = new Set(['edit_page', 'edit_database', 'configure_database_view', 'create_page', 'save_page_component', 'layout_rules', 'open_task_database']);

/** A page write the first run made wait: it runs once the first run finishes. */
export function isHeldForFirstRun(tool: ToolCallState): boolean {
  const name = normalizeTurnToolName(tool.title, TOOLS) as Tool | null;
  return !!name && WRITE_TOOLS.has(name) && !!tool.output?.includes(HELD);
}

/**
 * One line for a Meta agent tool call in the window ("Read Home · 6 blocks",
 * "Write rabbitholes · 进展"), or null to keep the generic row.
 */
export function metaAgentToolLine(tool: ToolCallState, names: ToolLineNames): string | null {
  const name = normalizeTurnToolName(tool.title, TOOLS) as Tool | null;
  if (!name) return null;
  const input = parse(tool.inputJson);
  const done = tool.status === 'completed';
  const workspace = () => {
    const id = str(input.workspaceId);
    return id ? names.workspace(id) ?? 'a workspace' : null;
  };
  const pageTitle = (fallbackKeys: readonly string[] = ['title']) => {
    const id = str(input.pageId) ?? str(input.databaseId) ?? str(input.parentId);
    const fromAnswer = done ? answer(tool, fallbackKeys) : null;
    return (id ? names.page(id) : null) ?? str(fromAnswer?.title) ?? 'a page';
  };
  if (isHeldForFirstRun(tool)) {
    const what = name === 'create_page' ? `Create ${clip(str(input.title) ?? 'a page')}`
      : name === 'save_page_component' ? 'Save component'
        : name === 'open_task_database' ? join('Open the task database', workspace())
          : `Write ${clip(pageTitle())}`;
    return join(what, 'held until the first run finishes');
  }
  switch (name) {
    case 'list_pages': return join('List pages', workspace(), done && count(tool, ['items']) !== null && plural(count(tool, ['items'])!, 'page'));
    case 'read_page': {
      const blocks = done ? count(tool, ['blocks']) : null;
      return join(`Read ${clip(pageTitle(['blocks']))}`, blocks !== null && plural(blocks, 'block'));
    }
    case 'read_database': return join(`Read ${clip(pageTitle(['rows']))}`, done && count(tool, ['rows']) !== null && plural(count(tool, ['rows'])!, 'row'));
    case 'edit_page':
    case 'edit_database':
    case 'configure_database_view': {
      const receipt = done ? parseTurnPageReceipt(tool, 'local') : null;
      const title = clip(receipt?.title ?? pageTitle());
      if (!receipt) return `Write ${title}`;
      const tasks = receipt.tasks ? taskStepCounts(receipt.tasks) : null;
      if (tasks) return join(`Write ${title}`, tasks, receipt.proposedCount > 0 && plural(receipt.proposedCount, 'suggestion'));
      const labels = [...new Set(receipt.changes.map((change) => change.label).filter((label): label is string => !!label))];
      const what = labels.length ? labels.slice(0, 2).map((label) => clip(label, 20)).join(', ') : null;
      if (receipt.appliedCount === 0 && receipt.proposedCount > 0) {
        return join(`Suggest ${title}`, what, plural(receipt.proposedCount, 'suggestion'));
      }
      return join(`Write ${title}`, what ?? plural(receipt.appliedCount, 'change'));
    }
    case 'open_task_database': {
      const made = done && answer(tool, ['created'])?.created === true;
      return join(made ? 'Create the task database' : 'Open the task database', workspace());
    }
    case 'list_tasks': {
      const ids = Array.isArray(input.workspaceIds) ? input.workspaceIds.filter((id): id is string => typeof id === 'string' && !!id) : [];
      const where = ids.length === 1 ? names.workspace(ids[0]!) ?? 'a workspace' : ids.length > 1 ? plural(ids.length, 'workspace') : null;
      const statuses = Array.isArray(input.statuses)
        ? input.statuses.filter((value): value is string => typeof value === 'string').map((value) => STATUS_NAMES.get(value) ?? value).join(', ')
        : null;
      const query = str(input.query);
      const n = done ? count(tool, ['items']) : null;
      return join('List tasks', where, input.needsYou === true && 'waiting on you', statuses, query && `“${clip(query, 24)}”`, n !== null && plural(n, 'task'));
    }
    case 'create_page': return join(`Create ${clip(str(input.title) ?? 'a page')}`, workspace());
    case 'list_page_components': return join('List components', workspace());
    case 'read_page_component': return join('Read component', workspace());
    case 'save_page_component': return join('Save component', workspace());
    case 'layout_rules': {
      const result = done ? answer(tool, ['layoutRules']) : null;
      const page = result?.page && typeof result.page === 'object' ? str((result.page as Record<string, unknown>).title) : null;
      const title = clip((str(input.pageId) ? names.page(str(input.pageId)!) : null) ?? page ?? 'a page');
      const list = result?.layoutRules;
      const rules = Array.isArray(list) ? list.length : null;
      if (input.action === 'add') return join(`Write ${title}`, '1 layout rule');
      if (input.action === 'remove') return join(`Write ${title}`, 'layout rule removed');
      return join(`Read ${title}`, rules !== null && plural(rules, 'layout rule'));
    }
    case 'read_conversation_updates': {
      const n = done ? count(tool, ['updates', 'conversations', 'items']) : null;
      return join('Read new conversations', workspace(), n !== null && plural(n, 'conversation'));
    }
    case 'start_conversation': return join('New conversation', workspace(), 'your settings');
    case 'list_workspaces': return join('List workspaces', done && count(tool, ['workspaces']) !== null && plural(count(tool, ['workspaces'])!, 'workspace'));
    case 'list_threads': return join('List conversations', workspace(), done && count(tool, ['threads']) !== null && plural(count(tool, ['threads'])!, 'conversation'));
    case 'search_messages': {
      const query = str(input.query);
      const n = done ? count(tool, ['results', 'matches', 'messages']) : null;
      return join(`Search ${query ? `“${clip(query, 24)}”` : 'messages'}`, workspace(), n !== null && plural(n, 'match', 'matches'));
    }
    case 'read_node':
    case 'read_node_overview': {
      const title = done ? str(answer(tool, ['title'])?.title) : null;
      return `Read ${title ? `“${clip(title)}”` : 'a conversation'}`;
    }
    case 'list_panes': return join('List panes', workspace());
    case 'inspect_pane':
    case 'wait_pane':
    case 'read_pane_output': return 'Check a running conversation';
    case 'michi_docs': return 'Read Michi docs';
  }
}
