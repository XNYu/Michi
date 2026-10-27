import { randomUUID } from 'node:crypto';
import { bindConversationBatch } from './conversationBatch';
import { CHAT_STREAM_EVENTS, isSystemWorkspaceSettings } from 'michi-shared';
import type { BackgroundSubscriber, StartedRequestedSelfTurn, StartRequestedSelfTurnArgs } from '../../agents/chatHub';
import type { AgentReasoning, AgentRuntime, AgentSession } from '../../agents/types';
import { getModelReasoningOptions } from '../../agents/modelReasoning';
import { getRuntime } from '../../agents/registry';
import { getAgentConfig, resolveModel, resolveProvider, resolveReasoning } from '../agentConfig';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { log } from '../logger';
import { writeNodePermissionMode } from '../chatPermissions';
import { getDb, runInTransaction } from '../db';
import { getNode, getWorkspace, listMessages, markNodeMaintenanceJob, type WorkspaceRow } from '../dbRepository';
import { ensureDurableGraphNode } from '../graphCommands';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import type { ScheduledJobRecord, ScheduledJobRunRecord } from './repository';
import type {
  ScheduledJobExecutor,
  ScheduledRunHandle,
  ScheduledRunHooks,
  ScheduledRunOutcome,
} from './scheduler';

/** The slice of ChatHub the executor drives. */
export interface ScheduledChatHub {
  startRequestedSelfTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn>;
  requestedTurnStatus(turnId: string): 'active' | 'completed' | 'cancelled' | 'error' | null;
  cancel(chatId: string, requestedTurnId?: string): boolean;
  subscribeBackground(sub: BackgroundSubscriber): () => void;
}

export interface ChatScheduledJobExecutorDeps {
  chatHub: ScheduledChatHub;
  ensureSession(input: { ownerUserId: string; workspaceId: string; nodeId: string; maintenance?: boolean }): Promise<AgentSession | null>;
  /** Runtime lookup; defaults to the registered runtimes. */
  getRuntime?: (runtimeId: string) => AgentRuntime | undefined;
  clock?: () => number;
}

const SUMMARY_MAX_CHARS = 280;

