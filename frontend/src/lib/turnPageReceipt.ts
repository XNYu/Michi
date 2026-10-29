import { blockShowsTaskBoard } from 'michi-shared';
import { backendEntityId } from '../config/backendIdentity';
import { notifyPageChanged } from '../state/pages/pageEvents';

const PAGE_TOOLS = ['edit_page', 'edit_database', 'create_page', 'create_database', 'configure_database', 'configure_database_view'] as const;
export type PageWriteTool = typeof PAGE_TOOLS[number];

export interface TurnPageInvalidation {
  resourceKind: 'page' | 'database' | 'component';
  resourceId: string;
  workspaceId?: string;
  revision?: number;
  viewVersion?: number;
  commitStatus?: string;
}

export interface TurnPageReceipt extends TurnPageInvalidation {
  tool: PageWriteTool;
  resourceKind: 'page' | 'database';
  resourceId: string;
  /** The resource's workspace when the receipt names it (the Meta agent writes outside its own chat's workspace). */
  workspaceId?: string;
  originatingPageId?: string;
  originatingPageIds: string[];
  title: string;
  created: boolean;
  appliedCount: number;
  proposedCount: number;
  affectedTargetIds: string[];
  batchId?: string;
  /** The change records the write made, applied and proposed. */
  changes: TurnPageChangeRef[];
  /** A write to a task database: the tasks it added, updated and removed. */
  tasks?: TaskWriteCounts;
  /** The write put a task board on the page; set even when its change records were cut off. */
  taskBoard?: true;
  /** Recovered from cut-off output: the change records are unknown, only the receipt itself is. */
  partial?: true;
}

export interface TurnPageChangeRef {
  id: string;
  seq: number;
  proposed: boolean;
  /** A short name for the changed block or row, when it has one. */
  label: string | null;
  /** The change put a task board on the page, alone or inside a container. */
  taskBoard?: true;
}

/** What a write to a task database did to its tasks (agents/pageTools.ts). */
export interface TaskWriteCounts { added: number; updated: number; removed: number }

const invalidatedReceipts = new Set<string>();
const invalidatedVersions = new Map<string, number>();

/** Invalidate the exact native resource once per durable tool call identity. */
export function invalidateTurnPageReceipt(
  receipt: TurnPageInvalidation,
  identity: { backendConnectionId: string; workspaceId: string; nodeId?: string; turnId?: string },
  toolCallId: string,
): void {
  const workspaceId = receipt.workspaceId ?? identity.workspaceId;
  if (receipt.commitStatus && !['committed', 'partial', 'proposed', 'unchanged'].includes(receipt.commitStatus)) return;
  const scope = JSON.stringify([identity.backendConnectionId, workspaceId, identity.nodeId, identity.turnId, receipt.resourceKind, receipt.resourceId]);
  const version = receipt.viewVersion ?? receipt.revision;
  if (version !== undefined) {
    const key = `${scope}:${receipt.viewVersion === undefined ? 'revision' : 'view'}`;
    if ((invalidatedVersions.get(key) ?? -1) >= version) return;
    invalidatedVersions.set(key, version);
    if (invalidatedVersions.size > 2_000) invalidatedVersions.delete(invalidatedVersions.keys().next().value!);
  } else {
    const key = JSON.stringify([scope, toolCallId]);
    if (invalidatedReceipts.has(key)) return;
    invalidatedReceipts.add(key);
    if (invalidatedReceipts.size > 2_000) invalidatedReceipts.delete(invalidatedReceipts.values().next().value!);
  }
  notifyPageChanged({
    backendConnectionId: identity.backendConnectionId,
    workspaceId,
    ...(receipt.resourceKind === 'page' ? { pageId: receipt.resourceId, ...(receipt.viewVersion === undefined ? {} : { viewVersion: receipt.viewVersion }) }
      : receipt.resourceKind === 'database' ? { databaseId: receipt.resourceId } : { componentId: receipt.resourceId }),
  });
}

export function resetTurnPageReceiptInvalidationForTests(): void { invalidatedReceipts.clear(); invalidatedVersions.clear(); }

