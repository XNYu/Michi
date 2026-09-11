import type {
  AgentRunAttemptDtoV1, AgentRunDtoV1, AgentRunEventV1, AgentRunInputRequestV1,
  AgentRunInteractionDtoV1, AgentRunListQueryV1, AgentRunWatchDtoV1,
  CancelAgentRunRequestV1, CreateAgentRunWatchRequestV1,
  RespondAgentRunInteractionRequestV1, SpawnAgentRunRequestV1,
  UpdateAgentRunWatchRequestV1,
} from 'michi-shared';
import {
  parseAgentRunAttemptDtoV1, parseAgentRunDtoV1, parseAgentRunEventV1,
  parseAgentRunInteractionDtoV1, parseAgentRunSseEnvelopeV1, parseAgentRunWatchDtoV1,
} from 'michi-shared';
import {
  backendApiBase, nodeBackendApiBase, workspaceBackendApiBase,
} from '../../config/backendConnections';
import {
  type AgentResourceIdentity, type LocatedAgentResource,
  backendConnectionIdFromApiBase, locatedAgentResource,
} from '../../state/agentIdentity';
import { readSseStream, SseHttpError } from './sseParser';
import { fetchStream } from './streamTransport';

export interface AgentRunDetailV1 {
  run: AgentRunDtoV1;
  attempts: AgentRunAttemptDtoV1[];
  events: AgentRunEventV1[];
  interactions: AgentRunInteractionDtoV1[];
}

export interface AgentRunRouteTarget {
  identity: AgentResourceIdentity;
  workspaceId: string;
  parentNodeId?: string | null;
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : `${operation} failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object' && name in value ? value[name as keyof typeof value] : value;
}

function arrayField(value: unknown, name: string): unknown[] {
  const candidate = field(value, name);
  if (!Array.isArray(candidate)) throw new Error(`${name} response is malformed`);
  return candidate;
}

function actionBase(target: AgentRunRouteTarget): string {
  return backendApiBase(target.identity.backendConnectionId);
}

export async function listAgentRuns(
  query: AgentRunListQueryV1,
  signal?: AbortSignal,
): Promise<Array<LocatedAgentResource<AgentRunDtoV1>>> {
  const base = workspaceBackendApiBase(query.workspaceId);
  const connectionId = backendConnectionIdFromApiBase(base);
  const params = new URLSearchParams({ workspaceId: query.workspaceId });
  query.statuses?.forEach((status) => params.append('status', status));
  if (query.q !== undefined) params.set('q', query.q);
  if (query.includeArchived !== undefined) params.set('includeArchived', String(query.includeArchived));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const payload = await jsonResponse(await fetch(`${base}/agent-runs?${params.toString()}`, { signal }), 'listAgentRuns');
  return arrayField(payload, 'runs').map((item, index) => locatedAgentResource(connectionId, parseAgentRunDtoV1(item, `runs[${index}]`)));
}

export async function spawnAgentRun(request: SpawnAgentRunRequestV1, signal?: AbortSignal): Promise<LocatedAgentResource<AgentRunDtoV1>> {
  const base = workspaceBackendApiBase(request.workspaceId);
  const connectionId = backendConnectionIdFromApiBase(base);
  if (request.parentNodeId) {
    const parentConnectionId = backendConnectionIdFromApiBase(nodeBackendApiBase(request.parentNodeId));
    if (parentConnectionId !== connectionId) {
      throw new Error('Parent conversation belongs to a different Backend than the Run Workspace.');
    }
  }
  const payload = await jsonResponse(await fetch(`${base}/agent-runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
  }), 'spawnAgentRun');
  return locatedAgentResource(connectionId, parseAgentRunDtoV1(field(payload, 'run')));
}

export async function getAgentRun(identity: AgentResourceIdentity, signal?: AbortSignal): Promise<LocatedAgentResource<AgentRunDtoV1>> {
  const payload = await jsonResponse(await fetch(`${backendApiBase(identity.backendConnectionId)}/agent-runs/${encodeURIComponent(identity.id)}`, { signal }), 'getAgentRun');
  return locatedAgentResource(identity.backendConnectionId, parseAgentRunDtoV1(field(payload, 'run')));
}

export async function getAgentRunDetail(identity: AgentResourceIdentity, signal?: AbortSignal): Promise<LocatedAgentResource<AgentRunDetailV1>> {
  const payload = await jsonResponse(await fetch(`${backendApiBase(identity.backendConnectionId)}/agent-runs/${encodeURIComponent(identity.id)}`, { signal }), 'getAgentRunDetail');
  if (!payload || typeof payload !== 'object') throw new Error('getAgentRunDetail returned a malformed payload');
  const detail = payload as Record<string, unknown>;
  const run = parseAgentRunDtoV1(field(detail, 'run'));
  const attempts = Array.isArray(detail.attempts) ? detail.attempts.map((attempt, index) => parseAgentRunAttemptDtoV1(attempt, `attempts[${index}]`)) : [];
  const events = Array.isArray(detail.events) ? detail.events.map((event: unknown, index: number) => parseAgentRunEventV1(event, `events[${index}]`)) : [];
  const interactions = Array.isArray(detail.interactions) ? detail.interactions.map((interaction, index) => parseAgentRunInteractionDtoV1(interaction, `interactions[${index}]`)) : [];
  return locatedAgentResource(identity.backendConnectionId, { run, attempts, events, interactions });
}

