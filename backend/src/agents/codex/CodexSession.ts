import fs from 'node:fs';
import path from 'node:path';
import type { AgentSession, AgentTurnInput, ChatMessage } from '../types';
import type { NormalizedEvent, PermissionOption, UserInputQuestion } from '../../services/chatEvents';
import type { McpSlotRegistry } from '../../services/mcpServer';
import type { AgentToolBridge } from '../toolBridge';
import type { CodexAppServerClient } from './CodexAppServerClient';
import { EventQueue } from '../eventQueue';
import { createCodexTranslator } from './codexEventTranslator';
import { resolveShowImage } from '../claude/showImage';
import { canonicalPermissionToolName, resolvePolicy } from '../permissionPolicy';
import { grantPermission } from '../../services/dbRepository';
import { log } from '../../services/logger';
import { buildCodexFollowUpsHookPocInstruction } from './codexFollowUpsHookPoc';
import {
  followUpsTurnReminder,
  resolveFollowUpsExperimentMode,
  type FollowUpsExperimentMode,
} from '../followUpsExperiment';
import { fallbackCodexTitle, generateCodexTitle } from './codexTitleGenerator';

const APPROVE_TIMEOUT_MS = parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? '300000', 10);

const CODEX_LOCAL_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

function localImagePaths(input?: AgentTurnInput): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const attachment of input?.attachments ?? []) {
    const absPath = attachment.absPath;
    if (!path.isAbsolute(absPath)) continue;
    if (!CODEX_LOCAL_IMAGE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) continue;
    if (seen.has(absPath)) continue;
    try {
      if (!fs.statSync(absPath).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(absPath);
    paths.push(absPath);
  }
  return paths;
}

const INTERNAL_METADATA_TOOLS = new Set([
  'set_branch_overview',
  'set_title',
  'set_follow_ups',
  'validate_follow_ups',
  'validate_turn_metadata',
]);

function isInternalMetadataToolTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (INTERNAL_METADATA_TOOLS.has(normalized)) return true;
  for (const tool of INTERNAL_METADATA_TOOLS) {
    if (!normalized.endsWith(tool)) continue;
    const prefix = normalized.slice(0, -tool.length);
    if (/(?:[/.:]|_{2,})$/.test(prefix)) return true;
  }
  return false;
}

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
  generateTitleOnFirstTurn?: boolean;
  followUpsHookPocEnabled?: boolean;
  followUpsExperimentMode?: FollowUpsExperimentMode;
  /** Default true. When false, the per-turn follow-up reminder is suppressed. */
  enableFollowUps?: boolean;
}

export class CodexSession implements AgentSession {
  public readonly id: string;
  public readonly runtimeId = 'codex';
  public readonly parentChatId: string | undefined;
  public currentModeId: string | null = null;
  public currentModelId: string | null;
  /** Assistant text accumulated during the in-flight turn, exposed via
   *  getPendingAssistant() for auto-branch ancestor "in progress" stitching.
   *  Non-null only between turn start and the finally block. */
  private pendingAssistantBuf: string[] | null = null;
  public readonly threadId: string;
  public readonly workspaceId: string | null;
  public readonly effort: string | null;

  private readonly cwd: string;
  private readonly client: CodexAppServerClient;
  private readonly mcpRegistry: McpSlotRegistry;
  private readonly bridge: AgentToolBridge;
  private readonly mcpPort: number;
  private readonly ownerUserId: string | null;
  private readonly generateTitleOnFirstTurn: boolean;
  private readonly followUpsHookPocEnabled: boolean;
  private readonly followUpsExperimentMode: FollowUpsExperimentMode;
  private readonly enableFollowUps: boolean;

  private state: SessionState = 'idle';
  private slotId: string | null = null;

  private queue: EventQueue;
  private readonly history: ChatMessage[] = [];
  private markTranslatorTurnStart: (() => void) | null = null;
  private unsubscribeNotification: (() => void) | null = null;

  private firstTurnPrefix: string;
  private firstTurnPrefixConsumed = false;
  private titleGenerationAttempted = false;
  private readonly activeTurnThreadIds = new Set<string>();
  private cancelRequested = false;

