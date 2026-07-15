import type { AgentSession, ChatMessage } from '../types';
import type { NormalizedEvent, PermissionOption } from '../../services/chatEvents';
import type { McpSlotRegistry } from '../../services/mcpServer';
import type { AgentToolBridge } from '../toolBridge';
import type { CodexAppServerClient } from './CodexAppServerClient';
import { EventQueue } from '../eventQueue';
import { createCodexTranslator } from './codexEventTranslator';
import { resolveShowImage } from '../claude/showImage';
import { canonicalPermissionToolName, resolvePolicy } from '../permissionPolicy';
import { grantPermission } from '../../services/dbRepository';
import { followUpReminder } from '../preamble';
import { log } from '../../services/logger';
import { buildCodexFollowUpsHookPocInstruction } from './codexFollowUpsHookPoc';
import {
  FOLLOW_UPS_SENTINEL_TURN_REMINDER,
  resolveFollowUpsExperimentMode,
  type FollowUpsExperimentMode,
} from '../followUpsExperiment';

const APPROVE_TIMEOUT_MS = parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? '300000', 10);

type SessionState = 'idle' | 'in_turn' | 'crashed' | 'disposed';

export interface CodexSessionDeps {
  nodeId: string;
  threadId: string;
  cwd: string;
  workspaceId: string | null;
  parentChatId?: string;
  client: CodexAppServerClient;
  mcpRegistry: McpSlotRegistry;
  bridge: AgentToolBridge;
  mcpPort: number;
  ownerUserId?: string | null;
  firstTurnPrefix?: string;
  effort?: string | null;
  model?: string | null;
  followUpsHookPocEnabled?: boolean;
  followUpsExperimentMode?: FollowUpsExperimentMode;
}

export class CodexSession implements AgentSession {
  public readonly id: string;
  public readonly runtimeId = 'codex';
  public readonly parentChatId: string | undefined;
  public currentModeId: string | null = null;
  public currentModelId: string | null;
  public readonly threadId: string;
  public readonly workspaceId: string | null;
  public readonly effort: string | null;

  private readonly cwd: string;
  private readonly client: CodexAppServerClient;
  private readonly mcpRegistry: McpSlotRegistry;
  private readonly bridge: AgentToolBridge;
  private readonly mcpPort: number;
  private readonly ownerUserId: string | null;
  private readonly followUpsHookPocEnabled: boolean;
  private readonly followUpsExperimentMode: FollowUpsExperimentMode;

  private state: SessionState = 'idle';
  private slotId: string | null = null;

  private queue: EventQueue;
  private readonly history: ChatMessage[] = [];
  private markTranslatorTurnStart: (() => void) | null = null;
  private unsubscribeNotification: (() => void) | null = null;

  private firstTurnPrefix: string;
  private firstTurnPrefixConsumed = false;

  private followUpsValidationActive = false;
  private followUpsSetThisTurn = false;
  private branchOverviewSetThisTurn = false;
  private followUpsStopBlockUsed = false;
  private followUpsRepairMode = false;
  private followUpsSuppressedChunkEvents = 0;
  private followUpsSuppressedThoughtEvents = 0;
  private followUpsOutputBoundaryPending = false;

  // Turn mutex
  private turnLock: Promise<void> | null = null;
  private turnLockRelease: (() => void) | null = null;

  // Permission state — session-local numeric ids (NOT JSON-RPC ids)
  private nextRequestId = 0;
  /** Exposed for test inspection (security contract tests). Do not mutate externally. */
  public readonly pendingPermissions = new Map<
    number,
    { resolve: (optionId: string | null) => void; timer: NodeJS.Timeout }
  >();

  /** Called when a tool is granted always-allow, with the canonical tool name. */
  public onAlwaysAllow: ((canonicalTool: string) => void) | null = null;

