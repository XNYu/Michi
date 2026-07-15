import * as fs from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentSession, ChatMessage, LoadAgentSessionOptions, NewAgentSessionOptions } from '../types';
import type { NormalizedEvent, PermissionOption } from '../../services/chatEvents';
import type { McpSlotRegistry } from '../../services/mcpServer';
import type { AgentToolBridge } from '../toolBridge';
import { spawnClaude } from './claudeBinary';
import { ClaudeInitTimeoutError } from './claudeBinary';
import { createClaudeEnvelopeParser } from './claudeEnvelopeParser';
import { createClaudeStdoutHandler } from './claudeStdoutProbe';
import { createTranslator } from './claudeEventTranslator';
import { getClaudeJsonlPath } from './claudeProjectsPath';
import { buildClaudeMcpConfig } from './claudeMcpConfig';
import { resolveShowImage } from './showImage';
import { canonicalPermissionToolName, resolvePolicy } from '../permissionPolicy';
import { grantPermission, setNodeExternalSessionId } from '../../services/dbRepository';
import { getAgentConfig, resolveReasoning } from '../../services/agentConfig';
import type { AgentReasoning } from '../types';
import { EventQueue } from '../eventQueue';
import { followUpReminder } from '../preamble';
import { AsyncGate } from '../asyncGate';
import { log } from '../../services/logger';
import {
  buildClaudeFollowUpsHookPocSettings,
  buildClaudeFollowUpsHookPocInstruction,
  isClaudeFollowUpsHookPocEnabled,
} from './claudeFollowUpsHookPoc';
import {
  FOLLOW_UPS_SENTINEL_TURN_REMINDER,
  resolveFollowUpsExperimentMode,
  type FollowUpsExperimentMode,
} from '../followUpsExperiment';

// claude --effort accepts low|medium|high|xhigh|max. Pi's "minimal" tier
// has no claude equivalent, so it maps to the next-lowest claude level.
function reasoningToClaudeEffort(
  r: AgentReasoning | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!r) return undefined;
  if (r === 'minimal') return 'low';
  return r;
}

// ---- Constants ---------------------------------------------------------------

// Default 60s — claude's SessionStart hooks can take 10-20s on heavily-loaded
// configs (financial-services, superpowers, etc). 5s was too aggressive in
// real-world envs. Override via MICHI_CLAUDE_INIT_TIMEOUT_MS.
const SPAWN_INIT_TIMEOUT_MS = parseInt(process.env.MICHI_CLAUDE_INIT_TIMEOUT_MS ?? '60000', 10);
const APPROVE_TIMEOUT_MS = parseInt(process.env.MICHI_APPROVE_TIMEOUT_MS ?? '300000', 10);
const DISPOSE_TERM_TIMEOUT_MS = parseInt(process.env.MICHI_CLAUDE_DISPOSE_TERM_TIMEOUT_MS ?? '2000', 10);
const DISPOSE_KILL_TIMEOUT_MS = parseInt(process.env.MICHI_CLAUDE_DISPOSE_KILL_TIMEOUT_MS ?? '1000', 10);

// ---- Session state -----------------------------------------------------------

type SessionState = 'spawning' | 'idle' | 'in_turn' | 'crashed' | 'disposed';

export interface ClaudeSessionDeps {
  nodeId: string;
  cwd: string;
  workspaceId: string | null;
  parentChatId?: string;
  model?: string | null;
  /** Text appended to claude's system prompt via --append-system-prompt.
   *  Populated by ClaudeRuntime.newSession with the michi preamble (ancestor
   *  chain, context manifest, [TITLE:]/[FOLLOW-UPS:] sentinels). */
  systemPromptAppend?: string;
  mcpRegistry: McpSlotRegistry;
  bridge: AgentToolBridge;
  mcpPort: number;
  /** Cloud-mode owner. Used to namespace the Claude project history directory
   *  so two users sharing the same cwd slug don't collide. Desktop: null. */
  ownerUserId?: string | null;
}

// ---- ClaudeSession -----------------------------------------------------------

export class ClaudeSession implements AgentSession {
  // `id` and `nodeId` are mutable so a warm-pool session (spawned with an
  // anonymous UUID before any chat exists) can adopt the real chat's
  // identifier at handoff via rebindIdentity(). After rebindIdentity has
  // run once, the firstTurnPrefixConsumed gate prevents further mutation.
  public id: string;
  public readonly runtimeId = 'claude';
  public readonly parentChatId: string | undefined;
  public currentModeId: string | null = null;

