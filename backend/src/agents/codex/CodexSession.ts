import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentSession,
  AgentTurnInput,
  CancelAck,
  ChatMessage,
  CompactResult,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimeSessionOwner,
  RuntimeToolProfile,
  SteerResult,
} from '../types';
import type { NormalizedEvent, PermissionOption, UserInputQuestion } from '../../services/chatEvents';
import type { SubagentInfo } from 'michi-shared';
import type { McpSlotRegistry } from '../../services/mcpServer';
import type { AgentToolBridge } from '../toolBridge';
import type { CodexAppServerClient } from './CodexAppServerClient';
import { EventQueue } from '../eventQueue';
import { abortable } from '../runtimeLifecycle';
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
import { buildRunMcpSlotCallbacks } from '../runs/runMcpSlot';

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
  /**
   * Cheap model for the pre-turn title thread (e.g. `gpt-5.6-luna`). When
   * null/undefined the title thread uses the session's own model.
   */
  titleModel?: string | null;
  followUpsHookPocEnabled?: boolean;
  followUpsExperimentMode?: FollowUpsExperimentMode;
  /** Default true. When false, the per-turn follow-up reminder is suppressed. */
  enableFollowUps?: boolean;
  /** Explicit product owner. When omitted, a chat_node owner is inferred from nodeId. */
  owner?: RuntimeSessionOwner;
  /** Immutable hash of the effective runtime profile/capabilities for this session. */
  profileHash?: string | null;
  /** Tool profile for Agent Runs — carries allowed tool names and result collector hook. */
  toolProfile?: RuntimeToolProfile;
  /** Durable permission broker for Agent Runs. Chat sessions omit this. */
  permissionBroker?: RuntimePermissionBroker;
  recover?: (session: CodexSession) => Promise<void>;
  cancelTimeoutMs?: number;
}

export class CodexSession implements AgentSession {
  public readonly id: string;
  public readonly runtimeId = 'codex';
  public readonly parentChatId: string | undefined;
  /** Explicit product owner. Chat sessions default to `{ kind: 'chat_node', nodeId }`. */
  public readonly owner: RuntimeSessionOwner;
  /** Immutable profile hash used to reject unsafe session reuse. */
  public readonly runtimeProfileHash: string | null;
  /**
   * Runtime-owned resume/transport id (the Codex thread id). Distinct from the
   * Michi public session id for Agent Runs where `id === attemptId`.
   */
  public readonly nativeSessionId: string | null;
  public currentModeId: string | null = null;
  public currentModelId: string | null;
  /** Assistant text accumulated during the in-flight turn, exposed via
   *  getPendingAssistant() for auto-branch ancestor "in progress" stitching.
   *  Non-null only between turn start and the finally block. */
  private pendingAssistantBuf: string[] | null = null;
  public readonly threadId: string;
  public readonly workspaceId: string | null;
  public readonly effort: string | null;

  public readonly cwd: string;
  private readonly client: CodexAppServerClient;
  private readonly mcpRegistry: McpSlotRegistry;
  private readonly bridge: AgentToolBridge;
  private readonly mcpPort: number;
  private readonly ownerUserId: string | null;
  private readonly generateTitleOnFirstTurn: boolean;
  private readonly titleModel: string | null;
  private readonly followUpsHookPocEnabled: boolean;
  private readonly followUpsExperimentMode: FollowUpsExperimentMode;
  private readonly enableFollowUps: boolean;
  /** Tool profile for Agent Runs. Undefined for chat sessions. */
  private readonly toolProfile: RuntimeToolProfile | undefined;
  /** Durable permission broker for Agent Runs. Undefined for chat sessions. */
  private readonly permissionBroker: RuntimePermissionBroker | undefined;

  private state: SessionState = 'idle';
  private slotId: string | null = null;

  private queue: EventQueue;
  private readonly history: ChatMessage[] = [];
  private markTranslatorTurnStart: (() => void) | null = null;
  private unsubscribeNotification: (() => void) | null = null;