function toolMatch(title: string | undefined, names: readonly string[]): string | null {
  const normalized = (title ?? '').trim().toLowerCase();
  if (!normalized) return null;
  for (const name of names) {
    if (normalized === name || normalized.endsWith(`/${name}`) || normalized.endsWith(`.${name}`)
      || normalized.endsWith(`:${name}`) || normalized.endsWith(`__${name}`)
      || normalized.endsWith(`____${name}`)) return name;
  }
  return null;
}

/** Shared tool-name recognition for Michi and native page receipts. */
export function normalizeTurnToolName(title: string | undefined, names: readonly string[]): string | null {
  return toolMatch(title, names);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Flatten JSON/MCP content envelopes and JSON text blocks without losing the raw output string. */
export function normalizeToolResultEnvelope(output: string | undefined): unknown[] {
  if (!output) return [];
  const roots = [parseJson(output.trim())];
  const result: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (value === undefined || depth > 6 || seen.has(value)) return;
    if (typeof value === 'object' && value !== null) seen.add(value);
    result.push(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    for (const key of ['content', 'structuredContent', 'details', 'result', 'michiPageWrite', 'items', 'Json']) {
      const child = row[key];
      if (typeof child === 'string') visit(parseJson(child.trim()), depth + 1);
      else visit(child, depth + 1);
    }
    if (typeof row.text === 'string') visit(parseJson(row.text.trim()), depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return result;
}

function findPageWrite(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPageWrite(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  if (row.kind === 'michiPageWrite') return row;
  for (const key of ['michiPageWrite', 'structuredContent', 'details', 'result', 'content', 'items', 'Json']) {
    const item = row[key];
    if (typeof item === 'string') {
      const found = findPageWrite(parseJson(item.trim()), depth + 1);
      if (found) return found;
    } else {
      const found = findPageWrite(item, depth + 1);
      if (found) return found;
    }
  }
  if (typeof row.text === 'string') return findPageWrite(parseJson(row.text.trim()), depth + 1);
  return null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function numberField(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0; }
function versions(raw: Record<string, unknown>): Pick<TurnPageInvalidation, 'revision' | 'viewVersion' | 'commitStatus'> {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return {
    ...(valid(raw.revision) ? { revision: raw.revision } : {}),
    ...(valid(raw.viewVersion) ? { viewVersion: raw.viewVersion } : {}),
    ...(typeof raw.commitStatus === 'string' ? { commitStatus: raw.commitStatus } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstLine(text: string): string {
  const line = text.split('\n')
    .map((l) => l.replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, '').replace(/\*\*|__|`/g, '').trim())
    .find(Boolean) ?? '';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

function changeLabel(change: Record<string, unknown>, taskRows: boolean): string | null {
  for (const key of ['after', 'before']) {
    const snapshot = record(change[key]);
    const block = record(snapshot?.block);
    if (block) {
      if (typeof block.title === 'string' && block.title.trim()) return firstLine(block.title);
      if (typeof block.text === 'string' && block.text.trim()) return firstLine(block.text) || null;
      if (block.type === 'task-view') return 'Task board';
    }
    const values = record(record(snapshot?.row)?.values);
    // A task goes by its Task cell, whatever order its cells were written in.
    if (taskRows && typeof values?.task === 'string' && values.task.trim()) return firstLine(values.task);
    const first = values ? Object.values(values).find((value) => typeof value === 'string' && value.trim()) : undefined;
    if (typeof first === 'string') return firstLine(first);
  }
  return null;
}

/** A change that put a task board on the page: an inserted block that shows one, or a container that now shows one and did not. */
function addsTaskBoard(change: Record<string, unknown>): boolean {
  const after = record(record(change.after)?.block);
  if (!after || !blockShowsTaskBoard(after)) return false;
  if (change.op === 'insert') return true;
  const before = record(record(change.before)?.block);
  return change.op === 'update' && !!before && !blockShowsTaskBoard(before);
}

function writeChanges(values: unknown[], taskRows: boolean): TurnPageChangeRef[] {
  const parent = values.map(record).find((row) => record(row?.michiPageWrite)?.kind === 'michiPageWrite' && record(row?.result));
  const result = record(parent?.result);
  if (!result) return [];
  const list = (key: 'applied' | 'proposed') => (Array.isArray(result[key]) ? result[key] as unknown[] : [])
    .map(record)
    .flatMap((change): TurnPageChangeRef[] => (change && typeof change.id === 'string' && change.id
      ? [{
        id: change.id, seq: typeof change.seq === 'number' ? change.seq : 0, proposed: key === 'proposed', label: changeLabel(change, taskRows),
        ...(addsTaskBoard(change) ? { taskBoard: true as const } : {}),
      }]
      : []));
  return [...list('applied'), ...list('proposed')];
}

function taskCounts(value: unknown): TaskWriteCounts | undefined {
  const counts = record(value);
  return counts ? { added: numberField(counts.added), updated: numberField(counts.updated), removed: numberField(counts.removed) } : undefined;
}

const PAGE_WRITE_MARKERS = ['"michiPageWrite":{', '\\"michiPageWrite\\":{', '\\\\\\"michiPageWrite\\\\\\":{'];

/** Undo one level of JSON string escaping; a cut-off tail is fine. */
function unescapeJsonString(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, code: string) => {
    if (code[0] === 'u' && code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[code] ?? code;
  });
}

/** The text of the object starting at text[0] === '{', or null when it is cut off before closing. */
function balancedObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

/** What may precede the receipt's `{`: only the envelope keys of a runtime's result wrapper, so the receipt is the payload's first key. */
const WRAPPER_PREFIX = /^(?:[[\]{},:"]|content|items|Json|type|text)*$/;

/**
 * Runtimes cut tool output at 16 KB, which leaves invalid JSON. The backend
 * writes michiPageWrite as the payload's first key, so its object is usually
 * still whole: find it in the raw text, plain or inside one or two levels of
 * JSON string escaping. A marker counts only when nothing but a wrapper
 * envelope precedes it and `result` (or the end) follows it; a receipt quoted
 * inside page text, or an older payload that put it last, is never trusted.
 */
function salvagePageWrite(output: string): Record<string, unknown> | null {
  for (let level = 0; level < PAGE_WRITE_MARKERS.length; level += 1) {
    const marker = PAGE_WRITE_MARKERS[level]!;
    for (let index = output.indexOf(marker); index >= 0; index = output.indexOf(marker, index + 1)) {
      if (index === 0 || output[index - 1] !== '{') continue;
      if (!WRAPPER_PREFIX.test(output.slice(0, index - 1).replace(/\\/g, ''))) continue;
      let text = output.slice(index + marker.length - 1);
      for (let i = 0; i < level; i += 1) text = unescapeJsonString(text);
      const object = balancedObject(text);
      if (!object) continue;
      const rest = text.slice(object.length);
      const leads = rest === '' || rest[0] === '}' || rest.startsWith(',"result":') || ',"result":'.startsWith(rest);
      const parsed = leads ? record(parseJson(object)) : null;
      if (parsed?.kind === 'michiPageWrite') return parsed;
    }
  }
  return null;
}

/** Parse only completed tool calls. The original output remains in ToolCallState unchanged. */
export function parseTurnPageReceipt(
  tool: { title?: string; status?: string; output?: string },
  backendConnectionId: string,
): TurnPageReceipt | null {
  if (tool.status !== 'completed') return null;
  const name = toolMatch(tool.title, PAGE_TOOLS) as PageWriteTool | null;
  if (!name || !tool.output) return null;
  const values = normalizeToolResultEnvelope(tool.output);
  const whole = values.map((value) => findPageWrite(value)).find(Boolean);
  const raw = whole ?? salvagePageWrite(tool.output);
  if (!raw || (raw.resourceKind !== 'page' && raw.resourceKind !== 'database')) return null;
  const resourceId = stringField(raw.resourceId);
  if (!resourceId) return null;
  const mapId = (id: string) => backendEntityId(backendConnectionId, id);
  const title = stringField(raw.title) ?? 'Untitled page';
  const workspaceId = stringField(raw.workspaceId);
  const batchId = stringField(raw.batchId);
  const originatingPageId = stringField(raw.originatingPageId);
  const tasks = taskCounts(raw.tasks);
  const originatingPageIds = Array.isArray(raw.originatingPageIds)
    ? raw.originatingPageIds.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  return {
    tool: name,
    ...versions(raw),
    resourceKind: raw.resourceKind,
    resourceId: mapId(resourceId),
    ...(workspaceId ? { workspaceId: mapId(workspaceId) } : {}),
    ...(originatingPageId ? { originatingPageId: mapId(originatingPageId) } : {}),
    originatingPageIds: originatingPageIds.map(mapId),
    title,
    created: raw.created === true,
    appliedCount: numberField(raw.appliedCount),
    proposedCount: numberField(raw.proposedCount),
    // Block and row IDs are opaque inside their owning resource. Only the
    // resource and page references above receive backend identity mapping.
    affectedTargetIds: Array.isArray(raw.affectedTargetIds)
      ? raw.affectedTargetIds.filter((id): id is string => typeof id === 'string' && !!id)
      : [],
    ...(batchId ? { batchId } : {}),
    ...(tasks ? { tasks } : {}),
    ...(raw.taskBoard === true ? { taskBoard: true as const } : {}),
    changes: writeChanges(values, !!tasks),
    ...(whole ? {} : { partial: true as const }),
  };
}

/** "Created 5 tasks, updated 2, removed 1": what a write did to a task database; null when it applied nothing. */
export function taskWriteLine(tasks: TaskWriteCounts): string | null {
  const parts: string[] = [];
  const add = (count: number, verb: string) => {
    if (count <= 0) return;
    parts.push(parts.length ? `${verb.toLowerCase()} ${count}` : `${verb} ${count} ${count === 1 ? 'task' : 'tasks'}`);
  };
  add(tasks.added, 'Created');
  add(tasks.updated, 'Updated');
  add(tasks.removed, 'Removed');
  return parts.length ? parts.join(', ') : null;
}

/** The page a reply put a task board on: where its task writes open while no page showed their tasks yet. */
export function putsTaskBoard(receipt: TurnPageReceipt): boolean {
  return receipt.taskBoard === true || receipt.changes.some((change) => change.taskBoard && !change.proposed);
}

/** Only a board in the same workspace counts: the Meta agent organizes several in one reply. Ordinary chats have none named. */
export function taskBoardPageId(receipts: readonly TurnPageReceipt[], workspaceId: string | undefined): string | null {
  return receipts.find((receipt) => receipt.resourceKind === 'page' && receipt.workspaceId === workspaceId && putsTaskBoard(receipt))?.resourceId ?? null;
}

/** Component saves refresh their hosts too, without masquerading as page cards; a new task database refreshes its workspace's boards. */
export function parseTurnPageInvalidation(tool: { title?: string; status?: string; output?: string }, backendConnectionId: string): TurnPageInvalidation | null {
  const receipt = parseTurnPageReceipt(tool, backendConnectionId);
  if (receipt) return receipt;
  if (tool.status !== 'completed') return null;
  if (toolMatch(tool.title, ['open_task_database'])) return openedTaskDatabase(tool.output, backendConnectionId);
  if (!toolMatch(tool.title, ['save_page_component'])) return null;
  const raw = normalizeToolResultEnvelope(tool.output).map(value => findPageWrite(value)).find(Boolean);
  if (!raw || raw.resourceKind !== 'component' || !stringField(raw.resourceId)) return null;
  return {
    resourceKind: 'component', resourceId: backendEntityId(backendConnectionId, raw.resourceId as string),
    ...(stringField(raw.workspaceId) ? { workspaceId: backendEntityId(backendConnectionId, raw.workspaceId as string) } : {}),
    ...versions(raw),
  };
}

/** A task database open_task_database just made: the boards of its workspace that offered "Create one" read it again. */
function openedTaskDatabase(output: string | undefined, backendConnectionId: string): TurnPageInvalidation | null {
  const opened = normalizeToolResultEnvelope(output).map(record).find((value) => value?.kind === 'taskDatabase');
  const databaseId = stringField(opened?.databaseId);
  if (!opened || opened.created !== true || !databaseId) return null;
  const workspaceId = stringField(opened.workspaceId);
  return {
    resourceKind: 'database', resourceId: backendEntityId(backendConnectionId, databaseId),
    ...(workspaceId ? { workspaceId: backendEntityId(backendConnectionId, workspaceId) } : {}),
    ...versions(opened),
  };
}