  private nodeId: string;
  private readonly cwd: string;
  private workspaceId: string | null;
  private readonly model: string | undefined;
  private ownerUserId: string | null;
  private readonly systemPromptAppend: string | undefined;
  private readonly mcpRegistry: McpSlotRegistry;
  private readonly bridge: AgentToolBridge;
  private readonly mcpPort: number;

  private state: SessionState = 'spawning';
  private child: ChildProcessWithoutNullStreams | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  private slotId: string | null = null;
  private externalSessionId: string | null = null;
  private lastUsedAt = Date.now();
  private mwinitNoticeSent = false;
  private readonly followUpsHookPocEnabled = isClaudeFollowUpsHookPocEnabled();
  private readonly followUpsExperimentMode: FollowUpsExperimentMode =
    resolveFollowUpsExperimentMode();
  private followUpsValidationActive = false;
  private followUpsSetThisTurn = false;
  private branchOverviewSetThisTurn = false;
  private followUpsStopBlockUsed = false;
  private followUpsRepairMode = false;
  private followUpsSuppressedChunkEvents = 0;
  private followUpsSuppressedThoughtEvents = 0;
  private followUpsOutputBoundaryPending = false;

  private queue: EventQueue;
  private readonly history: ChatMessage[] = [];
  private markTranslatorTurnStart: (() => void) | null = null;

  // Per-chat preamble — set by ClaudeRuntime.newSession after pulling the
  // session out of the warm pool (or right after spawnFresh on a cold spawn).
  // Prepended to the first real send() text, then discarded. The warm-init
  // turn does NOT consume the prefix — it's specifically for the first user
  // turn AFTER warm.
  private firstTurnPrefix: string = '';
  private firstTurnPrefixConsumed: boolean = false;

  // Turn mutex: non-null while a turn is in flight
  private turnLock: Promise<void> | null = null;
  private turnLockRelease: (() => void) | null = null;

  // Permission state
  private nextRequestId = 0;
  private readonly pendingPermissions = new Map<
    number,
    { resolve: (optionId: string | null) => void; timer: NodeJS.Timeout }
  >();

  // Disposed callback
  private disposedCallback: (() => void) | undefined;
  private disposedCallbackFired = false;

