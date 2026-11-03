import type { MaintenancePlan, MaintenanceWorkspaceResponse, MetaAgentRoundStatus, MetaAgentRunNowResponse } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, serverEntityId } from '../../config/backendIdentity';
import { pagesFetch, readPagesJson } from './pages';

export type PageMaintenanceWorkspace = MaintenanceWorkspaceResponse;

export interface PageMaintenanceIdentity {
  backendConnectionId: string;
  workspaceId: string;
  signal?: AbortSignal;
}

/** The runtime is not part of it: maintenance runs on the Meta agent's settings. */
export interface PageMaintenanceConfigPatch {
  expectedRevision?: number;
  enabled?: boolean;
  paused?: boolean;
}

function serverId(id: string, connectionId: string): string {
  return serverEntityId(id, connectionId);
}

function pathId(id: string, connectionId: string): string {
  return encodeURIComponent(serverId(id, connectionId));
}

function base(connectionId: string): string {
  return backendApiBase(connectionId);
}

function mapPlanIdentity(plan: MaintenancePlan, connectionId: string): MaintenancePlan {
  const fromServer = (id: string) => backendEntityId(connectionId, id);
  return {
    ...plan,
    id: fromServer(plan.id),
    workspaceId: fromServer(plan.workspaceId),
    jobId: fromServer(plan.jobId),
    runId: plan.runId ? fromServer(plan.runId) : null,
    reconsiderOfPlanId: plan.reconsiderOfPlanId ? fromServer(plan.reconsiderOfPlanId) : null,
    sources: plan.sources.map((source) => ({
      ...source,
      evidence: { ...source.evidence, nodeId: fromServer(source.evidence.nodeId) },
      manifest: source.manifest.map((resource) => ({ ...resource, id: fromServer(resource.id), pageIds: resource.pageIds.map(fromServer) })),
      candidates: source.candidates.map((resource) => ({ ...resource, id: fromServer(resource.id), pageIds: resource.pageIds.map(fromServer) })),
    })),
  };
}

async function request<T>(url: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await pagesFetch(url, {
    ...(options.method ? { method: options.method } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body),
    }),
  });
  const payload = await readPagesJson(response).catch(() => null);
  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
    const details = envelope && typeof envelope === 'object' ? envelope as { code?: unknown; message?: unknown } : {};
    throw new Error(typeof details.message === 'string' ? details.message : `Page maintenance request failed (${response.status})`);
  }
  return payload as T;
}

function mapWorkspaceIdentity(value: PageMaintenanceWorkspace, connectionId: string): PageMaintenanceWorkspace {
  const fromServer = (id: string) => backendEntityId(connectionId, id);
  const config = value.config ? {
    ...value.config,
    workspaceId: fromServer(value.config.workspaceId),
    jobId: fromServer(value.config.jobId),
  } : null;
  const plans = (value.backlog?.plans ?? []).map((plan) => mapPlanIdentity(plan, connectionId));
  const job = value.job ? {
    ...value.job,
    id: fromServer(value.job.id),
    workspaceId: fromServer(value.job.workspaceId),
    persistentNodeId: value.job.persistentNodeId ? fromServer(value.job.persistentNodeId) : null,
    activeRunId: value.job.activeRunId ? fromServer(value.job.activeRunId) : null,
  } : null;
  const lastRun = value.status?.lastRun ? {
    ...value.status.lastRun,
    id: fromServer(value.status.lastRun.id),
    jobId: fromServer(value.status.lastRun.jobId),
    workspaceId: fromServer(value.status.lastRun.workspaceId),
    nodeId: value.status.lastRun.nodeId ? fromServer(value.status.lastRun.nodeId) : null,
    treeId: value.status.lastRun.treeId ? fromServer(value.status.lastRun.treeId) : null,
  } : null;
  return {
    ...value,
    config,
    job,
    ...(value.watches ? { watches: value.watches.map((watch) => ({ ...watch, id: fromServer(watch.id) })) } : {}),
    status: value.status ? { ...value.status, lastRun } : null,
    excludedSpaceIds: (value.excludedSpaceIds ?? []).map(fromServer),
    catchUpSuggestions: (value.catchUpSuggestions ?? []).map((suggestion) => ({
      ...suggestion,
      spaceId: fromServer(suggestion.spaceId),
      latestSources: suggestion.latestSources.map((source) => ({ ...source })),
    })),
    backlog: { ...value.backlog, plans },
  };
}

export async function getPageMaintenance(options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  const { backendConnectionId, workspaceId } = options;
  const answer = await request<PageMaintenanceWorkspace>(
    `${base(backendConnectionId)}/workspaces/${pathId(workspaceId, backendConnectionId)}/maintenance`,
    { signal: options.signal },
  );
  return mapWorkspaceIdentity(answer, backendConnectionId);
}

export async function updatePageMaintenance(patch: PageMaintenanceConfigPatch, options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  const answer = await request<PageMaintenanceWorkspace>(
    `${base(options.backendConnectionId)}/workspaces/${pathId(options.workspaceId, options.backendConnectionId)}/maintenance`,
    { method: 'PATCH', body: patch, signal: options.signal },
  );
  return mapWorkspaceIdentity(answer, options.backendConnectionId);
}

