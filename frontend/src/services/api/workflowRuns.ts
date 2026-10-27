import {
  parseWorkflowRunDto,
  parseWorkflowRunSseEnvelope,
  type BackgroundSubagentsEndedV1,
  type BackgroundSubagentsUpdateV1,
  type WorkflowAction,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { backendApiBase, workspaceBackendApiBase } from '../../config/backendConnections';
import { readSseStream, SseHttpError } from './sseParser';
import { fetchStream } from './streamTransport';

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error : `${operation} failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function runField(payload: unknown, operation: string): WorkflowRunDtoV1 {
  const run = payload && typeof payload === 'object' ? parseWorkflowRunDto((payload as { run?: unknown }).run) : null;
  if (!run) throw new Error(`${operation} returned a malformed run`);
  return run;
}

export async function listWorkflowRuns(workspaceId: string, signal?: AbortSignal): Promise<WorkflowRunDtoV1[]> {
  const base = workspaceBackendApiBase(workspaceId);
  const payload = await jsonResponse(await fetch(`${base}/workflow-runs?${new URLSearchParams({ workspaceId })}`, { signal }), 'listWorkflowRuns');
  const runs = payload && typeof payload === 'object' && Array.isArray((payload as { runs?: unknown }).runs)
    ? (payload as { runs: unknown[] }).runs : [];
  return runs.flatMap((raw) => { const run = parseWorkflowRunDto(raw); return run ? [run] : []; });
}

export async function getWorkflowRun(backendConnectionId: string, runId: string, signal?: AbortSignal): Promise<WorkflowRunDtoV1> {
  const payload = await jsonResponse(await fetch(`${backendApiBase(backendConnectionId)}/workflow-runs/${encodeURIComponent(runId)}`, { signal }), 'getWorkflowRun');
  return runField(payload, 'getWorkflowRun');
}

export async function actOnWorkflowRun(backendConnectionId: string, runId: string, action: WorkflowAction): Promise<WorkflowRunDtoV1> {
  const response = await fetch(`${backendApiBase(backendConnectionId)}/workflow-runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return runField(await jsonResponse(response, 'actOnWorkflowRun'), 'actOnWorkflowRun');
}

export async function answerWorkflowApproval(backendConnectionId: string, runId: string, approvalId: string, optionId: string): Promise<WorkflowRunDtoV1> {
  const response = await fetch(
    `${backendApiBase(backendConnectionId)}/workflow-runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionId }) },
  );
  return runField(await jsonResponse(response, 'answerWorkflowApproval'), 'answerWorkflowApproval');
}

export interface WorkflowRunSubscriptionOptions {
  onRun: (run: WorkflowRunDtoV1) => void;
  /**
   * Background subagents the backend's live agent processes still track:
   * a snapshot first, then deltas. Backends from before the event never
   * call it.
   */
  onBackgroundSubagents?: (update: BackgroundSubagentsUpdateV1) => void;
  /**
   * Background subagents of one node that ended without a turn reporting
   * them (already stored by the backend). Backends from before the event
   * never call it.
   */
  onBackgroundSubagentsEnded?: (ended: BackgroundSubagentsEndedV1) => void;
  onOpen?: () => void;
  onDisconnect?: (error?: Error) => void;
}

/** Snapshot-then-live stream of a workspace's runs (and background subagents). Returns unsubscribe. */
export function subscribeWorkflowRuns(workspaceId: string, options: WorkflowRunSubscriptionOptions): () => void {
  const controller = new AbortController();
  let stopped = false;
  const base = workspaceBackendApiBase(workspaceId);
  void (async () => {
    let disconnectError: Error | undefined;
    try {
      const response = await fetchStream(`${base}/workflow-runs/subscribe?${new URLSearchParams({ workspaceId })}`, { signal: controller.signal });
      if (!response.ok) throw new SseHttpError(response.status, 'subscribeWorkflowRuns failed');
      if (!response.body) throw new Error('subscribeWorkflowRuns response has no body');
      options.onOpen?.();
      await readSseStream(response.body.getReader(), (_event, data) => {
        let json: unknown;
        try { json = JSON.parse(data); } catch { return; }
        const envelope = parseWorkflowRunSseEnvelope(json);
        if (envelope?.run) options.onRun(envelope.run);
        else if (envelope?.event === 'background_subagents' && envelope.backgroundSubagents) {
          options.onBackgroundSubagents?.(envelope.backgroundSubagents);
        } else if (envelope?.event === 'background_subagents_ended' && envelope.backgroundSubagentsEnded) {
          options.onBackgroundSubagentsEnded?.(envelope.backgroundSubagentsEnded);
        }
      }, { shouldStop: () => stopped });
    } catch (error) {
      if (!stopped) disconnectError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!stopped) options.onDisconnect?.(disconnectError);
    }
  })();
  return () => { stopped = true; controller.abort(); };
}