  constructor(id: string, deps: ClaudeSessionDeps) {
    this.id = id;
    this.nodeId = deps.nodeId;
    this.cwd = deps.cwd;
    this.workspaceId = deps.workspaceId;
    this.parentChatId = deps.parentChatId;
    this.model = deps.model ?? undefined;
    this.ownerUserId = deps.ownerUserId ?? null;
    this.systemPromptAppend = deps.systemPromptAppend;
    this.mcpRegistry = deps.mcpRegistry;
    this.bridge = deps.bridge;
    this.mcpPort = deps.mcpPort;

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

  /**
   * True iff the underlying claude CLI process is still usable for a turn.
   * Returns false on `disposed` (explicit teardown) or `crashed` (process
   * exited unexpectedly). The warm pool uses this to skip dead entries on
   * `take()` instead of handing them to a chat that would error on first send.
   */
  isAlive(): boolean {
    return this.state !== 'disposed' && this.state !== 'crashed';
  }

  getState(): SessionState {
    return this.state;
  }

  getLastUsedAt(): number {
    return this.lastUsedAt;
  }

  getPendingAssistant(): string | undefined {
    return undefined;
  }

  async *send(text: string): AsyncIterableIterator<NormalizedEvent> {
    if (this.state === 'disposed') {
      yield { kind: 'turn_end', stopReason: 'error' };
      return;
    }

    await this.acquireTurnLock();
    try {
      this.lastUsedAt = Date.now();
      if (this.state === 'crashed') {
        if (!this.externalSessionId) {
          yield { kind: 'turn_end', stopReason: 'error' };
          return;
        }
        await this.spawnResume(this.externalSessionId);
      }

      this.state = 'in_turn';

      // Inject per-chat preamble on the first real turn, then mark consumed.
      // Empty prefix is a no-op. The warm-init turn does NOT pass through
      // this branch — it uses its own envelope path in warmInit().
      const outgoingText = this.firstTurnPrefixConsumed || !this.firstTurnPrefix
        ? text
        : `${this.firstTurnPrefix}\n\n---\n\n${text}`;
      this.firstTurnPrefixConsumed = true;

      // Append follow-up reminder for the model only — keep history clean so
      // fork/branch transcripts don't accumulate reminder noise.
      const userTurnCount = this.history.filter(m => m.role === 'user').length + 1;
      const reminder = this.followUpsHookPocEnabled && this.followUpsExperimentMode === 'sentinel'
        ? FOLLOW_UPS_SENTINEL_TURN_REMINDER
        : followUpReminder(userTurnCount, true);
      const textForModel = reminder ? outgoingText + reminder : outgoingText;

      this.armFollowUpsHookPoc(userTurnCount);

      this.history.push({ role: 'user', content: outgoingText });
      this.markTranslatorTurnStart?.();
      this.writeStdin(userEnvelope(outgoingText));

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
      this.lastUsedAt = Date.now();
    } finally {
      this.finishFollowUpsHookPocTurn();
      this.releaseTurnLock();
    }
  }

  /** Read-only view of the claude SDK's session_id, captured on system/init.
   *  Used by ClaudeRuntime to re-issue setNodeExternalSessionId() after
   *  rebinding a warm-pool session to a real chat's nodeId. */
  getExternalSessionId(): string | null {
    return this.externalSessionId;
  }

  /**
   * Rebind this session's public id + internal nodeId. Used exclusively
   * when a warm-pool session is handed off to a real chat that has a
   * stable michi-side nodeId.
   *
   * Idempotent until first user send is consumed; throws after to prevent
   * silent identity changes that would corrupt sessionRegistry / db state.
   */
  rebindIdentity(
    newId: string,
    newNodeId: string,
    opts?: { workspaceId?: string | null; ownerUserId?: string | null },
  ): void {
    if (this.firstTurnPrefixConsumed) {
      throw new Error('rebindIdentity called after first turn already sent');
    }
    this.id = newId;
    this.nodeId = newNodeId;
    if (opts && 'workspaceId' in opts) this.workspaceId = opts.workspaceId ?? null;
    if (opts && 'ownerUserId' in opts) this.ownerUserId = opts.ownerUserId ?? null;
    this.syncMcpSlotBinding();
  }

  private syncMcpSlotBinding(): void {
    if (!this.slotId) return;
    const slot = this.mcpRegistry.get(this.slotId);
    if (!slot) return;
    slot.parentChatId = this.id;
    slot.nodeId = this.nodeId;
    slot.workspaceId = this.workspaceId;
    slot.ownerUserId = this.ownerUserId;
  }

  /**
   * Attach a per-chat preamble to be prepended to the first real send().
   *
   * Idempotent until first send consumes it; throws on later calls so the
   * caller can't silently lose context by re-setting after a turn.
   * Called by ClaudeRuntime.newSession once it has the chat's
   * NewAgentSessionOptions in hand.
   */
  setFirstTurnPrefix(prefix: string): void {
    if (this.firstTurnPrefixConsumed) {
      throw new Error('setFirstTurnPrefix called after first turn already sent / consumed');
    }
    this.firstTurnPrefix = prefix;
  }

  /**
   * Trigger system/init without invoking the model.
   *
   * Writes a stream-json user envelope with `shouldQuery: false`. Claude
   * pays the ~7s cli init cost (auth, system-prompt parsing, internal state
   * setup), then closes the turn with `result/success` — no `assistant`
   * envelope is emitted and no Anthropic API call is made.
   *
   * Used by ClaudeWarmPool to pre-warm sessions in the background so the
   * user's first real message hits a session that has already paid init.
   *
   * Resolves when the synthetic `turn_end` arrives. Rejects only if called
   * on a disposed or crashed session.
   */
  async warmInit(): Promise<void> {
    if (this.state === 'disposed' || this.state === 'crashed') {
      throw new Error(`warmInit on ${this.state} session`);
    }

    await this.acquireTurnLock();
    try {
      this.lastUsedAt = Date.now();
      this.state = 'in_turn';
      this.markTranslatorTurnStart?.();

      // Direct stream-json envelope (not via userEnvelope helper) because we
      // need the `shouldQuery: false` field. Verified empirically: claude
      // emits system/init + result/success with NO assistant envelope.
      const envelope = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '__michi:warm__' },
        shouldQuery: false,
        parent_tool_use_id: null,
      }) + '\n';
      this.writeStdin(envelope);

