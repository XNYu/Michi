import type { Route } from '@playwright/test';
import type { MemoryChangedEvent, MemoryMode, MemoryRecord, MemoryScope } from '../../shared/src/memory';

/**
 * Browser-only Michi Memory: /api/memories, /api/memory-settings, the change
 * feed and automatic memory's status, answered from an in-memory list.
 * installMockApi uses an empty instance by default; a spec that needs data
 * seeds its own and passes `handle` as `custom`. No backend or SQLite.
 *
 * The change feed answers each request at once with the changes queued by
 * `announce` and then ends, so the app reconnects (after its backoff) for the
 * next ones; nothing is sent twice.
 */
export interface MemoryMockOptions {
  records?: MemoryRecord[];
  mode?: MemoryMode;
  /** Automatic memory's status; omitted answers 404, as a backend without it does. */
  extraction?: Record<string, unknown>;
}

export interface MemoryMockController {
  handle(route: Route): Promise<boolean>;
  /** The stored memories, as the last request left them. */
  readonly records: MemoryRecord[];
  /** Every write this controller answered, as `METHOD /path`. */
  readonly writes: string[];
  /** Queues changes for the next change feed request. */
  announce(...events: MemoryChangedEvent[]): void;
  /** How many times the change feed was opened. */
  feedRequests(): number;
}

export function memoryRecord(id: string, body: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id, ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body, source: null, status: 'active',
    origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: now, updatedAt: now - 60_000, ...overrides,
  };
}

export function memoryChange(record: MemoryRecord, action: MemoryChangedEvent['action'] = 'created'): MemoryChangedEvent {
  return {
    ownerUserId: record.ownerUserId, workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    memoryId: record.id, action, status: record.status, body: record.body, origin: record.origin,
    ...(record.source?.nodeId ? { nodeId: record.source.nodeId } : {}), supersedesId: record.supersedesId,
  };
}

const json = (route: Route, value: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(value),
});

export function createMemoryMock(options: MemoryMockOptions = {}): MemoryMockController {
  const state = { records: [...(options.records ?? [])], mode: options.mode ?? 'explicit' as MemoryMode };
  const writes: string[] = [];
  let queued: MemoryChangedEvent[] = [];
  let feeds = 0;
  let next = 1;

  const find = (id: string) => state.records.find((record) => record.id === id);
  const notFound = (route: Route) => json(route, { error: 'Memory not found', code: 'not_found' }, 404);

  async function handle(route: Route): Promise<boolean> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*?\/api/, '');
    const method = request.method();
    if (path !== '/memory-settings' && path !== '/memories' && !path.startsWith('/memories/') && !path.startsWith('/memory-extraction/')) return false;
    if (method !== 'GET') writes.push(`${method} ${path}`);

    if (method === 'GET' && path === '/memories/changes/stream') {
      feeds += 1;
      const body = queued.map((event) => `event: memory_changed\ndata: ${JSON.stringify(event)}\n\n`).join('');
      queued = [];
      await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, body: `: connected\n\n${body}` });
      return true;
    }
    if (path === '/memory-settings') {
      if (method === 'PUT') state.mode = (request.postDataJSON() as { mode: MemoryMode }).mode;
      await json(route, { mode: state.mode });
      return true;
    }
    if (path.startsWith('/memory-extraction/')) {
      if (!options.extraction) { await json(route, { error: 'not found' }, 404); return true; }
      if (method === 'POST') options.extraction.paused = path.endsWith('/pause');
      await json(route, options.extraction);
      return true;
    }
    if (method === 'GET' && path === '/memories') {
      const statuses = (url.searchParams.get('status') ?? 'active,pending').split(',');
      const scope = url.searchParams.get('scope');
      const workspaceId = url.searchParams.get('workspaceId');
      const q = url.searchParams.get('q');
      const items = state.records
        .filter((record) => statuses.includes(record.status))
        .filter((record) => scope !== 'user' || record.scope.kind === 'user')
        .filter((record) => scope !== 'workspace' || (record.scope.kind === 'workspace' && (!workspaceId || record.scope.workspaceId === workspaceId)))
        .filter((record) => !q || record.body.includes(q))
        .sort((a, b) => b.createdAt - a.createdAt);
      await json(route, { items, nextCursor: null });
      return true;
    }
    if (method === 'POST' && path === '/memories') {
      const input = request.postDataJSON() as { scope: MemoryScope; kind: MemoryRecord['kind']; body: string };
      const record = memoryRecord(`mem-added-${next++}`, input.body.trim(), { scope: input.scope, kind: input.kind });
      state.records.push(record);
      await json(route, { memory: record }, 201);
      return true;
    }
    const match = /^\/memories\/([^/]+)(?:\/(approve|reject))?$/.exec(path);
    if (!match) return false;
    const record = find(decodeURIComponent(match[1]));
    if (!record) { await notFound(route); return true; }
    if (method === 'PATCH' && !match[2]) {
      const patch = request.postDataJSON() as { body?: string; scope?: MemoryScope; expectedVersion: number };
      if (patch.expectedVersion !== record.version) {
        await json(route, { error: 'The memory changed since it was read', code: 'version_conflict', currentVersion: record.version }, 409);
        return true;
      }
      if (patch.body !== undefined) record.body = patch.body;
      if (patch.scope) record.scope = patch.scope;
      record.version += 1;
      record.updatedAt = Date.now();
      await json(route, { memory: record });
      return true;
    }
    if ((method === 'DELETE' && !match[2]) || (method === 'POST' && match[2] === 'reject')) {
      state.records = state.records.filter((item) => item !== record);
      await route.fulfill({ status: 204, body: '' });
      return true;
    }
    if (method === 'POST' && match[2] === 'approve') {
      record.status = 'active';
      record.version += 1;
      await json(route, { memory: record });
      return true;
    }
    return false;
  }

  return {
    handle,
    get records() { return state.records; },
    writes,
    announce(...events) { queued.push(...events); },
    feedRequests: () => feeds,
  };
}