  private followUpsValidationActive = false;
  private followUpsSetThisTurn = false;
  private branchOverviewSetThisTurn = false;
  private followUpsStopBlockUsed = false;
  private followUpsRepairMode = false;
  private followUpsSuppressedChunkEvents = 0;
  private followUpsSuppressedThoughtEvents = 0;
  private followUpsOutputBoundaryPending = false;
  private followUpsSentinelTail = '';
  private followUpsSentinelsCompleteThisTurn = false;
  private followUpsSilentOverviewTail = false;
  private readonly hiddenInternalToolCallIds = new Set<string>();

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

  // User input state — same pattern as permissions
  private readonly pendingUserInputs = new Map<
    number,
    { resolve: (answers: Array<{ question: string; answer: string }> | null) => void; timer: NodeJS.Timeout }
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
    this.generateTitleOnFirstTurn = deps.generateTitleOnFirstTurn ?? false;
    this.enableFollowUps = deps.enableFollowUps !== false;
    this.followUpsHookPocEnabled = deps.followUpsHookPocEnabled ?? false;
    this.followUpsExperimentMode =
      deps.followUpsExperimentMode ?? resolveFollowUpsExperimentMode();
    this.firstTurnPrefix = deps.firstTurnPrefix ?? '';
    this.effort = deps.effort ?? null;
    this.currentModelId = deps.model ?? null;

    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'in_turn') {
        this.queue.push({ kind: 'heartbeat', idleMs });
      }
    });
  }

  // ---- Public AgentSession interface ----------------------------------------

  getHistory(): ChatMessage[] {
    return this.history;
  }

  getPendingAssistant(): string | undefined {
    return this.pendingAssistantBuf?.join('');
  }

  async *send(text: string, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
    if (this.state === 'disposed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }
    if (this.state === 'crashed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }

    await this.acquireTurnLock();
    const turnEventGate = { acceptTitle: true };
    try {
      this.cancelRequested = false;
      const outgoingText =
        this.firstTurnPrefixConsumed || !this.firstTurnPrefix
          ? text
          : `${this.firstTurnPrefix}\n\n---\n\n${text}`;
      this.firstTurnPrefixConsumed = true;

      // Append follow-up reminder for the model only — history stays clean.
      const userTurnCount = this.history.filter(m => m.role === 'user').length + 1;
      const reminder = followUpsTurnReminder(
        userTurnCount,
        this.followUpsHookPocEnabled,
        this.followUpsExperimentMode,
        this.enableFollowUps,
      );
      const textForModel = outgoingText
        + (reminder || '')
        + (this.followUpsHookPocEnabled
          ? buildCodexFollowUpsHookPocInstruction(this.followUpsExperimentMode)
          : '');

      this.state = 'in_turn';
      const shouldGenerateTitle =
        this.generateTitleOnFirstTurn
        && !this.titleGenerationAttempted
        && this.history.every((message) => message.role !== 'user');
      let titlePromise: Promise<string> | null = null;
      if (shouldGenerateTitle) {
        this.titleGenerationAttempted = true;
        let titleThreadId: string | null = null;
        titlePromise = generateCodexTitle({
          client: this.client,
          cwd: this.cwd,
          model: this.currentModelId,
          userText: text,
          onThreadStarted: (threadId) => {
            titleThreadId = threadId;
            this.activeTurnThreadIds.add(threadId);
            if (this.cancelRequested) void this.interruptThread(threadId);
          },
        }).catch((err) => {
          if (!this.cancelRequested) {
            log.warn('chat', 'codex pre-turn title generation failed; using fallback', {
              nodeId: this.id,
              threadId: this.threadId,
              error: (err as Error).message,
            });
          }
          return fallbackCodexTitle(text);
        }).finally(() => {
          if (titleThreadId) this.activeTurnThreadIds.delete(titleThreadId);
        });
      }

      this.armFollowUpsHookPoc(userTurnCount);
      this.history.push({ role: 'user', content: outgoingText });
      this.markTranslatorTurnStart?.();

      const turnInput: Array<Record<string, unknown>> = [
        { type: 'text', text: textForModel },
        ...localImagePaths(input).map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ];

      // Start the real turn immediately. Title and response events share the
      // queue and are delivered in whichever order they actually complete.
      this.activeTurnThreadIds.add(this.threadId);
      const mainTurnStart = this.client.request('turn/start', {
        threadId: this.threadId,
        input: turnInput,
        ...(this.effort ? { effort: this.effort } : {}),
        summary: 'detailed',
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const mainStartResult = await mainTurnStart;
      if (this.cancelRequested) {
        turnEventGate.acceptTitle = false;
        if (mainStartResult.ok) {
          for await (const _ev of this.queue.drainUntilTurnEnd()) { /* discard cancelled turn */ }
        }
        yield { kind: 'turn_end', stopReason: 'interrupted' };
        return;
      }
      if (!mainStartResult.ok) {
        turnEventGate.acceptTitle = false;
        await Promise.all(
          [...this.activeTurnThreadIds]
            .filter((threadId) => threadId !== this.threadId)
            .map((threadId) => this.interruptThread(threadId)),
        );
        throw mainStartResult.error;
      }

      if (titlePromise) {
        void titlePromise.then((title) => {
          if (!turnEventGate.acceptTitle) return;
          if (!this.cancelRequested) {
            void this.client.request('thread/setName', { threadId: this.threadId, name: title }).catch((err) => {
              log.debug('chat', 'codex thread/setName failed after pre-turn title generation', {
                nodeId: this.id,
                threadId: this.threadId,
                error: (err as Error).message,
              });
            });
          }
          this.queue.push({ kind: 'title', title });
        });
      }

      const assistantChunks: string[] = [];
      this.pendingAssistantBuf = assistantChunks;
      let titleDelivered = titlePromise === null;
      let pendingTurnEnd: Extract<NormalizedEvent, { kind: 'turn_end' }> | null = null;
      while (true) {
        const ev = await this.queue.pull();
        if (ev === null) break;
        if (ev.kind === 'turn_end') {
          pendingTurnEnd = ev;
          const stateAtTurnEnd = this.state as SessionState;
          if (this.cancelRequested || stateAtTurnEnd === 'crashed' || stateAtTurnEnd === 'disposed') {
            turnEventGate.acceptTitle = false;
            titleDelivered = true;
          }
          if (titleDelivered) break;
          continue;
        }
        if (ev.kind === 'title') titleDelivered = true;
        if (ev.kind === 'chunk') assistantChunks.push(ev.text);
        if (!(this.cancelRequested && ev.kind === 'title')) yield ev;
        if (pendingTurnEnd && titleDelivered) break;
      }
      if (pendingTurnEnd) yield pendingTurnEnd;
      if (assistantChunks.length > 0) {
        this.history.push({ role: 'assistant', content: assistantChunks.join('') });
      }
      const stateAfterDrain = this.state as SessionState;
      if (stateAfterDrain !== 'crashed' && stateAfterDrain !== 'disposed') {
        this.state = 'idle';
      }
    } finally {
      this.pendingAssistantBuf = null;
      turnEventGate.acceptTitle = false;
      this.activeTurnThreadIds.clear();
      this.cancelRequested = false;
      if (this.state === 'in_turn') this.state = 'idle';
      this.finishFollowUpsHookPocTurn();
      this.releaseTurnLock();
    }
  }

  async cancel(): Promise<void> {
    if (this.state !== 'in_turn' && this.activeTurnThreadIds.size === 0) return;
    this.cancelRequested = true;
    const threadIds = this.activeTurnThreadIds.size > 0
      ? [...this.activeTurnThreadIds]
      : [this.threadId];
    await Promise.all(threadIds.map((threadId) => this.interruptThread(threadId)));
  }

  private async interruptThread(threadId: string): Promise<void> {
    try {
      await this.client.request('turn/interrupt', { threadId });
    } catch {
      // Best-effort; the turn_end notification or session disposal owns cleanup.
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

  respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>): void {
    const entry = this.pendingUserInputs.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingUserInputs.delete(requestId);
    entry.resolve(answers);
  }

  skipUserInput(requestId: number): void {
    const entry = this.pendingUserInputs.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingUserInputs.delete(requestId);
    entry.resolve(null);
  }

  async askUserInput(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): Promise<void> {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const parsedQuestions: UserInputQuestion[] = questions.map((q: Record<string, unknown>) => ({
      question: String(q.question ?? ''),
      header: typeof q.header === 'string' ? q.header : undefined,
      options: Array.isArray(q.options)
        ? (q.options as Array<Record<string, unknown>>).map((o) => ({
            label: String(o.label ?? ''),
            description: typeof o.description === 'string' ? o.description : undefined,
          }))
        : [],
      multiSelect: q.multiSelect === true,
    }));

    const answers = await this.requestUserInput(parsedQuestions);

    if (answers) {
      const responseObj: Record<string, string> = {};
      for (const a of answers) {
        responseObj[a.question] = a.answer;
      }
      respond({ answers: responseObj });
    } else {
      respond({ answers: null });
    }
  }

  private async requestUserInput(
    questions: UserInputQuestion[],
  ): Promise<Array<{ question: string; answer: string }> | null> {
    const requestId = ++this.nextRequestId;
    this.queue.push({ kind: 'user_input_request', requestId, questions });

    const answers = await new Promise<Array<{ question: string; answer: string }> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUserInputs.delete(requestId);
        resolve(null);
      }, APPROVE_TIMEOUT_MS);
      this.pendingUserInputs.set(requestId, { resolve, timer });
    });

    this.queue.push({ kind: 'user_input_resolved', requestId, answers: answers ?? [] });
    return answers;
  }

  async askMcpElicitation(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): Promise<void> {
    const requestId = ++this.nextRequestId;
    const serverName = typeof params['serverName'] === 'string' ? params['serverName'] : 'MCP server';
    const message = typeof params['message'] === 'string' ? params['message'] : 'Approve this MCP request?';

    const options: PermissionOption[] = [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ];
    this.queue.push({
      kind: 'permission_request',
      requestId,
      title: `Approve request from ${serverName}?`,
      detail: message,
      options,
    });

    const result = await this.awaitPermission(requestId);
    if (result !== null && result.startsWith('allow')) {
      respond({ action: 'accept', content: null, _meta: null });
      return;
    }
    if (result === null) {
      respond({ action: 'cancel', content: null, _meta: null });
      return;
    }
    respond({ action: 'decline', content: null, _meta: null });
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

    // Reject all pending permissions and user inputs with cancel
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingPermissions.clear();
    for (const [, entry] of this.pendingUserInputs) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingUserInputs.clear();

    this.queue.push({ kind: 'runtime_error', error: reason });
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
    this.followUpsSentinelTail = '';
    this.followUpsSentinelsCompleteThisTurn = false;
    this.followUpsSilentOverviewTail = false;
    log.debug('chat', 'codex follow-ups hook poc turn armed', {
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
          log.debug('mcp', 'codex follow-ups hook poc set_follow_ups received', {
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
        if (this.followUpsExperimentMode === 'sentinel') {
          if (this.followUpsSentinelsCompleteThisTurn) {
            this.followUpsSilentOverviewTail = true;
          } else {
            log.warn('mcp', 'codex branch overview arrived before follow-up sentinels completed', {
              nodeId: this.id,
              threadId: this.threadId,
            });
          }
        }
        log.debug('mcp', 'codex follow-ups hook poc set_branch_overview received', {
          nodeId: this.id,
          threadId: this.threadId,
          length: cleaned.length,
          validationActive: this.followUpsValidationActive,
        });
        this.queue.push({ kind: 'branch_overview', overview: cleaned });
      },
      onValidateFollowUps: () => {
        if (!this.followUpsValidationActive) {
          log.debug('mcp', 'codex follow-ups hook poc validator skipped', {
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
          log.debug('mcp', 'codex follow-ups hook poc validator passed', {
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
            ? 'For set_branch_overview, provide 1-3 concise sentences about what this turn did.'
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

  private suppressFollowUpsInternalEvent(ev: NormalizedEvent): boolean {
    if (!this.followUpsHookPocEnabled) return false;
    const suppressVisibleMetadataTail =
      this.followUpsRepairMode || this.followUpsSilentOverviewTail;
    if (!suppressVisibleMetadataTail) return false;
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

  private suppressInternalMetadataToolEvent(ev: NormalizedEvent): boolean {
    if (ev.kind === 'tool_call') {
      if (!isInternalMetadataToolTitle(ev.title)) return false;
      if (ev.toolCallId) this.hiddenInternalToolCallIds.add(ev.toolCallId);
      return true;
    }
    if (ev.kind !== 'tool_call_update') return false;
    if (
      !this.hiddenInternalToolCallIds.has(ev.toolCallId)
      && !isInternalMetadataToolTitle(ev.title)
    ) return false;
    if (ev.toolCallId) this.hiddenInternalToolCallIds.add(ev.toolCallId);
    return true;
  }

  private observeFollowUpsSentinelEvent(ev: NormalizedEvent): void {
    if (
      !this.followUpsHookPocEnabled
      || this.followUpsExperimentMode !== 'sentinel'
      || this.followUpsSentinelsCompleteThisTurn
      || ev.kind !== 'chunk'
    ) return;
    this.followUpsSentinelTail = `${this.followUpsSentinelTail}${ev.text}`.slice(-12_000);
    this.followUpsSentinelsCompleteThisTurn =
      /\[FOLLOW-UP\s+3\s*\/\s*3\s*:\s*[^\]\r\n]*\]/i.test(this.followUpsSentinelTail);
  }

  private completeFollowUpsOutputBoundary(reason: 'agent-message-completed' | 'turn-completed'): void {
    if (!this.followUpsOutputBoundaryPending) return;
    this.followUpsOutputBoundaryPending = false;
    log.debug('chat', 'codex follow-ups visible output boundary completed', {
      nodeId: this.id,
      threadId: this.threadId,
      reason,
    });
    this.queue.push({ kind: 'follow_ups_status', status: 'completed' });
  }

  private finishFollowUpsHookPocTurn(): void {
    this.hiddenInternalToolCallIds.clear();
    if (this.followUpsHookPocEnabled && (
      this.followUpsSuppressedChunkEvents > 0
      || this.followUpsSuppressedThoughtEvents > 0
    )) {
      log.debug('chat', 'codex follow-ups hook poc hidden metadata output suppressed', {
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
    this.followUpsSentinelTail = '';
    this.followUpsSentinelsCompleteThisTurn = false;
    this.followUpsSilentOverviewTail = false;
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
            ownerUserId: this.ownerUserId,
            topics,
          });
          this.queue.push({ kind: 'spawn_branches', topics: result });
          return result;
        },
        onSaveArtifact: (name, body) => {
          const saved = this.bridge.saveContext({ cwd: this.cwd, chatId: this.id, ownerUserId: this.ownerUserId, name, body });
          if (saved) {
            this.queue.push({
              kind: 'artifact_saved',
              contextId: saved.id,
              name: saved.name,
              filePath: saved.filePath,
              size: saved.size,
            });
          }
          return saved;
        },
        onUpdateArtifact: (name, body) => {
          const updated = this.bridge.updateContext({ cwd: this.cwd, chatId: this.id, ownerUserId: this.ownerUserId, name, body });
          if (updated) {
            this.queue.push({
              kind: 'artifact_updated',
              contextId: updated.id,
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
        onAskUser: async (questions) => {
          const answers = await this.requestUserInput(questions);
          if (!answers) return null;
          const result: Record<string, string> = {};
          for (const answer of answers) {
            result[answer.question] = answer.answer;
          }
          return result;
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
      this.observeFollowUpsSentinelEvent(ev);
      if (this.suppressInternalMetadataToolEvent(ev)) return;
      if (this.suppressFollowUpsInternalEvent(ev)) return;
      if ((ev.kind === 'turn_end' || ev.kind === 'runtime_error') && this.state === 'in_turn') {
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
    for (const [, entry] of this.pendingUserInputs) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingUserInputs.clear();

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