export async function setPageMaintenanceSpaceExcluded(
  spaceId: string,
  excluded: boolean,
  expectedRevision: number | undefined,
  options: PageMaintenanceIdentity,
): Promise<PageMaintenanceWorkspace> {
  const revision = expectedRevision ?? (await getPageMaintenance(options)).config?.revision ?? 0;
  const answer = await request<PageMaintenanceWorkspace>(
    `${base(options.backendConnectionId)}/workspaces/${pathId(options.workspaceId, options.backendConnectionId)}/spaces/${pathId(spaceId, options.backendConnectionId)}/maintenance`,
    { method: 'PATCH', body: { expectedRevision: revision, excluded }, signal: options.signal },
  );
  return mapWorkspaceIdentity(answer, options.backendConnectionId);
}

export interface MaintenanceWatchInput {
  title: string;
  instructions: string;
  intervalMinutes: number;
  enabled?: boolean;
}

function maintenanceUrl(options: PageMaintenanceIdentity, rest = ''): string {
  return `${base(options.backendConnectionId)}/workspaces/${pathId(options.workspaceId, options.backendConnectionId)}/maintenance${rest}`;
}

function watchUrl(watchId: string, options: PageMaintenanceIdentity, rest = ''): string {
  return maintenanceUrl(options, `/watches/${pathId(watchId, options.backendConnectionId)}${rest}`);
}

async function workspaceRequest(url: string, options: PageMaintenanceIdentity, init: { method: string; body?: unknown }): Promise<PageMaintenanceWorkspace> {
  const answer = await request<PageMaintenanceWorkspace>(url, { ...init, signal: options.signal });
  return mapWorkspaceIdentity(answer, options.backendConnectionId);
}

/** expectedRevision 0 saves the first instructions. */
export function saveMaintenanceInstructions(text: string, expectedRevision: number, options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  return workspaceRequest(maintenanceUrl(options, '/instructions'), options, { method: 'PUT', body: { expectedRevision, text } });
}

export function createMaintenanceWatch(input: MaintenanceWatchInput, options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  return workspaceRequest(maintenanceUrl(options, '/watches'), options, { method: 'POST', body: input });
}

export function updateMaintenanceWatch(watchId: string, patch: Partial<MaintenanceWatchInput> & { expectedRevision: number }, options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  return workspaceRequest(watchUrl(watchId, options), options, { method: 'PATCH', body: patch });
}

export function deleteMaintenanceWatch(watchId: string, options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  return workspaceRequest(watchUrl(watchId, options), options, { method: 'DELETE' });
}

/** Makes the watch due now; it runs as soon as the workspace's maintenance is free. */
export function runMaintenanceWatch(watchId: string, options: PageMaintenanceIdentity): Promise<PageMaintenanceWorkspace> {
  return workspaceRequest(watchUrl(watchId, options, '/run'), options, { method: 'POST', body: {} });
}

export async function runPageMaintenanceNow(options: PageMaintenanceIdentity): Promise<{ run: unknown }> {
  return request(`${base(options.backendConnectionId)}/workspaces/${pathId(options.workspaceId, options.backendConnectionId)}/maintenance/run`, {
    method: 'POST', body: {}, signal: options.signal,
  });
}

/** One Meta agent round on this connection's backend now: one bounded page per maintained workspace. */
export async function runMetaAgentRoundNow(connectionId: string, signal?: AbortSignal): Promise<MetaAgentRunNowResponse> {
  const answer = await request<MetaAgentRunNowResponse>(`${base(connectionId)}/meta-agent/run-now`, { method: 'POST', body: {}, signal });
  return {
    workspaces: answer.workspaces.map((row) => ({
      ...row,
      workspaceId: backendEntityId(connectionId, row.workspaceId),
      ...(row.runId ? { runId: backendEntityId(connectionId, row.runId) } : {}),
    })),
  };
}

export async function fetchMetaAgentRound(connectionId: string, signal?: AbortSignal): Promise<MetaAgentRoundStatus> {
  const answer = await request<MetaAgentRoundStatus>(`${base(connectionId)}/meta-agent/run-now`, { signal });
  return { workspaces: answer.workspaces.map((row) => ({ ...row, workspaceId: backendEntityId(connectionId, row.workspaceId) })) };
}

export async function reconsiderPageMaintenanceSources(
  planId: string,
  sourceTurnIds: string[],
  expectedRevision: number,
  options: PageMaintenanceIdentity,
): Promise<{ plan: MaintenancePlan }> {
  const answer = await request<{ plan: MaintenancePlan }>(
    `${base(options.backendConnectionId)}/workspaces/${pathId(options.workspaceId, options.backendConnectionId)}/maintenance/plans/${pathId(planId, options.backendConnectionId)}/reconsider`,
    { method: 'POST', body: { expectedRevision, sourceTurnIds: sourceTurnIds.map((id) => serverId(id, options.backendConnectionId)) }, signal: options.signal },
  );
  return { plan: mapPlanIdentity(answer.plan, options.backendConnectionId) };
}

export async function queuePageMaintenanceCatchUp(
  spaceId: string,
  after: number,
  through: number,
  options: PageMaintenanceIdentity,
): Promise<{ requestId: string; after: number; through: number; queued: true }> {
  const current = await getPageMaintenance(options);
  if (!current.config) throw new Error('Enable maintenance before catching up past conversations.');
  const answer = await request<{ requestId: string; after: number; through: number; queued: true }>(
    `${base(options.backendConnectionId)}/workspaces/${pathId(options.workspaceId, options.backendConnectionId)}/maintenance/catch-up`,
    { method: 'POST', body: { expectedRevision: current.config.revision, spaceId: serverId(spaceId, options.backendConnectionId), after, through }, signal: options.signal },
  );
  return answer;
}