  // ---- Child subagent thread tracking ----------------------------------------
  private unsubGlobalNotification: (() => void) | null = null;
  private readonly childThreadInfos = new Map<string, SubagentInfo>();
  private readonly childNotificationUnsubs = new Map<string, () => void>();

  private firstTurnPrefix: string;
  private firstTurnPrefixConsumed = false;
  private titleGenerationAttempted = false;
  private readonly activeTurnThreadIds = new Set<string>();
  private cancelRequested = false;
  private activeNativeTurnId: string | null = null;
  private readonly nativeTurnIds = new Map<string, string>();
  private readonly interrupts = new Map<string, Promise<boolean>>();
  private readonly completedTurnIds = new Set<string>();
  private nativeSettled = true;
  private settleNativeTurn: (() => void) | null = null;
  private turnAbort: AbortController | null = null;
  private interactionAbort = new AbortController();
  private transportAbort = new AbortController();
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly recover?: CodexSessionDeps['recover'];
  private readonly cancelTimeoutMs: number;
  public requiresRestart = false;
  /** Native thread/fork id only — never becomes a Michi node id. */
  private alignedForkThreadId: string | null = null;

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
    this.titleModel = deps.titleModel ?? null;
    this.enableFollowUps = deps.enableFollowUps !== false;
    this.followUpsHookPocEnabled = deps.followUpsHookPocEnabled ?? false;
    this.followUpsExperimentMode =
      deps.followUpsExperimentMode ?? resolveFollowUpsExperimentMode();
    this.firstTurnPrefix = deps.firstTurnPrefix ?? '';
    this.effort = deps.effort ?? null;
    this.currentModelId = deps.model ?? null;

