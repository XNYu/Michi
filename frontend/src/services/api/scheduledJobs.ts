import type {
  ScheduledJobDto,
  ScheduledJobSessionMode,
  ScheduledJobInput,
  ScheduledJobPatch,
  ScheduledJobPreviewResponse,
  ScheduledJobRunDto,
  ScheduledJobSchedule,
  ScheduledJobsListResponse,
} from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';

/** Scheduled jobs live on the local backend only; jobs never target remote connections. */
function base(): string {
  return `${backendApiBase()}/scheduled-jobs`;
}

async function json<T>(response: Response, operation: string): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `${operation} failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export async function listScheduledJobs(signal?: AbortSignal): Promise<ScheduledJobsListResponse> {
  return json(await fetch(base(), { signal }), 'listScheduledJobs');
}

export async function createScheduledJob(input: ScheduledJobInput): Promise<ScheduledJobDto> {
  return json(await fetch(base(), { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }), 'createScheduledJob');
}

export async function updateScheduledJob(id: string, patch: ScheduledJobPatch): Promise<ScheduledJobDto> {
  return json(await fetch(`${base()}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch),
  }), 'updateScheduledJob');
}

export async function deleteScheduledJob(id: string): Promise<void> {
  await json(await fetch(`${base()}/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'deleteScheduledJob');
}

export async function runScheduledJobNow(id: string): Promise<ScheduledJobRunDto> {
  return json(await fetch(`${base()}/${encodeURIComponent(id)}/run`, { method: 'POST' }), 'runScheduledJobNow');
}

export async function cancelScheduledJobRun(id: string): Promise<{ cancelled: boolean }> {
  return json(await fetch(`${base()}/${encodeURIComponent(id)}/cancel`, { method: 'POST' }), 'cancelScheduledJobRun');
}

/** Explicit local recovery after the previous process and agent have stopped. */
export async function confirmScheduledExecutionStopped(runId: string): Promise<{ released: true }> {
  return json(await fetch(`${base()}/executions/${encodeURIComponent(runId)}/confirm-stopped`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ executionStopped: true }),
  }), 'confirmScheduledExecutionStopped');
}

export async function listScheduledJobRuns(id: string, signal?: AbortSignal): Promise<ScheduledJobRunDto[]> {
  const body = await json<{ runs: ScheduledJobRunDto[] }>(
    await fetch(`${base()}/${encodeURIComponent(id)}/runs`, { signal }),
    'listScheduledJobRuns',
  );
  return body.runs;
}

export async function getScheduledJobRun(runId: string, signal?: AbortSignal): Promise<ScheduledJobRunDto> {
  return json(await fetch(`${base()}/runs/${encodeURIComponent(runId)}`, { signal }), 'getScheduledJobRun');
}

export async function previewScheduledJobSchedule(schedule: ScheduledJobSchedule, signal?: AbortSignal): Promise<ScheduledJobPreviewResponse> {
  return json(await fetch(`${base()}/preview`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ schedule }), signal,
  }), 'previewScheduledJobSchedule');
}

export async function getScheduledJobSettings(): Promise<{ sessionMode: ScheduledJobSessionMode }> {
  return json(await fetch(`${base()}/settings`), 'getScheduledJobSettings');
}

export async function updateScheduledJobSettings(sessionMode: ScheduledJobSessionMode): Promise<{ sessionMode: ScheduledJobSessionMode }> {
  return json(await fetch(`${base()}/settings`, {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ sessionMode }),
  }), 'updateScheduledJobSettings');
}