export async function getAgentRunEvents(identity: AgentResourceIdentity, afterSeq = -1, signal?: AbortSignal): Promise<AgentRunEventV1[]> {
  const events: AgentRunEventV1[] = [];
  let cursor = afterSeq;
  for (let page = 0; page < 100; page += 1) {
    const payload = await jsonResponse(await fetch(`${backendApiBase(identity.backendConnectionId)}/agent-runs/${encodeURIComponent(identity.id)}/events?afterSeq=${cursor}`, { signal }), 'getAgentRunEvents');
    const batch = arrayField(payload, 'events').map((event, index) => parseAgentRunEventV1(event, `events[${events.length + index}]`));
    events.push(...batch);
    if (batch.length < 1_000) return events;
    const nextCursor = batch.at(-1)!.seq;
    if (nextCursor <= cursor) throw new Error('getAgentRunEvents pagination did not advance');
    cursor = nextCursor;
  }
  throw new Error('getAgentRunEvents exceeded the bounded replay page limit');
}

export async function sendAgentRunInput(target: AgentRunRouteTarget, request: AgentRunInputRequestV1, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${actionBase(target)}/agent-runs/${encodeURIComponent(target.identity.id)}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!response.ok) throw new Error(`sendAgentRunInput failed: ${response.status}`);
}

export async function cancelAgentRun(target: AgentRunRouteTarget, request: CancelAgentRunRequestV1, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${actionBase(target)}/agent-runs/${encodeURIComponent(target.identity.id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!response.ok) throw new Error(`cancelAgentRun failed: ${response.status}`);
}

export async function respondAgentRunInteraction(target: AgentRunRouteTarget, interactionId: string, request: RespondAgentRunInteractionRequestV1, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${actionBase(target)}/agent-runs/${encodeURIComponent(target.identity.id)}/interactions/${encodeURIComponent(interactionId)}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!response.ok) throw new Error(`respondAgentRunInteraction failed: ${response.status}`);
}

export async function createAgentRunWatch(request: CreateAgentRunWatchRequestV1, signal?: AbortSignal): Promise<LocatedAgentResource<AgentRunWatchDtoV1>> {
  const base = workspaceBackendApiBase(request.workspaceId);
  const connectionId = backendConnectionIdFromApiBase(base);
  const payload = await jsonResponse(await fetch(`${base}/agent-run-watches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }), 'createAgentRunWatch');
  return locatedAgentResource(connectionId, parseAgentRunWatchDtoV1(field(payload, 'watch')));
}

export async function updateAgentRunWatch(identity: AgentResourceIdentity, request: UpdateAgentRunWatchRequestV1, signal?: AbortSignal): Promise<LocatedAgentResource<AgentRunWatchDtoV1>> {
  const payload = await jsonResponse(await fetch(`${backendApiBase(identity.backendConnectionId)}/agent-run-watches/${encodeURIComponent(identity.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }), 'updateAgentRunWatch');
  return locatedAgentResource(identity.backendConnectionId, parseAgentRunWatchDtoV1(field(payload, 'watch')));
}

export interface AgentRunSubscriptionOptions {
  cursors?: Record<string, number>;
  onEnvelope: (envelope: ReturnType<typeof parseAgentRunSseEnvelopeV1>) => void | Promise<void>;
  onMalformed?: (error: Error, rawData: string) => void;
  onOpen?: () => void;
  onDisconnect?: (error?: Error) => void;
}

export function subscribeAgentRuns(workspaceId: string, options: AgentRunSubscriptionOptions): () => void {
  const controller = new AbortController();
  let stopped = false;
  const base = workspaceBackendApiBase(workspaceId);
  const params = new URLSearchParams({ workspaceId, cursors: JSON.stringify(options.cursors ?? {}) });
  void (async () => {
    let disconnectError: Error | undefined;
    try {
      const response = await fetchStream(`${base}/agent-runs/subscribe?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) throw new SseHttpError(response.status, 'subscribeAgentRuns failed');
      if (!response.body) throw new Error('subscribeAgentRuns response has no body');
      options.onOpen?.();
      await readSseStream(response.body.getReader(), async (_event, data) => {
        try {
          const json: unknown = JSON.parse(data);
          await options.onEnvelope(parseAgentRunSseEnvelopeV1(json));
        } catch (error) {
          options.onMalformed?.(error instanceof Error ? error : new Error(String(error)), data);
        }
      }, { shouldStop: () => stopped });
    } catch (error) {
      if (!stopped) disconnectError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!stopped) options.onDisconnect?.(disconnectError);
    }
  })();
  // Observing is independent from execution: unsubscribe aborts only this GET.
  return () => { stopped = true; controller.abort(); };
}