    // Run-specific fields
    this.owner = deps.owner ?? { kind: 'chat_node', nodeId: deps.nodeId };
    this.runtimeProfileHash = deps.profileHash ?? null;
    this.nativeSessionId = deps.threadId || null;
    this.toolProfile = deps.toolProfile;
    this.permissionBroker = deps.permissionBroker;
    this.recover = deps.recover;
    this.cancelTimeoutMs = deps.cancelTimeoutMs ?? 5_000;

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
    await this.acquireTurnLock();
    const controller = new AbortController();
    this.turnAbort = controller;
    const turnEventGate = { acceptTitle: true };
    try {
      this.cancelRequested = false;
      if (this.state === 'crashed') {
        if (!this.recover) throw new Error('Codex session needs native recovery before another turn.');
        yield { kind: 'retry_start', detail: 'Restoring original Codex session' };
        await abortable(this.recover(this), controller.signal);
        yield { kind: 'retry_end' };
      }
      controller.signal.throwIfAborted();
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
      this.interactionAbort = new AbortController();
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
          model: this.titleModel ?? this.currentModelId,
          userText: text,
          onThreadStarted: (threadId) => {
            titleThreadId = threadId;
            if (this.turnAbort === controller && !controller.signal.aborted) {
              this.activeTurnThreadIds.add(threadId);
            }
          },
          signal: controller.signal,
          onTurnStarted: (threadId, turnId) => {
            if (this.turnAbort !== controller) {
              void this.client.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => {});
              return;
            }
            this.nativeTurnIds.set(threadId, turnId);
            if (controller.signal.aborted) void this.interruptThread(threadId);
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
      this.nativeSettled = false;
      const nativeCompletion = new Promise<{ ok: true }>((resolve) => {
        this.settleNativeTurn = () => resolve({ ok: true });
      });
      const mainTurnStart = this.client.request('turn/start', {
        threadId: this.threadId,
        input: turnInput,
        ...(this.effort ? { effort: this.effort } : {}),
        summary: 'detailed',
      }).then(
        (result) => {
          const payload = result as { turn?: { id?: string }; turnId?: string } | null;
          const turnId = payload?.turn?.id ?? payload?.turnId;
          if (turnId && this.turnAbort === controller && !this.nativeSettled) {
            this.activeNativeTurnId = turnId;
            this.nativeTurnIds.set(this.threadId, turnId);
            if (this.cancelRequested) void this.interruptThread(this.threadId);
          }
          return { ok: true as const };
        },
        (error: unknown) => ({ ok: false as const, error }),
      );

      const mainStartResult = await abortable(
        Promise.race([mainTurnStart, nativeCompletion]),
        this.transportAbort.signal,
      );
      if (this.cancelRequested) {
        turnEventGate.acceptTitle = false;
        if (mainStartResult.ok) {
          for await (const ev of this.queue.drainUntilTurnEnd()) {
            if (ev.kind === 'runtime_error') break;
          }
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
    } catch (error) {
      if (!this.cancelRequested && !controller.signal.aborted) throw error;
      yield { kind: 'turn_end', stopReason: 'cancelled' };
    } finally {
      const finalState = this.state as SessionState;
      if (!this.nativeSettled && finalState !== 'crashed' && finalState !== 'disposed') {
        this.requiresRestart = true;
        this.markCrashed('Codex turn ended locally before native completion. Original thread retained.');
      }
      this.clearInteractions();
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
      controller.abort();
      if (this.turnAbort === controller) this.turnAbort = null;
      this.settleNativeTurn = null;
      this.pendingAssistantBuf = null;
      turnEventGate.acceptTitle = false;
      this.activeTurnThreadIds.clear();
      this.nativeTurnIds.clear();
      this.interrupts.clear();
      this.activeNativeTurnId = null;
      this.cancelRequested = false;
      if (this.state === 'in_turn') this.state = 'idle';
      this.finishFollowUpsHookPocTurn();
      this.releaseTurnLock();
    }
  }

  async cancel(): Promise<CancelAck> {
    if (!this.turnAbort && this.state !== 'in_turn' && this.activeTurnThreadIds.size === 0) {
      return { acknowledged: false };
    }
    this.cancelRequested = true;
    this.turnAbort?.abort();
    this.clearInteractions();
    if (!this.nativeSettled && !this.cancelTimer) {
      this.cancelTimer = setTimeout(() => {
        this.requiresRestart = true;
        this.markCrashed('Codex cancellation timed out. Original thread retained for native recovery.');
      }, this.cancelTimeoutMs);
    }
    const threadIds = this.activeTurnThreadIds.size > 0
      ? [...this.activeTurnThreadIds]
      : [this.threadId];
    const results = await Promise.all(threadIds.map((threadId) => this.interruptThread(threadId)));
    return { acknowledged: results.length > 0 && results.every(Boolean) };
  }

  async steer(text: string): Promise<SteerResult> {
    if (this.state !== 'in_turn') return { accepted: false, reason: 'not_in_turn' };
    const expectedTurnId = this.activeNativeTurnId ?? this.threadId;
    try {
      const result = await this.client.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId,
        input: [{ type: 'text', text }],
      });
      const turnId = result && typeof result === 'object' && typeof (result as { turnId?: unknown }).turnId === 'string'
        ? (result as { turnId: string }).turnId
        : expectedTurnId;
      return { accepted: true, pending: true, turnId };
    } catch (err) {
      log.warn('chat', 'codex turn/steer failed', {
        nodeId: this.id,
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { accepted: false, reason: 'steer_rpc_failed' };
    }
  }

  async compact(): Promise<CompactResult> {
    try {
      await this.client.request('thread/compact/start', { threadId: this.threadId });
      return { started: true };
    } catch (err) {
      log.warn('chat', 'codex thread/compact/start failed', {
        nodeId: this.id,
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { started: false };
    }
  }

  /**
   * Aligns a native Codex thread/fork id onto this session. Does not create
   * a Michi node — conversation fork remains the node/edge graph.
   */
  async alignNativeFork(): Promise<{ threadId?: string }> {
    try {
      const result = await this.client.request('thread/fork', { threadId: this.threadId });
      const forked = result && typeof result === 'object' && typeof (result as { thread?: { id?: unknown } }).thread === 'object'
        ? (result as { thread: { id?: unknown } }).thread.id
        : (result as { threadId?: unknown } | null)?.threadId;
      if (typeof forked === 'string' && forked) {
        this.alignedForkThreadId = forked;
        return { threadId: forked };
      }
      return {};
    } catch (err) {
      log.warn('chat', 'codex thread/fork align failed', {
        nodeId: this.id,
        threadId: this.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  describeNativeState(): Record<string, unknown> {
    return {
      threadId: this.threadId,
      alignedForkThreadId: this.alignedForkThreadId,
      activeNativeTurnId: this.activeNativeTurnId,
      michiNodeId: this.id,
    };
  }

  private async interruptThread(threadId: string): Promise<boolean> {
    const turnId = this.nativeTurnIds.get(threadId);
    if (!turnId) return false;
    const key = `${threadId}:${turnId}`;
    const pending = this.interrupts.get(key);
    if (pending) return pending;
    const work = this.client.request('turn/interrupt', { threadId, turnId }, this.cancelTimeoutMs).then(() => true, () => false);
    this.interrupts.set(key, work);
    return work;
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
    const isCurrent = this.controlIsCurrent(params);
    if (!isCurrent()) { respond({ answers: null }); return; }
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

    if (answers && isCurrent()) {
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
    const isCurrent = this.controlIsCurrent();
    if (!isCurrent()) return null;
    const requestId = ++this.nextRequestId;
    this.queue.push({ kind: 'user_input_request', requestId, questions });

    const answers = await new Promise<Array<{ question: string; answer: string }> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUserInputs.delete(requestId);
        resolve(null);
      }, APPROVE_TIMEOUT_MS);
      this.pendingUserInputs.set(requestId, { resolve, timer });
    });

    if (!isCurrent()) return null;
    this.queue.push({ kind: 'user_input_resolved', requestId, answers: answers ?? [] });
    return answers;
  }

  async askMcpElicitation(
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): Promise<void> {
    const isCurrent = this.controlIsCurrent(params);
    if (!isCurrent()) { respond({ action: 'cancel', content: null, _meta: null }); return; }
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
      source: 'codex_approval',
    });

    const result = await this.awaitPermission(requestId);
    if (!isCurrent()) { respond({ action: 'cancel', content: null, _meta: null }); return; }
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

  /**
   * Handle an approval request for this session. For agent_run owners, the
   * request is delegated to the Run permission broker — never to the
   * workspace policy resolver or grant persistence. Chat sessions retain
   * the existing user-facing permission request flow.
   */
  async askPermission(
    method: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): Promise<void> {
    const isCurrent = this.controlIsCurrent(params);
    if (!isCurrent()) { respond({ decision: 'decline' }); return; }
    const toolName = canonicalToolNameFromMethod(method);

    // Agent Run owner: delegate to the immutable Run permission broker.
    // MUST NOT call resolvePolicy() or grantPermission().
    if (this.owner.kind === 'agent_run' && this.permissionBroker) {
      let decision: RuntimePermissionDecision;
      try {
        decision = await abortable(this.permissionBroker.requestPermission({
          owner: this.owner,
          ownerUserId: this.ownerUserId,
          workspaceId: this.workspaceId,
          toolName: canonicalPermissionToolName(toolName),
          input: params,
        }), this.interactionAbort.signal);
      } catch {
        respond({ decision: 'decline' });
        return;
      }
      if (!isCurrent()) { respond({ decision: 'decline' }); return; }

      switch (decision) {
        case 'allow_once':
          respond({ decision: 'accept' });
          return;
        case 'allow_always':
          // Attempt-scoped allow → acceptForSession, but NEVER call grantPermission.
          respond({ decision: 'acceptForSession' });
          return;
        case 'deny':
          respond({ decision: 'decline' });
          return;
        case 'ask':
        default: {
          // Broker said "ask" → present as a user-facing permission request
          // using the standard approval flow (which routes through Run
          // interactions), but still never persist a grant.
          const requestId = ++this.nextRequestId;
          const options: PermissionOption[] = [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ];
          this.queue.push({
            kind: 'permission_request',
            requestId,
            title: `Approve ${toolName}?`,
            detail: formatCodexPermissionDetail(method, params),
            options,
            source: 'codex_approval',
          });
          const result = await this.awaitPermission(requestId);
          if (!isCurrent()) { respond({ decision: 'decline' }); return; }
          if (result !== null && result.startsWith('allow')) {
            respond({ decision: 'accept' });
            return;
          }
          respond({ decision: 'decline' });
          return;
        }
      }
    }

    // Chat session: existing user-facing permission request flow.
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
      source: 'codex_approval',
    });

    const result = await this.awaitPermission(requestId);

    if (!isCurrent()) { respond({ decision: 'decline' }); return; }

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
    this.transportAbort.abort(new Error(reason));
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = null;

    this.clearInteractions();

    // Clean up child thread tracking
    this.unsubGlobalNotification?.();
    this.unsubGlobalNotification = null;
    for (const [, unsub] of this.childNotificationUnsubs) unsub();
    this.childNotificationUnsubs.clear();
    this.childThreadInfos.clear();

    this.queue.push({ kind: 'runtime_error', error: reason });
    this.queue.push({ kind: 'turn_end', stopReason: 'error' });
    this.queue.dispose();
  }

  private clearInteractions(): void {
    this.interactionAbort.abort();
    for (const entries of [this.pendingPermissions, this.pendingUserInputs]) {
      for (const entry of entries.values()) { clearTimeout(entry.timer); entry.resolve(null); }
      entries.clear();
    }
  }

  isBusy(): boolean { return this.state === 'in_turn' || (this.state !== 'crashed' && !!this.turnLock); }
  needsRecovery(): boolean { return this.state === 'crashed'; }
  acceptsControl(params: Record<string, unknown>): boolean {
    if (this.state !== 'in_turn' || this.nativeSettled || !this.turnAbort || this.turnAbort.signal.aborted) return false;
    if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return false;
    return typeof params.turnId !== 'string' || params.turnId === this.activeNativeTurnId;
  }

  private controlIsCurrent(params: Record<string, unknown> = {}): () => boolean {
    const turn = this.turnAbort;
    return () => this.turnAbort === turn && this.acceptsControl(params);
  }

  async prepareNativeResume(): Promise<string> {
    await this.disposeMcpSlot();
    return this.createMcpSlot();
  }

  completeNativeResume(): void {
    if (this.state === 'disposed') throw new Error('Codex session was disposed during recovery');
    this.queue.dispose();
    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'in_turn') this.queue.push({ kind: 'heartbeat', idleMs });
    });
    this.transportAbort = new AbortController();
    this.nativeSettled = true;
    this.requiresRestart = false;
    this.state = 'idle';
    this.wireNotifications();
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

  /**
   * Create an MCP slot for this session. For agent_run owners, uses the
   * owner-aware `buildRunMcpSlotCallbacks` factory so the slot carries the
   * immutable owner identity, exposed tool allow-list, and
   * `submit_agent_result` hook. Chat sessions use the existing callback path.
   */
  createMcpSlot(): string {
    const chatCallbacks = {
      onSpawnBranches: async (topics: Array<{ title: string; prompt: string }>) => {
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
      onSaveArtifact: (name: string, body: string) => {
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
      onUpdateArtifact: (name: string, body: string) => {
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
      onShowImage: (inputPath: string, caption?: string) => {
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
      onAskUser: async (questions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect: boolean;
      }>) => {
        const answers = await this.requestUserInput(questions);
        if (!answers) return null;
        const result: Record<string, string> = {};
        for (const answer of answers) {
          result[answer.question] = answer.answer;
        }
        return result;
      },
      ...(this.followUpsHookPocEnabled ? this.followUpsHookCallbacks() : {}),
    };

    // Agent Run owner: use the Run MCP slot factory with owner metadata,
    // exposed tool allow-list, and submit_agent_result hook.
    if (this.owner.kind === 'agent_run' && this.toolProfile) {
      const runCallbacks = buildRunMcpSlotCallbacks({
        owner: this.owner as RuntimeSessionOwner & { kind: 'agent_run' },
        workspaceId: this.workspaceId,
        ownerUserId: this.ownerUserId,
        toolProfile: this.toolProfile,
        chatCallbacks,
      });

      const slot = this.mcpRegistry.create(
        this.id,
        this.cwd,
        this.ownerUserId,
        runCallbacks,
        { nodeId: null, workspaceId: this.workspaceId },
      );
      this.slotId = slot.slotId;
      return slot.slotId;
    }

    // Chat session: existing MCP slot creation path.
    const slot = this.mcpRegistry.create(
      this.id,
      this.cwd,
      this.ownerUserId,
      chatCallbacks,
      { nodeId: this.id, workspaceId: this.workspaceId },
    );
    this.slotId = slot.slotId;
    return slot.slotId;
  }

  // ---- Translator wiring ----------------------------------------------------

  wireNotifications(): void {
    this.unsubscribeNotification?.();
    this.unsubGlobalNotification?.();
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
        if (this.state === 'crashed' || this.state === 'disposed' || this.nativeSettled) return;
        const turn = params.turn as { id?: string; status?: string } | undefined;
        const turnId = typeof params.turnId === 'string' ? params.turnId : turn?.id;
        if (turnId && (this.completedTurnIds.has(turnId) || (this.activeNativeTurnId && this.activeNativeTurnId !== turnId))) return;
        if (turnId) {
          this.activeNativeTurnId = turnId;
          this.nativeTurnIds.set(this.threadId, turnId);
        }
        if (method === 'turn/completed') {
          this.nativeSettled = true;
          this.settleNativeTurn?.();
          if (turnId) this.completedTurnIds.add(turnId);
          if (this.completedTurnIds.size > 100) this.completedTurnIds.delete(this.completedTurnIds.values().next().value!);
          if (this.cancelTimer) clearTimeout(this.cancelTimer);
          this.cancelTimer = undefined;
          this.clearInteractions();
          this.completeFollowUpsOutputBoundary('turn-completed');
        }
        translator.feed(method, params);
        if (method === 'turn/started' && this.cancelRequested) void this.interruptThread(this.threadId);
        if (method === 'item/completed') {
          const item = (params['item'] ?? params) as Record<string, unknown>;
          if (item['type'] === 'agentMessage') {
            this.completeFollowUpsOutputBoundary('agent-message-completed');
          }
        }
      },
    );

    // ---- Child subagent thread discovery via global notification handler -----
    this.unsubGlobalNotification = this.client.onGlobalNotification((method, params) => {
      if (method === 'thread/started') {
        this.handleChildThreadStarted(params);
      } else if (method === 'thread/status/changed' || method === 'thread/closed') {
        this.handleChildThreadLifecycle(method, params);
      }
    });
  }

  // ---- Child subagent thread handling ----------------------------------------

  private handleChildThreadStarted(params: Record<string, unknown>): void {
    const thread = (params['thread'] ?? params) as Record<string, unknown>;
    const parentId = typeof thread['parentThreadId'] === 'string' ? thread['parentThreadId'] : null;
    if (parentId !== this.threadId) return; // Not our child

    const childId = typeof thread['id'] === 'string' ? thread['id'] : '';
    if (!childId || this.childThreadInfos.has(childId)) return; // Already tracked

    // Extract agent identity from Thread object
    const agentNickname = typeof thread['agentNickname'] === 'string' ? thread['agentNickname'] : '';
    const agentRole = typeof thread['agentRole'] === 'string' ? thread['agentRole'] : '';
    const preview = typeof thread['preview'] === 'string' ? thread['preview'] : '';

    // Dig into SubAgentSource for richer metadata
    let spawnNickname = '';
    let spawnRole = '';
    const source = thread['source'];
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const subAgent = (source as Record<string, unknown>)['subAgent'];
      if (subAgent && typeof subAgent === 'object' && !Array.isArray(subAgent)) {
        const spawn = (subAgent as Record<string, unknown>)['thread_spawn'];
        if (spawn && typeof spawn === 'object' && !Array.isArray(spawn)) {
          const s = spawn as Record<string, unknown>;
          spawnNickname = typeof s['agent_nickname'] === 'string' ? s['agent_nickname'] : '';
          spawnRole = typeof s['agent_role'] === 'string' ? s['agent_role'] : '';
        }
      }
    }

    const name = agentNickname || spawnNickname || agentRole || spawnRole || childId.slice(0, 8);
    const info: SubagentInfo = {
      sessionId: childId,
      sessionName: name,
      agentName: agentNickname || spawnNickname || 'subagent',
      initialQuery: preview,
      status: 'working',
      statusMessage: '',
      group: '',
      dependsOn: [],
    };
    this.childThreadInfos.set(childId, info);

    log.debug('chat', 'codex child subagent thread discovered', {
      nodeId: this.id,
      parentThreadId: this.threadId,
      childThreadId: childId,
      agentName: info.agentName,
    });

    // Push roster update
    this.queue.push({
      kind: 'subagent_list_update',
      subagents: [...this.childThreadInfos.values()],
    });

    // Subscribe to child thread notifications → translate tool activity
    const childTranslator = createCodexTranslator((ev) => {
      if (ev.kind === 'tool_call' || ev.kind === 'tool_call_update') {
        this.queue.push({
          kind: 'subagent_tool_activity',
          subagentSessionId: childId,
          title: ev.title,
          status: ev.status ?? '',
        });
        // Update roster statusMessage with latest tool title
        info.statusMessage = ev.title;
        this.queue.push({
          kind: 'subagent_list_update',
          subagents: [...this.childThreadInfos.values()],
        });
      }
      if (ev.kind === 'turn_end') {
        info.status = 'terminated';
        this.queue.push({
          kind: 'subagent_list_update',
          subagents: [...this.childThreadInfos.values()],
        });
      }
    });

    const unsub = this.client.onNotification(childId, (childMethod, childParams) => {
      childTranslator.feed(childMethod, childParams);
    });
    this.childNotificationUnsubs.set(childId, unsub);
  }

  private handleChildThreadLifecycle(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : '';
    const info = this.childThreadInfos.get(threadId);
    if (!info) return;

    if (method === 'thread/closed' || method === 'thread/status/changed') {
      const status = params['status'];
      const isClosed = method === 'thread/closed'
        || (typeof status === 'object' && status !== null && (status as Record<string, unknown>)['type'] === 'idle');
      if (isClosed) {
        info.status = 'terminated';
        log.debug('chat', 'codex child subagent thread terminated', {
          nodeId: this.id,
          childThreadId: threadId,
        });
        this.queue.push({
          kind: 'subagent_list_update',
          subagents: [...this.childThreadInfos.values()],
        });
      }
    }
  }

  // ---- Dispose --------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.turnAbort?.abort();
    this.transportAbort.abort(new Error('Codex session disposed'));
    if (this.cancelTimer) clearTimeout(this.cancelTimer);

    this.clearInteractions();

    // Unsubscribe notification handler
    this.unsubscribeNotification?.();
    this.unsubscribeNotification = null;

    // Unsubscribe global + child thread notification handlers
    this.unsubGlobalNotification?.();
    this.unsubGlobalNotification = null;
    for (const [, unsub] of this.childNotificationUnsubs) unsub();
    this.childNotificationUnsubs.clear();
    this.childThreadInfos.clear();

    // Best-effort thread/unsubscribe (skip if crashed)
    try {
      await this.client.request('thread/unsubscribe', { threadId: this.threadId }, 2_000);
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
