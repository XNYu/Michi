import { constants as fsConstants, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isWorkflowRunTerminal, type WorkflowApprovalOption } from 'michi-shared';
import type { WorkflowRunContext, WorkflowRunSink } from '../../contract/host';
import {
  applyClaudeWorkflowEnvelope,
  applyClaudeWorkflowOutput,
  claudeTaskId,
  isClaudeWorkflowStart,
} from './claudeWorkflowFold';

/**
 * Side channel from a Claude session's stdout to the workflow hub. It sees
 * every envelope before the turn translator, never emits turn events, and
 * so never opens a self-turn: workflow progress keeps flowing while the
 * chat is idle. Tool approvals asked while no chat turn is running are
 * answered through the workflow run instead of the chat.
 */

const MAX_OUTPUT_BYTES = 1_048_576;

export interface ClaudeWorkflowTapDeps {
  /** The host's workflow runs (RuntimeHost.workflows). */
  hub: WorkflowRunSink;
  /** Read when a workflow starts; null skips tracking. */
  context: () => WorkflowRunContext | null;
  stopTask: (taskId: string) => Promise<void>;
  readOutput?: (file: string, taskId: string) => Promise<unknown>;
  now?: () => number;
}

export interface WorkflowApprovalRequest {
  title: string;
  detail?: string;
  options: WorkflowApprovalOption[];
  /** The tool asked for; an "always allow" answer covers the same tool. */
  toolName?: string;
}

export type WorkflowApprovalOutcome =
  | { kind: 'answered'; optionId: string }
  /**
   * Timed out, the CLI went away, or a workflow showing it was stopped or
   * failed (its agents, possibly the asker, died with it): deny.
   */
  | { kind: 'lapsed' }
  /** The workflows showing it all completed first: the caller asks in the chat. */
  | { kind: 'unhosted' };

export interface ClaudeWorkflowTap {
  observe(envelope: Record<string, unknown>): void;
  /** Workflows of this session still running. */
  hasOpenRuns(): boolean;
  /**
   * Show an approval on the session's running workflows. Claude does not
   * say who asked, so the request is session-level: it shows on every
   * running workflow (and ones that start while it waits), answering it on
   * one answers it on all, and a run ending only removes it from that run.
   * Null when no workflow is running (the caller keeps its own path).
   */
  requestApproval(request: WorkflowApprovalRequest, timeoutMs: number): Promise<WorkflowApprovalOutcome> | null;
  /** An "always allow" answered elsewhere: answer the requests it covers. */
  answerCovered(covers: (toolName: string | undefined) => boolean, optionId: string): void;
  /**
   * Michi is about to stop or restart the CLI (chat Stop, model or
   * permission switch). The CLI ends background workflows with it; record
   * why, so the run says so instead of a generic "stopped".
   */
  expectStop(reason: string): void;
  /** The CLI process ended: open runs lose their driver. */
  release(reason: string): void;
}

/**
 * The workflow's `.output` JSON: only `<…>/tasks/<taskId>.output`, never
 * through a symlink, bounded in size; undefined when unreadable.
 */
