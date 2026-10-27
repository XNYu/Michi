import { clampWorkflowText, isWorkflowRunTerminal, WORKFLOW_LIMITS, type WorkflowRunDtoV1 } from 'michi-shared';
import type { WorkflowControls, WorkflowRunContext, WorkflowRunSink } from '../../contract/host';
import { applyKiroStepUpdate, applyKiroWorkflowNotification, kiroWorkflowId } from './kiroWorkflowFold';

/**
 * Routes one Kiro CLI process's workflow traffic to the hub. Runs are
 * attributed through the parent (launching) session, which the runtime maps
 * back to the Michi chat; step sessions are learned from `node_start` and
 * their tool approvals are answered through the run.
 */

export type KiroWorkflowControlMethod = 'pause' | 'resume' | 'cancel' | 'retry';

/** AcpClient's synthetic event for a parent `Run Workflow` result. */
export const KIRO_WORKFLOW_LAUNCHED = 'michi/workflow_launched';

export interface KiroStepPermission {
  sessionId: string;
  requestId: number;
  toolCall?: Record<string, unknown>;
  options: Array<{ optionId: string; name?: string; kind?: string }>;
}

export interface KiroWorkflowBridgeDeps {
  /** The host's workflow runs (RuntimeHost.workflows; Michi: workflowRunHub). */
  hub: WorkflowRunSink;
  /** Michi identity of a native parent session; null when unknown. */
  resolve: (nativeSessionId: string) => WorkflowRunContext | null;
  control: (method: KiroWorkflowControlMethod, workflowId: string, parentSessionId: string) => Promise<void>;
  /** Whether this Kiro build accepts a control method. */
  supports?: (method: KiroWorkflowControlMethod) => boolean;
  /** Answer a step's permission request (null cancels it). */
  answerPermission?: (requestId: number, optionId: string | null) => void;
  now?: () => number;
}