      // Drain until the synthetic turn_end the translator emits from
      // result/success. Every event is discarded — warm produces no visible
      // output, and the dummy turn intentionally does not write to history.
      for await (const ev of this.queue.drainUntilTurnEnd()) {
        void ev;
      }

      const stateAfterWarm = this.state as SessionState;
      if (stateAfterWarm !== 'crashed' && stateAfterWarm !== 'disposed') {
        this.state = 'idle';
      }
      this.lastUsedAt = Date.now();
    } finally {
      this.releaseTurnLock();
    }
  }

  async cancel(): Promise<void> {
    if (this.state !== 'in_turn') return;
    try { this.child?.kill('SIGINT'); } catch {}
    const exitedAfterInterrupt = await this.waitForExit(DISPOSE_TERM_TIMEOUT_MS);
    if (!exitedAfterInterrupt) {
      try { this.child?.kill('SIGKILL'); } catch {}
      await this.waitForExit(DISPOSE_KILL_TIMEOUT_MS);
    }
    this.state = 'crashed';
    await this.disposeSlot();
    this.fireDisposedCallback();
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

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.queue.dispose();
    this.markTranslatorTurnStart = null;

    // Reject pending permissions
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingPermissions.clear();

    const child = this.child;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      const exitedAfterTerm = await this.waitForExit(DISPOSE_TERM_TIMEOUT_MS);
      if (!exitedAfterTerm) {
        try { child.kill('SIGKILL'); } catch {}
        await this.waitForExit(DISPOSE_KILL_TIMEOUT_MS);
      }
    }

    await this.disposeSlot();

    this.fireDisposedCallback();
  }

  onDisposed(cb: () => void): void {
    this.disposedCallback = cb;
    if (this.disposedCallbackFired) cb();
  }

  // ---- Spawn ------------------------------------------------------------------

  async spawnFresh(): Promise<void> {
    const slot = this.mcpRegistry.create(this.id, this.cwd, this.ownerUserId ?? null, {
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
          this.queue.push({ kind: 'context_saved', name: saved.name, filePath: saved.filePath, size: saved.size });
        }
        return saved;
      },
      onUpdateContext: (name, body) => {
        const updated = this.bridge.updateContext({ cwd: this.cwd, name, body });
        if (updated) {
          this.queue.push({ kind: 'context_updated', name: updated.name, filePath: updated.filePath, size: updated.size });
        }
        return updated;
      },
      onShowImage: (inputPath, caption) => {
        const r = resolveShowImage(this.cwd, inputPath);
        if (!r.ok) return { error: r.error };
        this.queue.push({ kind: 'image', path: r.relPath, caption, mimeType: r.mimeType, size: r.size });
        return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
      },
      ...(this.followUpsHookPocEnabled ? this.followUpsHookCallbacks() : {}),
      onApprove: this.makeOnApprove(),
    }, {
      nodeId: this.nodeId,
      workspaceId: this.workspaceId,
    });
    this.slotId = slot.slotId;

    const mcpConfig = buildClaudeMcpConfig(slot.slotId, this.mcpPort);
    // claude --session-id requires UUID format; michi nodeIds don't conform.
    // The placeholder is overwritten when system/init reports the real session_id.
    await this.doSpawn({ sessionId: randomUUID(), mcpConfig });
  }

  async spawnResume(externalSessionId: string): Promise<void> {
    // Invariant 4: JSONL tail integrity check
    this.checkAndRepairJsonl(this.cwd, externalSessionId, this.ownerUserId);

    // Dispose the old slot before creating a new one (invariant: each process needs fresh slot)
    if (this.slotId) {
      await this.mcpRegistry.dispose(this.slotId).catch(() => {});
      this.slotId = null;
    }

    const slot = this.mcpRegistry.create(this.id, this.cwd, this.ownerUserId ?? null, {
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
          this.queue.push({ kind: 'context_saved', name: saved.name, filePath: saved.filePath, size: saved.size });
        }
        return saved;
      },
      onUpdateContext: (name, body) => {
        const updated = this.bridge.updateContext({ cwd: this.cwd, name, body });
        if (updated) {
          this.queue.push({ kind: 'context_updated', name: updated.name, filePath: updated.filePath, size: updated.size });
        }
        return updated;
      },
      onShowImage: (inputPath, caption) => {
        const r = resolveShowImage(this.cwd, inputPath);
        if (!r.ok) return { error: r.error };
        this.queue.push({ kind: 'image', path: r.relPath, caption, mimeType: r.mimeType, size: r.size });
        return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
      },
      ...(this.followUpsHookPocEnabled ? this.followUpsHookCallbacks() : {}),
      onApprove: this.makeOnApprove(),
    }, {
      nodeId: this.nodeId,
      workspaceId: this.workspaceId,
    });
    this.slotId = slot.slotId;

    const mcpConfig = buildClaudeMcpConfig(slot.slotId, this.mcpPort);
    await this.doSpawn({ resumeSessionId: externalSessionId, mcpConfig });
  }

  // ---- Private helpers -------------------------------------------------------

  private async doSpawn(opts: { sessionId?: string; resumeSessionId?: string; mcpConfig: string }): Promise<void> {
    this.state = 'spawning';

    // Reset queue for new spawn
    this.queue.dispose();
    this.queue = new EventQueue((idleMs) => {
      if (this.state === 'idle' || this.state === 'in_turn') {
        this.queue.push({ kind: 'heartbeat', idleMs });
      }
    });

    const translator = createTranslator((ev) => {
      if (this.suppressFollowUpsRepairEvent(ev)) return;
      // Drive the idle transition from the claude process's own end-of-turn
      // signal (the `result` envelope, which the translator turns into
      // turn_end) rather than from whether the HTTP consumer drains the
      // generator. The /chats/:id/message route breaks its for-await on
      // turn_end, which invokes the generator's .return() and unwinds straight
      // to send()'s finally — skipping the post-loop `state = 'idle'`
      // assignment. That left every finished session pinned in `in_turn`
      // forever, and reclaimActiveSession only reclaims idle/crashed/disposed,
      // so the slots were never reclaimable (→ ClaudeConcurrencyError 503s with
      // only a few sessions actually busy). Flipping here decouples liveness
      // from the consumer. Guarded on `in_turn` so synthetic turn_ends pushed
      // on crash/exit (state already 'crashed') don't get clobbered to idle.
      if (ev.kind === 'turn_end' && this.state === 'in_turn') {
        this.state = 'idle';
        this.lastUsedAt = Date.now();
      }
      this.queue.push(ev);
    });
    this.markTranslatorTurnStart = translator.startTurn;

    const parser = createClaudeEnvelopeParser(
      (envelope) => {
        this.logFollowUpsHookEnvelope(envelope);
        this.completeFollowUpsOutputBoundaryFromEnvelope(envelope);
        // Invariant 6: persist external_session_id on init before forwarding events
        if (envelope['type'] === 'system' && envelope['subtype'] === 'init') {
          const sessionId = envelope['session_id'] as string | undefined;
          if (sessionId) {
            if (this.externalSessionId && this.externalSessionId !== sessionId) {
              console.warn(
                `[ClaudeSession] session_id mismatch: expected ${this.externalSessionId}, got ${sessionId}`,
              );
            }
            this.externalSessionId = sessionId;
            try {
              setNodeExternalSessionId(this.nodeId, sessionId);
            } catch (err) {
              console.warn(`[ClaudeSession] setNodeExternalSessionId failed:`, err);
            }
          }
        }
        translator.feed(envelope);
      },
      (err, raw) => {
        console.warn(`[ClaudeSession] envelope parse error: ${err.message} raw=${raw.slice(0, 80)}`);
      },
    );

    const systemPromptAppend = [
      this.systemPromptAppend,
      this.followUpsHookPocEnabled
        ? buildClaudeFollowUpsHookPocInstruction(this.followUpsExperimentMode)
        : '',
    ].filter(Boolean).join('\n');
    if (this.followUpsHookPocEnabled) {
      log.info('chat', 'claude follow-ups hook poc enabled', {
        nodeId: this.nodeId,
        sessionId: this.id,
        slotId: this.slotId ?? undefined,
        followUpsMode: this.followUpsExperimentMode,
      });
    }

    const child = spawnClaude({
      cwd: this.cwd,
      sessionId: opts.sessionId,
      resumeSessionId: opts.resumeSessionId,
      permissionMode: 'default',
      permissionPromptTool: 'mcp____michi_internal____approve',
      mcpConfigInline: opts.mcpConfig,
      settingsInline: this.followUpsHookPocEnabled
        ? buildClaudeFollowUpsHookPocSettings()
        : undefined,
      includeHookEvents: this.followUpsHookPocEnabled,
      // Default: let claude auto-discover the user's own MCP servers
      // (~/.claude/settings.json, project .mcp.json, plugin MCPs). __michi_internal__
      // is still injected via --mcp-config so the agent↔Michi protocol (approve,
      // save_context, spawn_branches) is always available. Set MICHI_CLAUDE_STRICT_MCP=1
      // to lock the agent to ONLY __michi_internal__ — useful for multi-tenant
      // deploys where host MCP must not leak in.
      strictMcpConfig: process.env.MICHI_CLAUDE_STRICT_MCP === '1',
      // Bare mode skips SessionStart hooks, plugins, skills, MCP auto-discovery.
      // Without it, configs with many plugins (financial-services, superpowers)
      // take 10-20s to emit system/init. Tests / CI / smoke runs opt in via env.
      // Production toggle is a follow-up; default to bare=false until then.
      bare: this.followUpsHookPocEnabled ? false : process.env.MICHI_CLAUDE_BARE === '1',
      model: this.model,
      effort: reasoningToClaudeEffort(resolveReasoning(getAgentConfig().runtime)),
      systemPromptAppend,
    });
    this.child = child;

    let exitResolve!: () => void;
    this.exitPromise = new Promise<void>((r) => { exitResolve = r; });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', createClaudeStdoutHandler(
      (chunk) => parser.push(chunk),
      { sessionId: this.id, nodeId: this.nodeId },
    ));
    child.stdout.on('end', () => parser.flush());

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Surface stderr as mcp_server_error only when meaningful
      const trimmed = chunk.trim();
      if (!trimmed) return;
      console.warn(`[ClaudeSession] stderr: ${trimmed.slice(0, 200)}`);
      // claude CLI prints this when the awsCredentialExport hook can't
      // produce credentials. Surface a user-visible banner with a generic
      // recovery hint.
      if (!this.awsCredentialNoticeSent && /awsCredentialExport did not return a valid value/i.test(trimmed)) {
        this.awsCredentialNoticeSent = true;
        this.queue.push({
          kind: 'mcp_server_error',
          serverName: 'aws-credentials',
          error: 'AWS credentials unavailable. Refresh your AWS credentials in the terminal, then retry.',
        });
      }
    });

    child.on('exit', () => {
      // If the process exits while a turn is in progress, the translator did
      // not see Claude's `result/success` envelope. Treat that as incomplete
      // even when the process exit code is 0; Claude hooks can still exit cleanly
      // after a failed/interrupted turn.
      if (this.state === 'in_turn') {
        this.queue.push({ kind: 'turn_end', stopReason: 'error' });
      }
      if (this.state !== 'disposed') {
        this.state = 'crashed';
        this.queue.dispose();
        this.markTranslatorTurnStart = null;
        void this.disposeSlot();
        this.fireDisposedCallback();
      }
      exitResolve();
    });

    // ARCHITECTURAL NOTE (Invariant 5 update):
    //
    // claude in --input-format stream-json mode does NOT emit `system/init`
    // until the first user envelope arrives on stdin. Verified with claude
    // 2.1.138: even with --bare, init waits for stdin input. So we cannot
    // block here on `awaitInit` — it would deadlock indefinitely.
    //
    // Instead: mark the session 'idle' immediately. The translator captures
    // `claudeSessionId` whenever init eventually arrives (which is during
    // the first send() turn). external_session_id persistence happens in
    // the envelope handler attached above, gated on every init envelope.
    //
    // If init never arrives during the first send() (claude is hung or
    // crashed), the user's send() will naturally time out via the heartbeat
    // / turn-level supervision. The 5s spawn-init timeout no longer applies.
    this.state = 'idle';
  }

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
    log.info('chat', 'claude follow-ups hook poc turn armed', {
      nodeId: this.nodeId,
      sessionId: this.id,
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
          log.info('mcp', 'claude follow-ups hook poc set_follow_ups received', {
            nodeId: this.nodeId,
            sessionId: this.id,
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
        log.info('mcp', 'claude follow-ups hook poc set_branch_overview received', {
          nodeId: this.nodeId,
          sessionId: this.id,
          length: cleaned.length,
          validationActive: this.followUpsValidationActive,
        });
        this.queue.push({ kind: 'branch_overview', overview: cleaned });
      },
      onValidateFollowUps: () => {
        if (!this.followUpsValidationActive) {
          log.info('mcp', 'claude follow-ups hook poc validator skipped', {
            nodeId: this.nodeId,
            sessionId: this.id,
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
          log.info('mcp', 'claude follow-ups hook poc validator passed', {
            nodeId: this.nodeId,
            sessionId: this.id,
          });
          return {};
        }
        if (!this.followUpsStopBlockUsed) {
          this.followUpsStopBlockUsed = true;
          this.followUpsRepairMode = true;
          log.warn('mcp', 'claude follow-ups hook poc blocked stop', {
            nodeId: this.nodeId,
            sessionId: this.id,
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
        log.warn('mcp', 'claude follow-ups hook poc fail-open', {
          nodeId: this.nodeId,
          sessionId: this.id,
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

  private completeFollowUpsOutputBoundaryFromEnvelope(
    envelope: Record<string, unknown>,
  ): void {
    if (!this.followUpsOutputBoundaryPending) return;
    const type = typeof envelope.type === 'string' ? envelope.type : '';
    const streamEvent = envelope.event as Record<string, unknown> | undefined;
    const streamEventType = typeof streamEvent?.type === 'string' ? streamEvent.type : '';
    if (type !== 'result' && !(type === 'stream_event' && streamEventType === 'message_stop')) {
      return;
    }
    this.followUpsOutputBoundaryPending = false;
    log.info('chat', 'claude follow-ups visible output boundary completed', {
      nodeId: this.nodeId,
      sessionId: this.id,
      reason: type === 'result' ? 'turn-result' : 'message-stop',
    });
    this.queue.push({ kind: 'follow_ups_status', status: 'completed' });
  }

  private finishFollowUpsHookPocTurn(): void {
    if (this.followUpsHookPocEnabled && (
      this.followUpsSuppressedChunkEvents > 0 ||
      this.followUpsSuppressedThoughtEvents > 0
    )) {
      log.info('chat', 'claude follow-ups hook poc repair output suppressed', {
        nodeId: this.nodeId,
        sessionId: this.id,
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

  private logFollowUpsHookEnvelope(envelope: Record<string, unknown>): void {
    if (!this.followUpsHookPocEnabled) return;
    const type = typeof envelope.type === 'string' ? envelope.type : '';
    const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : '';
    const hookName = typeof envelope.hook_name === 'string' ? envelope.hook_name : '';
    if (type !== 'system' || !subtype.startsWith('hook_') || hookName !== 'Stop') return;
    log.info('chat', 'claude follow-ups hook poc lifecycle event', {
      nodeId: this.nodeId,
      sessionId: this.id,
      type: subtype,
      hookName,
      hookId: typeof envelope.hook_id === 'string' ? envelope.hook_id : undefined,
      outcome: typeof envelope.outcome === 'string' ? envelope.outcome : undefined,
    });
  }

  private awaitInit(translator: ReturnType<typeof createTranslator>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { this.child?.kill('SIGKILL'); } catch {}
        this.state = 'crashed';
        reject(new ClaudeInitTimeoutError(
          `claude did not emit system/init within ${SPAWN_INIT_TIMEOUT_MS}ms`,
        ));
      }, SPAWN_INIT_TIMEOUT_MS);

      // Poll translator.getSessionId() — it gets set when init envelope arrives
      const poll = setInterval(() => {
        if (translator.getSessionId() !== null) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);

      // Also resolve on early process exit (crashed before init)
      this.exitPromise.then(() => {
        if (translator.getSessionId() === null) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new ClaudeInitTimeoutError('claude exited before emitting system/init'));
        }
      });
    });
  }

  private checkAndRepairJsonl(cwd: string, claudeSessionId: string, ownerUserId?: string | null): void {
    const jsonlPath = getClaudeJsonlPath(cwd, claudeSessionId, ownerUserId);
    if (!fs.existsSync(jsonlPath)) return;

    try {
      const stat = fs.statSync(jsonlPath);
      if (stat.size === 0) return;

      const readSize = Math.min(4096, stat.size);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      } finally {
        fs.closeSync(fd);
      }

      const tail = buf.toString('utf8');
      const lines = tail.split('\n');
      const lastLine = lines[lines.length - 1];

      // If last line is non-empty (no trailing newline) or fails JSON.parse, truncate
      if (lastLine.trim()) {
        try {
          JSON.parse(lastLine);
          // Parses OK — file is fine
        } catch {
          // Truncate to the last complete newline
          const lastNewline = tail.lastIndexOf('\n');
          if (lastNewline >= 0) {
            const truncateAt = stat.size - readSize + lastNewline + 1;
            console.warn(
              `[ClaudeSession] JSONL tail repair: truncating ${jsonlPath} to ${truncateAt} bytes`,
            );
            fs.truncateSync(jsonlPath, truncateAt);
          }
        }
      }
    } catch (err) {
      console.warn(`[ClaudeSession] JSONL tail check failed for ${jsonlPath}:`, err);
    }
  }

  private writeStdin(data: string): void {
    if (!this.child || !this.child.stdin.writable) {
      this.queue.push({ kind: 'turn_end', stopReason: 'error' });
      this.state = 'crashed';
      this.queue.dispose();
      void this.disposeSlot();
      this.fireDisposedCallback();
      return;
    }
    this.child.stdin.write(data, 'utf8', (err) => {
      if (err) {
        console.warn(`[ClaudeSession] stdin write error:`, err);
        this.queue.push({ kind: 'turn_end', stopReason: 'error' });
        this.state = 'crashed';
        this.queue.dispose();
        void this.disposeSlot();
        this.fireDisposedCallback();
      }
    });
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return Promise.race([
      this.exitPromise.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private async disposeSlot(): Promise<void> {
    if (!this.slotId) return;
    const slotId = this.slotId;
    this.slotId = null;
    await this.mcpRegistry.dispose(slotId).catch(() => {});
  }

  private fireDisposedCallback(): void {
    if (this.disposedCallbackFired) return;
    this.disposedCallbackFired = true;
    this.disposedCallback?.();
  }

  // ---- Turn mutex ------------------------------------------------------------

  private async acquireTurnLock(): Promise<void> {
    if (this.turnLock) {
      // Already a turn in flight — reject with ESESSION_BUSY
      throw Object.assign(new Error('Session is busy with an in-flight turn'), { code: 'ESESSION_BUSY' });
    }
    let release!: () => void;
    this.turnLock = new Promise<void>((r) => { release = r; });
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

  // ---- Permission handling ---------------------------------------------------

  private makeOnApprove() {
    return async (params: { toolName: string; input: unknown; toolUseId: string }): Promise<
      { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }
    > => {
      const policy = resolvePolicy(this.workspaceId, params.toolName, params.input);
      if (policy === 'allow') return { behavior: 'allow', updatedInput: params.input };
      if (policy === 'deny') return { behavior: 'deny', message: 'policy denied' };

      // 'ask': push permission_request, await user decision
      const requestId = ++this.nextRequestId;
      const options: PermissionOption[] = [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow this tool', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
      ];

      this.queue.push({
        kind: 'permission_request',
        requestId,
        title: `Approve ${params.toolName}?`,
        detail: formatPermissionDetail(params.toolName, params.input),
        options,
      });

      const result = await this.awaitPermission(requestId);

      if (result === 'allow_always') {
        if (this.workspaceId) grantPermission(this.workspaceId, canonicalPermissionToolName(params.toolName));
        return { behavior: 'allow', updatedInput: params.input };
      }
      if (result !== null && result.startsWith('allow')) {
        return { behavior: 'allow', updatedInput: params.input };
      }
      return { behavior: 'deny', message: 'denied by user' };
    };
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
}

// ---- Helpers -----------------------------------------------------------------

function userEnvelope(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

function formatPermissionDetail(toolName: string, input: unknown): string | undefined {
  const args = asRecord(input);
  if (!args) return undefined;

  const canonical = canonicalPermissionToolName(toolName);
  if (canonical === 'bash') {
    const lines = compact([
      formatField('Description', firstString(args, ['description']), 180),
      formatField('Command', firstString(args, ['command', 'cmd']), 600),
    ]);
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  if (canonical === 'edit') {
    const lines = compact([
      formatField('File', firstString(args, ['file_path', 'path', 'notebook_path']), 320),
      formatEditCount(args),
    ]);
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  if (canonical === 'write') {
    const lines = compact([
      formatField('File', firstString(args, ['file_path', 'path']), 320),
      formatContentSize(args),
    ]);
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function formatField(label: string, value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return `${label}: ${truncate(value, maxLength)}`;
}

function formatEditCount(args: Record<string, unknown>): string | undefined {
  const edits = args.edits;
  if (!Array.isArray(edits)) return undefined;
  return `Edits: ${edits.length}`;
}

function formatContentSize(args: Record<string, unknown>): string | undefined {
  const content = args.content;
  if (typeof content !== 'string') return undefined;
  return `Content: ${content.length} chars`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}