export async function readClaudeWorkflowOutput(file: string, taskId: string): Promise<unknown> {
  if (!path.isAbsolute(file) || path.basename(file) !== `${taskId}.output` || path.basename(path.dirname(file)) !== 'tasks') return undefined;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_OUTPUT_BYTES) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_OUTPUT_BYTES) return undefined;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface PendingApproval {
  id: string;
  request: WorkflowApprovalRequest;
  /** Runs showing it right now. */
  hosts: Set<string>;
  /** Runs open when it was asked: only their agents can have asked. */
  askedDuring: Set<string>;
  /**
   * One of `askedDuring` was stopped or failed while it waited. Its agents
   * died with it, and one of them may have been the asker.
   */
  hostAborted: boolean;
  settle: (outcome: WorkflowApprovalOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

export function createClaudeWorkflowTap(deps: ClaudeWorkflowTapDeps): ClaudeWorkflowTap {
  const now = deps.now ?? Date.now;
  const readOutput = deps.readOutput ?? readClaudeWorkflowOutput;
  // Tracked until the final task_notification (its output file follows the
  // terminal status); `finished` marks runs that already reached one.
  const tasks = new Map<string, WorkflowRunContext>();
  const finished = new Set<string>();
  // Why Michi is about to stop each open run, consumed when it ends.
  const stopReasons = new Map<string, string>();
  const approvals = new Map<string, PendingApproval>();
  let approvalSeq = 0;
  const openTasks = () => [...tasks.entries()].filter(([taskId]) => !finished.has(taskId));

  function finish(pending: PendingApproval, outcome: WorkflowApprovalOutcome): void {
    if (pending.done) return;
    pending.done = true;
    if (pending.timer) clearTimeout(pending.timer);
    approvals.delete(pending.id);
    for (const taskId of pending.hosts) {
      const context = tasks.get(taskId);
      if (context) deps.hub.withdrawApproval(context.ownerUserId, 'claude', taskId, pending.id);
    }
    pending.hosts.clear();
    pending.settle(outcome);
  }

  function host(pending: PendingApproval, taskId: string, context: WorkflowRunContext): void {
    if (pending.done || pending.hosts.has(taskId)) return;
    const { request } = pending;
    const accepted = deps.hub.requestApproval(context.ownerUserId, 'claude', taskId, {
      id: pending.id,
      scope: 'session',
      title: request.title,
      ...(request.detail ? { detail: request.detail } : {}),
      options: request.options,
    }, (optionId, endedAs) => {
      pending.hosts.delete(taskId);
      if (pending.done) return;
      if (optionId !== null) { finish(pending, { kind: 'answered', optionId }); return; }
      // The run that showed it ended (the hub calls this once the run is
      // terminal, so it cannot take the request back).
      if (endedAs && endedAs !== 'completed' && pending.askedDuring.has(taskId)) pending.hostAborted = true;
      if (pending.hosts.size === 0) {
        for (const [other, otherContext] of openTasks()) host(pending, other, otherContext);
        if (pending.hosts.size > 0) return;
        // A completed workflow had no agent waiting, so the asker is other
        // background work: ask in the chat. After a stop or failure the
        // asker most likely died with the run; asking in the chat would open
        // a self-turn for a request nobody waits on, so deny instead.
        finish(pending, pending.hostAborted ? { kind: 'lapsed' } : { kind: 'unhosted' });
      }
    });
    if (accepted) pending.hosts.add(taskId);
  }

  return {
    observe(envelope) {
      if (envelope['type'] !== 'system') return;
      if (isClaudeWorkflowStart(envelope)) {
        const taskId = claudeTaskId(envelope);
        const context = taskId ? deps.context() : null;
        if (!taskId || !context) return;
        tasks.set(taskId, context);
        finished.delete(taskId);
        deps.hub.update(context, 'claude', taskId, (run) => applyClaudeWorkflowEnvelope(run, envelope, now()));
        deps.hub.registerControls(context.ownerUserId, 'claude', taskId, {
          stop: () => {
            // The user's own stop is not the side effect of a chat action.
            stopReasons.delete(taskId);
            return deps.stopTask(taskId);
          },
        });
        for (const pending of approvals.values()) host(pending, taskId, context);
        return;
      }
      const taskId = claudeTaskId(envelope);
      const context = taskId ? tasks.get(taskId) : undefined;
      if (!taskId || !context) return;
      const run = deps.hub.update(context, 'claude', taskId, (current) => applyClaudeWorkflowEnvelope(current, envelope, now()));
      if (envelope['subtype'] === 'task_notification') {
        const file = typeof envelope['output_file'] === 'string' ? envelope['output_file'] : undefined;
        if (file) {
          void readOutput(file, taskId).then((output) => {
            if (output !== undefined) deps.hub.update(context, 'claude', taskId, (current) => applyClaudeWorkflowOutput(current, output, now()));
          });
        }
      }
      if (run && isWorkflowRunTerminal(run.status)) {
        const reason = stopReasons.get(taskId);
        stopReasons.delete(taskId);
        if (reason && run.status === 'cancelled') {
          deps.hub.update(context, 'claude', taskId, (current) => ({ ...current, statusDetail: reason }));
        }
        if (!finished.has(taskId)) deps.hub.registerControls(context.ownerUserId, 'claude', taskId, {});
        finished.add(taskId);
        if (envelope['subtype'] === 'task_notification') {
          tasks.delete(taskId);
          finished.delete(taskId);
        }
      }
    },

    hasOpenRuns() {
      return openTasks().length > 0;
    },

    requestApproval(request, timeoutMs) {
      const open = openTasks();
      if (open.length === 0) return null;
      approvalSeq += 1;
      let settle!: (outcome: WorkflowApprovalOutcome) => void;
      const outcome = new Promise<WorkflowApprovalOutcome>((resolve) => { settle = resolve; });
      const pending: PendingApproval = {
        id: `claude-approval-${approvalSeq}`, request, hosts: new Set(),
        askedDuring: new Set(open.map(([taskId]) => taskId)), hostAborted: false, settle, done: false,
      };
      approvals.set(pending.id, pending);
      for (const [taskId, context] of open) host(pending, taskId, context);
      if (pending.hosts.size === 0) {
        // Every run refused it (approval limit): keep the caller's path.
        approvals.delete(pending.id);
        return null;
      }
      pending.timer = setTimeout(() => finish(pending, { kind: 'lapsed' }), timeoutMs);
      pending.timer.unref?.();
      return outcome;
    },

    answerCovered(covers, optionId) {
      for (const pending of [...approvals.values()]) {
        if (covers(pending.request.toolName)) finish(pending, { kind: 'answered', optionId });
      }
    },

    expectStop(reason) {
      for (const [taskId] of openTasks()) stopReasons.set(taskId, reason);
    },

    release(reason) {
      // The CLI that asked is gone; nothing can use an answer any more.
      for (const pending of [...approvals.values()]) finish(pending, { kind: 'lapsed' });
      for (const [taskId, context] of tasks) deps.hub.releaseControls(context.ownerUserId, 'claude', taskId, stopReasons.get(taskId) ?? reason);
      tasks.clear();
      finished.clear();
      stopReasons.clear();
    },
  };
}