  constructor(deps: CodexSessionDeps) {
    this.id = deps.nodeId;
    this.threadId = deps.threadId;
    this.cwd = deps.cwd;
    this.workspaceId = deps.workspaceId;
    this.parentChatId = deps.parentChatId;
    this.client = deps.client;
    this.mcpRegistry = deps.mcpRegistry;
    this.bridge = deps.bridge;
    this.mcpPort = deps.mcpPort;
    this.ownerUserId = deps.ownerUserId ?? null;
    this.followUpsHookPocEnabled = deps.followUpsHookPocEnabled ?? false;
    this.followUpsExperimentMode =
      deps.followUpsExperimentMode ?? resolveFollowUpsExperimentMode();
    this.firstTurnPrefix = deps.firstTurnPrefix ?? '';
    this.effort = deps.effort ?? null;
    this.currentModelId = deps.model ?? null;

    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'idle' || this.state === 'in_turn') {
        this.queue.push({ kind: 'heartbeat', idleMs });
      }
    });
  }

  // ---- Public AgentSession interface ----------------------------------------

  getHistory(): ChatMessage[] {
    return this.history;
  }

  getPendingAssistant(): string | undefined {
    return undefined;
  }

  async *send(text: string): AsyncIterableIterator<NormalizedEvent> {
    if (this.state === 'disposed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }
    if (this.state === 'crashed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }

    await this.acquireTurnLock();
    try {
      const outgoingText =
        this.firstTurnPrefixConsumed || !this.firstTurnPrefix
          ? text
          : `${this.firstTurnPrefix}\n\n---\n\n${text}`;
      this.firstTurnPrefixConsumed = true;

      // Append follow-up reminder for the model only — history stays clean.
      const userTurnCount = this.history.filter(m => m.role === 'user').length + 1;
      const reminder = this.followUpsHookPocEnabled && this.followUpsExperimentMode === 'sentinel'
        ? FOLLOW_UPS_SENTINEL_TURN_REMINDER
        : followUpReminder(userTurnCount, true);
      const textForModel = outgoingText
        + (reminder || '')
        + (this.followUpsHookPocEnabled
          ? buildCodexFollowUpsHookPocInstruction(this.followUpsExperimentMode)
          : '');

      this.state = 'in_turn';
      this.armFollowUpsHookPoc(userTurnCount);
      this.history.push({ role: 'user', content: outgoingText });
      this.markTranslatorTurnStart?.();

      await this.client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: outgoingText }],
        ...(this.effort ? { effort: this.effort } : {}),
        summary: 'detailed',
      });

      const assistantChunks: string[] = [];
      for await (const ev of this.queue.drainUntilTurnEnd()) {
        if (ev.kind === 'chunk') assistantChunks.push(ev.text);
        yield ev;
      }
      if (assistantChunks.length > 0) {
        this.history.push({ role: 'assistant', content: assistantChunks.join('') });
      }
      const stateAfterDrain = this.state as SessionState;
      if (stateAfterDrain !== 'crashed' && stateAfterDrain !== 'disposed') {
        this.state = 'idle';
      }
    } finally {
      this.finishFollowUpsHookPocTurn();
      this.releaseTurnLock();
    }
  }

  async cancel(): Promise<void> {
    if (this.state !== 'in_turn') return;
    try {
      await this.client.request('turn/interrupt', { threadId: this.threadId });
    } catch {
      // Best-effort; the queue drain will end on its own via the turn_end the
      // server pushes after interrupt, or the session will be disposed.
    }
  }

  respondToPermission(requestId: number, optionId: string): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(requestId);
    entry.resolve(optionId);
  }

  cancelPermission(requestId: number): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingPermissions.delete(requestId);
    entry.resolve(null);
  }

  // ---- Approval handling (called by CodexRuntime) ---------------------------

  async askPermission(
    method: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): Promise<void> {
    const toolName = canonicalToolNameFromMethod(method);
    const requestId = ++this.nextRequestId;

    const options: PermissionOption[] = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow this tool', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ];

    this.queue.push({
      kind: 'permission_request',
      requestId,
      title: `Approve ${toolName}?`,
      detail: formatCodexPermissionDetail(method, params),
      options,
    });

    const result = await this.awaitPermission(requestId);

    if (result === 'allow_always') {
      const canonical = canonicalPermissionToolName(toolName);
      if (this.workspaceId) {
        grantPermission(this.workspaceId, canonical);
      }
      this.onAlwaysAllow?.(canonical);
      respond({ decision: 'acceptForSession' });
      return;
    }
    if (result !== null && result.startsWith('allow')) {
      respond({ decision: 'accept' });
      return;
    }
    respond({ decision: 'decline' });
  }

  private awaitPermission(requestId: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve(null);
      }, APPROVE_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, { resolve, timer });
    });
  }

  /**
   * Terminate all pending approvals and push a terminal event pair.
   * Called by CodexRuntime when the daemon exits unexpectedly.
   */
  markCrashed(reason: string): void {
    if (this.state === 'crashed' || this.state === 'disposed') return;
    this.state = 'crashed';

    // Reject all pending permissions with cancel
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingPermissions.clear();

    this.queue.push({ kind: 'mcp_server_error', serverName: 'codex', error: reason });
    this.queue.push({ kind: 'turn_end', stopReason: 'error' });
    this.queue.dispose();
  }

  // ---- MCP slot setup -------------------------------------------------------

  private armFollowUpsHookPoc(userTurnCount: number): void {
    if (!this.followUpsHookPocEnabled) return;
    this.followUpsValidationActive = true;
    this.followUpsSetThisTurn = false;
    this.branchOverviewSetThisTurn = false;
    this.followUpsStopBlockUsed = false;
    this.followUpsRepairMode = false;
    this.followUpsSuppressedChunkEvents = 0;
    this.followUpsSuppressedThoughtEvents = 0;
    this.followUpsOutputBoundaryPending = false;
    log.info('chat', 'codex follow-ups hook poc turn armed', {
      nodeId: this.id,
      threadId: this.threadId,
      userTurnCount,
    });
  }

  private followUpsHookCallbacks(): {
    onSetFollowUps?: (followUps: string[]) => void;
    onSetBranchOverview: (overview: string) => void;
    onValidateFollowUps: () => Record<string, unknown>;
  } {
    return {
      ...(this.followUpsExperimentMode === 'hook-tool' ? {
        onSetFollowUps: (followUps: string[]) => {
          const cleaned = followUps.map((value) => value.trim()).filter(Boolean).slice(0, 3);
          if (cleaned.length === 0) return;
          if (this.followUpsValidationActive) this.followUpsSetThisTurn = true;
          log.info('mcp', 'codex follow-ups hook poc set_follow_ups received', {
            nodeId: this.id,
            threadId: this.threadId,
            count: cleaned.length,
            validationActive: this.followUpsValidationActive,
          });
          this.followUpsOutputBoundaryPending = true;
          this.queue.push({ kind: 'follow_ups_status', status: 'in_progress' });
          this.queue.push({ kind: 'follow_ups', followUps: cleaned });
        },
      } : {}),
      onSetBranchOverview: (overview) => {
        const cleaned = overview.trim();
        if (!cleaned) return;
        if (this.followUpsValidationActive) this.branchOverviewSetThisTurn = true;
        log.info('mcp', 'codex follow-ups hook poc set_branch_overview received', {
          nodeId: this.id,
          threadId: this.threadId,
          length: cleaned.length,
          validationActive: this.followUpsValidationActive,
        });
        this.queue.push({ kind: 'branch_overview', overview: cleaned });
      },
      onValidateFollowUps: () => {
        if (!this.followUpsValidationActive) {
          log.info('mcp', 'codex follow-ups hook poc validator skipped', {
            nodeId: this.id,
            threadId: this.threadId,
            reason: 'non-user-turn',
          });
          return {};
        }
        const missingTools: string[] = [];
        if (!this.branchOverviewSetThisTurn) missingTools.push('set_branch_overview');
        if (this.followUpsExperimentMode === 'hook-tool' && !this.followUpsSetThisTurn) {
          missingTools.push('set_follow_ups');
        }
        if (missingTools.length === 0) {
          log.info('mcp', 'codex follow-ups hook poc validator passed', {
            nodeId: this.id,
            threadId: this.threadId,
          });
          return {};
        }
        if (!this.followUpsStopBlockUsed) {
          this.followUpsStopBlockUsed = true;
          this.followUpsRepairMode = true;
          log.warn('mcp', 'codex follow-ups hook poc blocked stop', {
            nodeId: this.id,
            threadId: this.threadId,
            attempt: 1,
          });
          const repairInstructions = missingTools.map((tool) => tool === 'set_branch_overview'
            ? 'For set_branch_overview, provide 1-3 concise sentences about the branch state.'
            : 'For set_follow_ups, provide exactly three user-voice questions.');
          return {
            decision: 'block',
            reason:
              `Before finishing, call the missing Michi metadata tools: ${missingTools.join(', ')}. `
              + `${repairInstructions.join(' ')} Do not repeat the user-facing answer.`,
          };
        }
        log.warn('mcp', 'codex follow-ups hook poc fail-open', {
          nodeId: this.id,
          threadId: this.threadId,
          reason: `${missingTools.join(', ')} still missing after one continuation`,
        });
        return {};
      },
    };
  }

  private suppressFollowUpsRepairEvent(ev: NormalizedEvent): boolean {
    if (!this.followUpsHookPocEnabled || !this.followUpsRepairMode) return false;
    if (ev.kind === 'chunk') {
      this.followUpsSuppressedChunkEvents += 1;
      return true;
    }
    if (ev.kind === 'thought') {
      this.followUpsSuppressedThoughtEvents += 1;
      return true;
    }
    return false;
  }

  private completeFollowUpsOutputBoundary(reason: 'agent-message-completed' | 'turn-completed'): void {
    if (!this.followUpsOutputBoundaryPending) return;
    this.followUpsOutputBoundaryPending = false;
    log.info('chat', 'codex follow-ups visible output boundary completed', {
      nodeId: this.id,
      threadId: this.threadId,
      reason,
    });
    this.queue.push({ kind: 'follow_ups_status', status: 'completed' });
  }

  private finishFollowUpsHookPocTurn(): void {
    if (this.followUpsHookPocEnabled && (
      this.followUpsSuppressedChunkEvents > 0
      || this.followUpsSuppressedThoughtEvents > 0
    )) {
      log.info('chat', 'codex follow-ups hook poc repair output suppressed', {
        nodeId: this.id,
        threadId: this.threadId,
        chunks: this.followUpsSuppressedChunkEvents,
        thoughts: this.followUpsSuppressedThoughtEvents,
      });
    }
    this.followUpsValidationActive = false;
    this.followUpsRepairMode = false;
    this.followUpsSuppressedChunkEvents = 0;
    this.followUpsSuppressedThoughtEvents = 0;
    this.followUpsOutputBoundaryPending = false;
  }

  createMcpSlot(): string {
    const slot = this.mcpRegistry.create(
      this.id,
      this.cwd,
      this.ownerUserId,
      {
        onSpawnBranches: async (topics) => {
          const result = await this.bridge.spawnBranches({
            parentChatId: this.id,
            cwd: this.cwd,
            enableFollowUps: true,
            topics,
          });
          this.queue.push({ kind: 'spawn_branches', topics: result });
          return result;
        },
        onSaveContext: (name, body) => {
          const saved = this.bridge.saveContext({ cwd: this.cwd, name, body });
          if (saved) {
            this.queue.push({
              kind: 'context_saved',
              name: saved.name,
              filePath: saved.filePath,
              size: saved.size,
            });
          }
          return saved;
        },
        onUpdateContext: (name, body) => {
          const updated = this.bridge.updateContext({ cwd: this.cwd, name, body });
          if (updated) {
            this.queue.push({
              kind: 'context_updated',
              name: updated.name,
              filePath: updated.filePath,
              size: updated.size,
            });
          }
          return updated;
        },
        onShowImage: (inputPath, caption) => {
          const r = resolveShowImage(this.cwd, inputPath);
          if (!r.ok) return { error: r.error };
          this.queue.push({
            kind: 'image',
            path: r.relPath,
            caption,
            mimeType: r.mimeType,
            size: r.size,
          });
          return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
        },
        ...(this.followUpsHookPocEnabled ? this.followUpsHookCallbacks() : {}),
      },
      { nodeId: this.id, workspaceId: this.workspaceId },
    );
    this.slotId = slot.slotId;
    return slot.slotId;
  }

  // ---- Translator wiring ----------------------------------------------------

  wireNotifications(): void {
    const translator = createCodexTranslator((ev) => {
      if (this.suppressFollowUpsRepairEvent(ev)) return;
      if (ev.kind === 'turn_end' && this.state === 'in_turn') {
        this.state = 'idle';
      }
      this.queue.push(ev);
    });
    this.markTranslatorTurnStart = translator.startTurn;

    this.unsubscribeNotification = this.client.onNotification(
      this.threadId,
      (method, params) => {
        if (method === 'turn/completed') {
          this.completeFollowUpsOutputBoundary('turn-completed');
        }
        translator.feed(method, params);
        if (method === 'item/completed') {
          const item = (params['item'] ?? params) as Record<string, unknown>;
          if (item['type'] === 'agentMessage') {
            this.completeFollowUpsOutputBoundary('agent-message-completed');
          }
        }
      },
    );
  }

  // ---- Dispose --------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';

    // Reject pending permissions
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingPermissions.clear();

    // Unsubscribe notification handler
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = null;

    // Best-effort thread/unsubscribe (skip if crashed)
    try {
      await this.client.request('thread/unsubscribe', { threadId: this.threadId });
    } catch {
      // Ignore — daemon may be gone
    }

    this.queue.dispose();
    this.markTranslatorTurnStart = null;

    await this.disposeMcpSlot();
  }

  private async disposeMcpSlot(): Promise<void> {
    if (!this.slotId) return;
    const slotId = this.slotId;
    this.slotId = null;
    await this.mcpRegistry.dispose(slotId).catch(() => {});
  }

  // ---- Turn mutex -----------------------------------------------------------

  private async acquireTurnLock(): Promise<void> {
    if (this.turnLock) {
      throw Object.assign(new Error('Session is busy with an in-flight turn'), {
        code: 'ESESSION_BUSY',
      });
    }
    let release!: () => void;
    this.turnLock = new Promise<void>((r) => {
      release = r;
    });
    this.turnLockRelease = release;
  }

  private releaseTurnLock(): void {
    if (this.turnLockRelease) {
      const r = this.turnLockRelease;
      this.turnLock = null;
      this.turnLockRelease = null;
      r();
    }
  }
}

// ---- Helpers -----------------------------------------------------------------

/**
 * Map a codex approval method to a canonical tool name suitable for display
 * and permission policy lookups.
 */
function canonicalToolNameFromMethod(method: string): string {
  if (method === 'item/commandExecution/requestApproval') return 'bash';
  if (method === 'item/fileChange/requestApproval') return 'edit';
  // Unknown methods — use the last segment
  const parts = method.split('/');
  return parts[parts.length - 1] ?? method;
}

function formatCodexPermissionDetail(
  method: string,
  params: Record<string, unknown>,
): string | undefined {
  if (method === 'item/commandExecution/requestApproval') {
    const cmd =
      typeof params['command'] === 'string'
        ? params['command']
        : typeof params['cmd'] === 'string'
          ? params['cmd']
          : undefined;
    if (cmd) return `Command: ${cmd.slice(0, 600)}`;
  }
  if (method === 'item/fileChange/requestApproval') {
    const fp =
      typeof params['file_path'] === 'string'
        ? params['file_path']
        : typeof params['path'] === 'string'
          ? params['path']
          : undefined;
    if (fp) return `File: ${fp.slice(0, 320)}`;
  }
  return undefined;
}