/** Plain one-paragraph preview of an assistant reply for lists and notifications. */
export function summarizeReply(content: string): string | null {
  const visible = stripSentinelsStreamingSafe(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!visible) return null;
  return visible.length > SUMMARY_MAX_CHARS ? `${visible.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : visible;
}

function runTitle(job: ScheduledJobRecord, now: number): string {
  if (job.sessionMode === 'persistent') return job.name;
  const stamp = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(now));
  return `${job.name} · ${stamp}`;
}

interface TurnWatcher {
  turnId: string;
  hooks: ScheduledRunHooks;
}

/**
 * Whether the scheduler may treat a workspace as a place to run jobs: it
 * exists, is not in Trash, and is not a hidden system workspace (every chat
 * in the Michi assistant's runs as the assistant, which is not a worker).
 */
export function isSchedulableWorkspace(workspace: Pick<WorkspaceRow, 'deleted_at' | 'settings'> | null | undefined): boolean {
  return !!workspace && !workspace.deleted_at && !isSystemWorkspaceSettings(workspace.settings);
}

export class ChatScheduledJobExecutor implements ScheduledJobExecutor {
  private readonly clock: () => number;
  private readonly watchers = new Map<string, TurnWatcher>();
  /** Threads whose current turn is a scheduled run (see isRunningOn). */
  private readonly runningNodes = new Map<string, number>();
  private detachWatcher: (() => void) | null = null;

  constructor(private readonly deps: ChatScheduledJobExecutorDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  dispose(): void {
    this.detachWatcher?.();
    this.detachWatcher = null;
    this.watchers.clear();
    this.runningNodes.clear();
  }

  /**
   * True from just before a scheduled run's turn starts until it settles.
   * Nobody is watching such a turn, so tools that need a user's approval (or
   * that would let a job create jobs) refuse to run inside it.
   */
  isRunningOn(nodeId: string): boolean {
    return (this.runningNodes.get(nodeId) ?? 0) > 0;
  }

  private markRunning(nodeId: string): () => void {
    this.runningNodes.set(nodeId, (this.runningNodes.get(nodeId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.runningNodes.get(nodeId) ?? 1) - 1;
      if (count > 0) this.runningNodes.set(nodeId, count);
      else this.runningNodes.delete(nodeId);
    };
  }

  /**
   * One background subscription surfaces approval / input requests from any
   * scheduled turn so an unattended run can ask for help.
   */
  private ensureWatcher(): void {
    if (this.detachWatcher) return;
    this.detachWatcher = this.deps.chatHub.subscribeBackground({
      send: (chatId, event) => {
        const watcher = this.watchers.get(chatId);
        if (!watcher || event.data.turnId !== watcher.turnId) return;
        if (event.event === CHAT_STREAM_EVENTS.permissionRequest) watcher.hooks.onAttention('approval');
        else if (event.event === CHAT_STREAM_EVENTS.userInputRequest) watcher.hooks.onAttention('input');
      },
      close: () => {},
    });
  }

  async start(job: ScheduledJobRecord, _run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const assertCurrent = () => {
      if (hooks.signal?.aborted || hooks.isCurrent?.() === false) throw new Error('Scheduled execution was cancelled or lost scheduler ownership');
    };
    assertCurrent();
    const workspace = getWorkspace(job.workspaceId);
    if (!workspace || workspace.deleted_at || workspace.purged_at) {
      throw new Error('The workspace for this job is missing or in Trash');
    }
    // Never in a hidden system workspace: every chat in the Michi assistant's
    // runs as the assistant, which is not a worker.
    if (isSystemWorkspaceSettings(workspace.settings)) {
      throw new Error('Scheduled jobs cannot run in a Michi system workspace');
    }
    const now = this.clock();
    // A profile the scheduler resolved at run start is final; otherwise the job's null fields follow global.
    const resolved = hooks.runtimeProfile;
    const runtimeId = resolved?.runtimeId ?? job.runtimeId ?? getAgentConfig().runtime;
    const runtime = (this.deps.getRuntime ?? getRuntime)(runtimeId);
    if (!runtime) throw new Error(`Agent runtime "${runtimeId}" is not available`);

    let nodeId: string | null = null;
    let treeId: string | null = null;
    let created = false;
    if (job.sessionMode === 'persistent' && job.persistentNodeId) {
      const node = getNode(job.persistentNodeId);
      const reusable = node
        && node.workspace_id === job.workspaceId
        && node.kind === 'chat'
        && !node.deleted_at
        && (!(resolved?.runtimeId ?? job.runtimeId) || !node.runtime_id || node.runtime_id === runtimeId);
      if (reusable) {
        nodeId = node.id;
        treeId = node.tree_id ?? null;
        if (treeId) getDb().prepare('UPDATE trees SET last_active_at = ? WHERE id = ?').run(now, treeId);
      }
    }
    if (!nodeId) {
      // Resolve the profile the way ensure-session does for a new thread, so
      // a default reasoning level the model cannot use is dropped instead of
      // failing the session.
      const providerId = !runtime.capabilities.providerModels ? null
        : resolved ? resolved.providerId : job.providerId ?? resolveProvider(runtimeId) ?? null;
      const requestedModel = resolved ? resolved.modelId : job.modelId ?? (resolveModel(runtimeId) || null);
      const requestedReasoning = (resolved ? resolved.reasoning
        : job.reasoning ?? resolveReasoning(runtimeId) ?? null) as AgentReasoning | null;
      const effort = await getModelReasoningOptions(runtime, requestedModel, providerId, requestedReasoning);
      assertCurrent();
      const modelId = effort.modelId ?? requestedModel;
      const reasoning = effort.value ?? null;
      nodeId = `n-${randomUUID()}`;
      treeId = `t-${now}-${randomUUID().slice(0, 8)}`;
      ensureDurableGraphNode({
        // Copy the stored workspace fields so this never rewrites the user's
        // name, folder or active thread.
        workspace: {
          id: workspace.id,
          name: workspace.name,
          cwd: workspace.cwd ?? null,
          createdAt: workspace.created_at,
          activeTreeId: workspace.active_tree_id ?? null,
        },
        tree: { id: treeId, rootNodeId: nodeId, name: null, lastActiveAt: now, createdAt: now },
        node: { id: nodeId, treeId, parentNodeId: null, kind: 'chat', title: runTitle(job, now), createdAt: now },
        edges: [],
        ownerUserId: workspace.owner_user_id ?? null,
      });
      created = true;
      // Seed the profile the session will be opened with; ensureParentSession
      // reads it from the node, exactly as for a thread the user created.
      getDb().prepare(`
        UPDATE nodes SET runtime_id = ?, provider_id = ?, model_id = ?, reasoning = ?
         WHERE id = ? AND acp_session_id IS NULL
      `).run(runtimeId, providerId, modelId, reasoning, nodeId);
    }
    assertCurrent();
    if (hooks.maintenanceContext) markNodeMaintenanceJob(nodeId, job.id);
    writeNodePermissionMode(nodeId, job.permissionMode);

    let session: AgentSession | null;
    try {
      session = await this.deps.ensureSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: job.workspaceId, nodeId,
        ...(hooks.maintenanceContext ? { maintenance: true } : {}) });
      assertCurrent();
    } catch (error) {
      if (created) this.rollback(nodeId, job.workspaceId, treeId);
      throw error;
    }
    if (!session) {
      if (created) this.rollback(nodeId, job.workspaceId, treeId);
      throw new Error(`Agent runtime "${runtimeId}" is not available`);
    }

    const turnId = randomUUID();
    const batch = hooks.conversationBatch ? bindConversationBatch(nodeId, job.workspaceId, hooks.conversationBatch, hooks.maintenanceContext) : null;
    this.ensureWatcher();
    const chatId = session.id;
    this.watchers.set(chatId, { turnId, hooks });
    // Marked before the turn starts so its very first tool call already sees it.
    const releaseRunning = this.markRunning(nodeId);
    let cancellationAccepted = false;
    const cancel = () => {
      if (cancellationAccepted) return;
      batch?.release();
      try { cancellationAccepted = this.deps.chatHub.cancel(chatId, turnId); }
      catch (error) { log.warn('scheduler', 'scheduled native cancellation failed', { turnId, error: String(error) }); }
    };
    hooks.signal?.addEventListener('abort', cancel, { once: true });
    let started: StartedRequestedSelfTurn;
    try {
      assertCurrent();
      started = await this.deps.chatHub.startRequestedSelfTurn({
        chatId,
        nodeId,
        ownerUserId: LOCAL_AGENT_OWNER_ID,
        turnId,
        text: job.prompt + (batch?.prompt ?? ''),
        displayText: job.prompt,
        userMetadata: { scheduledJobId: job.id },
        maintenanceContext: hooks.maintenanceContext,
        session,
      });
    } catch (error) {
      hooks.signal?.removeEventListener('abort', cancel);
      this.watchers.delete(chatId);
      releaseRunning();
      batch?.release();
      throw error;
    }

    // Cancellation can arrive while ChatHub is committing/queuing the turn.
    // Reserve its exact id before setup, then cancel again once it is attached.
    if (hooks.signal?.aborted || hooks.isCurrent?.() === false) cancel();
    const targetNodeId = nodeId;
    const done: Promise<ScheduledRunOutcome> = started.done
      .catch(() => undefined)
      .then(() => ({ ...this.outcome(turnId, started.assistantId, targetNodeId),
        ...(batch ? { conversationHandledTurnIds: batch.handledTurnIds(), conversationNoChangeReasons: batch.noChangeReasons() } : {}) }))
      .catch((error: unknown): ScheduledRunOutcome => ({
        status: 'failed', summary: null, error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        hooks.signal?.removeEventListener('abort', cancel);
        releaseRunning();
        batch?.release();
        if (this.watchers.get(chatId)?.turnId === turnId) this.watchers.delete(chatId);
      });

    return {
      nodeId,
      treeId,
      turnId,
      done,
      cancel,
    };
  }

  /** Remove a thread this run created if its session never started. */
  private rollback(nodeId: string, workspaceId: string, treeId: string | null): void {
    if (!treeId) return;
    try {
      runInTransaction(() => {
        const row = getDb().prepare(`
          SELECT n.acp_session_id, (SELECT COUNT(*) FROM messages m WHERE m.node_id = n.id) AS message_count
            FROM nodes n WHERE n.id = ? AND n.workspace_id = ? AND n.tree_id = ?
        `).get(nodeId, workspaceId, treeId) as { acp_session_id: string | null; message_count: number } | undefined;
        if (!row || row.acp_session_id || row.message_count > 0) return;
        // nodes.tree_id cascades, so this removes the root node too.
        getDb().prepare('DELETE FROM trees WHERE id = ? AND workspace_id = ? AND root_node_id = ?').run(treeId, workspaceId, nodeId);
      });
    } catch {
      // Leaving an empty thread behind is harmless; the run still reports the failure.
    }
  }

  private outcome(turnId: string, assistantId: string, nodeId: string): ScheduledRunOutcome {
    const status = this.deps.chatHub.requestedTurnStatus(turnId);
    const message = listMessages(nodeId).find((candidate) => candidate.id === assistantId);
    const summary = message ? summarizeReply(message.content) : null;
    if (status === 'completed') return { status: 'succeeded', summary, error: null };
    if (status === 'cancelled') return { status: 'cancelled', summary, error: null };
    const row = getDb().prepare('SELECT error FROM turns WHERE turn_id = ?').get(turnId) as { error: string | null } | undefined;
    return { status: 'failed', summary, error: row?.error ?? 'The agent reported an error' };
  }
}