export interface KiroWorkflowBridge {
  handle(method: string, params: Record<string, unknown>): void;
  /** A step session asks for a tool approval. True when the run took it. */
  requestPermission(request: KiroStepPermission): boolean;
  /** Step sessions this bridge knows (their frames never reach a chat). */
  isStepSession(sessionId: string): boolean;
  /** A workflow of this process is running or paused (it dies with the process). */
  hasOpenRuns(): boolean;
  release(reason: string): void;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function createKiroWorkflowBridge(deps: KiroWorkflowBridgeDeps): KiroWorkflowBridge {
  const now = deps.now ?? Date.now;
  const runs = new Map<string, { context: WorkflowRunContext; parentSessionId: string }>();
  const stepSessions = new Map<string, { workflowId: string; nodeId: string }>();
  /** Runs still running or paused in this process. */
  const open = new Set<string>();
  const track = (workflowId: string, run: WorkflowRunDtoV1 | null) => {
    if (!run) return;
    if (isWorkflowRunTerminal(run.status)) open.delete(workflowId);
    else open.add(workflowId);
  };

  function attach(workflowId: string, parentSessionId: string | undefined): { context: WorkflowRunContext; parentSessionId: string } | null {
    const known = runs.get(workflowId);
    if (known) return known;
    const context = parentSessionId ? deps.resolve(parentSessionId) : null;
    if (!context || !parentSessionId) return null;
    const entry = { context, parentSessionId };
    runs.set(workflowId, entry);
    return entry;
  }

  function controls(workflowId: string, entry: { context: WorkflowRunContext; parentSessionId: string }): WorkflowControls {
    const out: WorkflowControls = {};
    const supported = (method: KiroWorkflowControlMethod) => deps.supports?.(method) ?? true;
    if (supported('pause')) out.pause = () => deps.control('pause', workflowId, entry.parentSessionId);
    if (supported('cancel')) out.stop = () => deps.control('cancel', workflowId, entry.parentSessionId);
    if (supported('retry')) out.retry = () => deps.control('retry', workflowId, entry.parentSessionId);
    if (supported('resume')) {
      out.resume = async () => {
        await deps.control('resume', workflowId, entry.parentSessionId);
        // Kiro announces no "resumed" event; the next node_start would.
        deps.hub.update(entry.context, 'kiro', workflowId, (run) => run.status === 'paused'
          ? { ...run, status: 'running', statusDetail: undefined }
          : run);
      };
    }
    return out;
  }

  function forgetSteps(workflowId: string): void {
    for (const [sessionId, step] of stepSessions) if (step.workflowId === workflowId) stepSessions.delete(sessionId);
  }

  return {
    handle(method, params) {
      if (method === KIRO_WORKFLOW_LAUNCHED) {
        const workflowId = str(params['workflowId']);
        const toolCallId = str(params['toolCallId']);
        if (!workflowId) return;
        const fresh = !runs.has(workflowId);
        const entry = attach(workflowId, str(params['sessionId']));
        if (!entry) return;
        track(workflowId, deps.hub.update(entry.context, 'kiro', workflowId, (run) => toolCallId && !run.parentToolCallId
          ? { ...run, parentToolCallId: toolCallId }
          : run));
        if (fresh) deps.hub.registerControls(entry.context.ownerUserId, 'kiro', workflowId, controls(workflowId, entry));
        return;
      }
      const workflowId = kiroWorkflowId(params);
      if (!workflowId) return;
      if (method === 'session/update') {
        deps.hub.updateKnown('kiro', workflowId, (run) => applyKiroStepUpdate(run, params, now()));
        return;
      }
      const fresh = !runs.has(workflowId);
      // Workflow notifications name the parent; notify names it as sessionId.
      const entry = attach(workflowId, str(params['parentSessionId']) ?? str(params['sessionId']));
      if (!entry) return;
      if (method === '_kiro/workflow/node_start') {
        const sessionId = str(params['sessionId']);
        const nodeId = str(params['nodeId']);
        if (sessionId && nodeId && sessionId !== entry.parentSessionId) stepSessions.set(sessionId, { workflowId, nodeId });
      }
      const run = deps.hub.update(entry.context, 'kiro', workflowId, (current) => applyKiroWorkflowNotification(current, method, params, now()));
      track(workflowId, run);
      if (fresh) deps.hub.registerControls(entry.context.ownerUserId, 'kiro', workflowId, controls(workflowId, entry));
      if (method === '_kiro/workflow/run_complete' && params['status'] !== 'paused') {
        forgetSteps(workflowId);
        // A completed run accepts nothing; failed/aborted ones keep Retry.
        if (run?.status === 'completed') deps.hub.registerControls(entry.context.ownerUserId, 'kiro', workflowId, {});
      }
    },

    requestPermission(request) {
      const step = stepSessions.get(request.sessionId);
      const entry = step ? runs.get(step.workflowId) : undefined;
      if (!step || !entry || !deps.answerPermission || request.options.length === 0) return false;
      const toolCall = rec(request.toolCall);
      const rawInput = toolCall?.['rawInput'];
      const detail = rawInput === undefined ? undefined
        : clampWorkflowText(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2), WORKFLOW_LIMITS.prompt);
      const answer = deps.answerPermission;
      return deps.hub.requestApproval(entry.context.ownerUserId, 'kiro', step.workflowId, {
        id: `kiro-${request.sessionId}-${request.requestId}`,
        nodeId: step.nodeId,
        title: `Approve ${clampWorkflowText(toolCall?.['title'], WORKFLOW_LIMITS.title) ?? 'tool use'}?`,
        ...(detail ? { detail } : {}),
        options: request.options.map((option) => ({
          optionId: option.optionId,
          name: option.name ?? option.optionId,
          ...(option.kind ? { kind: option.kind } : {}),
        })),
      }, (optionId) => answer(request.requestId, optionId));
    },

    isStepSession(sessionId) {
      return stepSessions.has(sessionId);
    },

    hasOpenRuns() {
      return open.size > 0;
    },

    release(reason) {
      for (const [workflowId, entry] of runs) deps.hub.releaseControls(entry.context.ownerUserId, 'kiro', workflowId, reason);
      runs.clear();
      stepSessions.clear();
      open.clear();
    },
  };
}
