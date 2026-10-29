import { KiroSignedOutError, isKiroSignInError } from './kiroSignIn';
import type { AcpPendingRequest } from '../acp/client';
import { V3_COMMAND_METHODS, V3_COMPATIBILITY_METHODS, v3CommandNames, effortSelection } from './v3Commands';
import { KiroSessionSnapshots } from './sessionSnapshots';
import { nativeSessionExists } from "./nativeSessionLookup";
import type { RuntimeObservability } from "../../contract/host";
import { AcpAgentTurns, type AcpAgentTurnHandler } from "./acpAgentTurns";
import { kiroV2ApprovalCancelledUpdate } from "./kiroSubagents";

export type { AcpAgentTurnHandler } from "./acpAgentTurns";
import {
    rewindPoints, v3InfoUpdates,
    type KiroEngine, type AcpInitializeResult, type AcpMcpServer, type AcpSessionInfo,
    type AcpSessionOptions, type AcpConfigOption,
} from './kiroProtocol';
import {
    ACPError, ACPNativeSessionMissingError, ACPProcessExitedError, ACPRequestNotSentError,
    ACPSessionRecoveryRequiredError, ACPUnsupportedMethodError,
} from "../acp/errors";
import type { AcpIncomingMessage, AcpIncomingNotification, AcpUpdate } from "../acp/types";

export {
    ACPError, ACPNotRunningError, ACPRequestNotSentError, ACPProcessExitedError,
    ACPSessionRecoveryRequiredError, ACPNativeSessionMissingError, ACPUnsupportedMethodError,
} from "../acp/errors";
export type { ACPErrorDetails } from "../acp/errors";
export type { AcpPromptBlock, AcpUpdate } from "../acp/types";
import { AcpClient as AcpCoreClient, rpcErrorDataForLog } from "../acp/client";
import { KiroAcpProfile, type AcpLaunch } from "./kiroAcpProfile";
import { findKiroCli, type KiroCliLookup } from "./kiroCli";

export type { AcpLaunch } from "./kiroAcpProfile";
export { findKiroCli, probeKiroCli, type KiroCliLookup } from "./kiroCli";

/** Out-of-band workflow routing for one client (see setWorkflowRouter). */
export interface AcpWorkflowRouter {
    onEvent(method: string, params: Record<string, unknown>): void;
    isStepSession(sessionId: string): boolean;
    /** A workflow of this process is running or paused (it dies with the process). */
    hasOpenRuns?(): boolean;
    requestPermission(request: {
        sessionId: string;
        requestId: number;
        toolCall?: Record<string, unknown>;
        options: Array<{ optionId: string; name?: string; kind?: string }>;
    }): boolean;
}

/** How an AcpClient finds and runs kiro-cli; part of KiroAdapterOptions. */
export interface AcpProcessOptions {
    extraArgs?: string[];
    childEnv?: NodeJS.ProcessEnv;
    rejectPermissions?: boolean;
    onSignedOut?: (binary: string) => void;
    /** Where to look for kiro-cli, read each time it is looked up. Default: the fixed locations only. */
    kiroCli?: () => KiroCliLookup;
    /**
     * Idle timeout for an ACP RPC (Michi: ACP_TIMEOUT_MS) — reset every time
     * we see progress on the same sessionId (any session/update
     * notification). The RPC only dies if the agent goes totally silent for
     * this long. 0 disables it. Default 180000.
     *
     * Historically this was a HARD timeout, which killed long-running turns
     * even when kiro was still actively producing tool calls / chunks.
     */
    acpIdleTimeoutMs?: number;
    /**
     * The environment a kiro-cli child would inherit, read at each spawn
     * (Michi: its own environment); kiroEnv adds Kiro's entries to it. Absent: the
     * child inherits this process's environment unchanged. Not used with a
     * custom launch, whose child always inherits it.
     */
    spawnEnv?: () => NodeJS.ProcessEnv;
    /**
     * Whether a direct Kiro child keeps Michi's MCP tools on the model's tool belt
     * (kiroEnv; Michi: unless MICHI_KIRO_PRELOAD_TOOLS=false), read at each
     * spawn with spawnEnv. Default true.
     */
    preloadTools?: () => boolean;
}

/** What a host provides an AcpClient beyond its process launch. */
export interface AcpClientOptions extends AcpProcessOptions {
    /**
     * Logs, perf marks, startup marks, the raw stream probe and the child's
     * stderr (Michi: its logger, kiro-cli.log). Default: none of them.
     */
    observability?: RuntimeObservability;
}

/** What Kiro has published about one session's tools. */
export interface AcpToolCatalogState {
    /** Increments on every change. */
    seq: number;
    /** The latest v3 `_kiro/tools/didChange` tags. */
    tags?: unknown[];
    /** MCP servers v2 reported through `_kiro.dev/mcp/server_initialized`. */
    initializedServers: string[];
}

export class AcpClient extends AcpCoreClient {
    private signInFailed = false;
    private stderrTail = '';
    private readonly toolCatalogs = new Map<string, AcpToolCatalogState>();
    private readonly toolCatalogWaiters = new Map<string, Set<() => void>>();
    private readonly rejectPermissions: boolean;
    private readonly onSignedOut?: (binary: string) => void;

    override start(): void {
        if (this.proc) return;
        this.signInFailed = false;
        this.stderrTail = '';
        super.start();
    }

    protected override onChildStderr(text: string): void {
        this.stderrTail = (this.stderrTail + text).slice(-8_192);
        if (!this.launch && !this.initialization && isKiroSignInError(this.stderrTail)) {
            this.signInFailed = true;
            this.onSignedOut?.(this.binaryPath);
        }
    }

    protected override processExitError(code: number | null, signal: NodeJS.Signals | null): Error {
        return this.signInFailed ? new KiroSignedOutError() : super.processExitError(code, signal);
    }

    protected override mapRpcError(_request: AcpPendingRequest, error: { code?: unknown; message?: unknown; data?: unknown }): Error | undefined {
        const message = typeof error.message === 'string' && error.message ? error.message : 'unknown ACP error';
        if (!this.launch && isKiroSignInError(`${message} ${JSON.stringify(error.data ?? '')}`)) {
            this.onSignedOut?.(this.binaryPath);
            return new KiroSignedOutError();
        }
        return undefined;
    }

    protected override notSentError(): Error {
        return this.exitError instanceof KiroSignedOutError ? this.exitError : super.notSentError();
    }

    private readonly unsupportedExtensions = new Set<string>();
    private readonly lastUserMessageId = new Map<string, string>();
    private readonly snapshots: KiroSessionSnapshots;
    private readonly steeredSessions = new Set<string>();
    /** V3 policy presets each session was last opened with (`session/new`, `session/load`). */
    private readonly sessionPolicyPresets = new Map<string, readonly string[]>();
    /** What each session was last opened with, so reopenWithPolicyPresets can open it again. */
    private readonly sessionOpenings = new Map<string, { cwd: string; mcpServers: AcpMcpServer[]; options: AcpSessionOptions }>();
    /** Sessions this process closed and is loading again: they exist without a catalog entry. */
    private readonly reopeningSessions = new Set<string>();
    private readonly steerRequests = new Map<string, Set<Promise<unknown>>>();
    private readonly compactions = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
    private readonly compactingSessions = new Set<string>();
    /** Turns Kiro starts on its own (see acpAgentTurns.ts). */
    private readonly agentTurns: AcpAgentTurns;
    /** Turns of ours announced for a session whose prompt has not started (see announcePrompt). */
    private readonly promptIntents = new Map<string, symbol[]>();
    /** Our prompt's own turn ended (Kiro's turn_end) while its RPC is still open. */
    private readonly promptTurnEnded = new Set<string>();
    /**
     * Kiro started a turn after our prompt's own turn ended, before the
     * prompt's result (raw kiro-wake-send-wire: the result follows turn_end
     * by a few frames). It is taken as a wake once a frame tagged
     * `agentInitiated` shows it is one, or when the prompt's RPC settles
     * (see settlePrompt); until then untagged frames stay the prompt's.
     */
    private readonly wakeCandidates = new Set<string>();
    /** Maps active agent tool_call ids → owning session ids.
     *  Used to infer which session owns incoming _kiro.dev/subagent/list_update
     *  events (which lack a sessionId field). When only one entry exists, routing
     *  is deterministic. When multiple sessions have concurrent agent calls,
     *  the most recently registered one wins — matching kiro-cli's behavior.
     *  Entries are removed when the corresponding tool_call completes/errors. */
    private subagentOwners = new Map<string, string>(); // toolCallId → sessionId
    /** Insertion-order counter so we can pick the most recent owner on ambiguity. */
    private subagentOwnerSeq = 0;
    private subagentOwnerOrder = new Map<string, number>(); // toolCallId → seq
    /** Maps subagent sessionId → parent sessionId for tool activity forwarding. */
    private subagentParentMap = new Map<string, string>();
    /** V2 subagent stage names (roster `sessionName`), for their approval prompts. */
    private readonly subagentNames = new Map<string, string>();
    /**
     * V2 subagent approvals shown in the parent's turn, by requestId: a
     * child session has no queue of its own, and an unanswered request
     * leaves the child stopped and a blocking crew waiting for it.
     */
    private readonly forwardedPermissions = new Map<number, string>();
    /**
     * Subagent approvals waiting until the parent's shown one is answered,
     * oldest first: a chat shows one approval at a time, and a newer one
     * would hide an older one that still blocks its agent.
     */
    private readonly heldPermissions = new Map<string, AcpUpdate[]>();
    /** Workflow traffic (`_kiro/workflow/*`, step notifications, step
     *  sessions and their approvals); routed out of band, never into a turn
     *  queue. One router per client (KiroRuntime's workflow bridge). */
    private workflowRouter: AcpWorkflowRouter | null = null;

    setWorkflowRouter(router: AcpWorkflowRouter | null): void {
        this.workflowRouter = router;
    }

    private emitWorkflowEvent(method: string, params: Record<string, unknown>): void {
        try { this.workflowRouter?.onEvent(method, params); } catch (error) {
            this.observability.log('warn', "acp", "workflow router failed", { method, error: error instanceof Error ? error.message : String(error) });
        }
    }

    private isWorkflowStepSession(sessionId: string): boolean {
        try { return !this.sessionQueues.has(sessionId) && this.workflowRouter?.isStepSession(sessionId) === true; }
        catch { return false; }
    }

    /** `_kiro/workflow/{pause,resume,cancel,retry}` for one workflow, attributed to the user. */
    async workflowControl(method: 'pause' | 'resume' | 'cancel' | 'retry', workflowId: string, sessionId: string): Promise<void> {
        await this.sendExtension(`_kiro/workflow/${method}`, { workflowId, initiator: 'user' }, 15_000, sessionId);
    }

    supportsWorkflowControl(method: 'pause' | 'resume' | 'cancel' | 'retry'): boolean {
        return this.supportsExtension(`_kiro/workflow/${method}`);
    }

    /** A workflow Michi tracks for this process is running or paused. */
    hasOpenWorkflowRuns(): boolean {
        try { return this.workflowRouter?.hasOpenRuns?.() === true; } catch { return false; }
    }

    /** Resolve the session (and its delegation tool call) that should receive
     *  subagent list_update events. One active owner → deterministic.
     *  Multiple → most recently registered. None → null (event is discarded). */
    private resolveSubagentOwner(): { sessionId: string; toolCallId: string } | null {
        let bestToolCallId: string | null = null;
        let bestSeq = -1;
        for (const [toolCallId] of this.subagentOwners) {
            const seq = this.subagentOwnerOrder.get(toolCallId) ?? 0;
            if (seq > bestSeq) {
                bestSeq = seq;
                bestToolCallId = toolCallId;
            }
        }
        const sessionId = bestToolCallId ? this.subagentOwners.get(bestToolCallId) : undefined;
        return bestToolCallId && sessionId ? { sessionId, toolCallId: bestToolCallId } : null;
    }

    /** The most recently registered delegation tool call of one session. */
    private latestOwnerToolCall(sessionId: string): string | undefined {
        let best: string | undefined;
        let bestSeq = -1;
        for (const [toolCallId, ownerSid] of this.subagentOwners) {
            if (ownerSid !== sessionId) continue;
            const seq = this.subagentOwnerOrder.get(toolCallId) ?? 0;
            if (seq > bestSeq) { bestSeq = seq; best = toolCallId; }
        }
        return best;
    }

    private forgetSubagent(subagentSessionId: string): void {
        this.subagentParentMap.delete(subagentSessionId);
        this.subagentNames.delete(subagentSessionId);
    }

    constructor(
        binaryPath?: string,
        cwd: string = process.cwd(),
        model?: string,
        public readonly engine: KiroEngine = 'v2',
        /** Replaces the kiro-cli binary and argv. Absent → kiro-cli + kiroArgs. */
        private readonly launch?: AcpLaunch,
        /** Id of the owning runtime instance; reported in session state ("crew" for Kiro Crew). */
        runtimeId: string = 'kiro',
        options: AcpClientOptions = {},
    ) {
        super(new KiroAcpProfile({
            binaryPath: launch?.bin ?? binaryPath ?? findKiroCli(options.kiroCli?.()),
            cwd, model, engine, launch, runtimeId, preloadTools: options.preloadTools, extraArgs: options.extraArgs, childEnv: options.childEnv,
        }), options);
        this.rejectPermissions = options.rejectPermissions === true;
        this.onSignedOut = options.onSignedOut;
        this.snapshots = new KiroSessionSnapshots(runtimeId);
        this.agentTurns = new AcpAgentTurns({
            reserve: (sessionId) => this.reserveSession(sessionId),
            sendCancel: (sessionId) => { void this.notify('session/cancel', { sessionId }).catch(() => {}); },
            cancelPermissionsForSession: (sessionId) => this.cancelPermissionsForSession(sessionId),
            quarantine: (sessionId) => {
                this.quarantinedSessions.add(sessionId);
                this.observability.log('warn', 'acp', 'agent-initiated turn did not end after cancel; native session quarantined', { sessionId, pid: this.proc?.pid });
            },
            promptPending: (sessionId) => this.promptIntents.has(sessionId),
            exitedError: () => new ACPProcessExitedError('ACP process exited during an agent-initiated turn'),
            cancelTimeoutMs: this.cancelTimeoutMs,
            detachedTimeoutMs: Math.max(this.cancelTimeoutMs * 6, 1_000),
        });
    }

    override get capabilities(): AcpInitializeResult['agentCapabilities'] {
        return this.initialization?.agentCapabilities as AcpInitializeResult['agentCapabilities'];
    }

    supportsExtension(method: string): boolean {
        if (this.engine !== 'v3') return true;
        return !this.unsupportedExtensions.has(method) && (
            this.capabilities?._meta?.kiro?.extensionMethods?.includes(method) === true
            || V3_COMPATIBILITY_METHODS.has(method));
    }

    private async sendExtension(method: string, params: Record<string, unknown>, timeoutMs: number, sessionId: string): Promise<any> {
        if (!this.supportsExtension(method)) throw new ACPUnsupportedMethodError(`This Kiro server does not support ${method}`);
        try { return await this.send(method, params, timeoutMs, sessionId, true); }
        catch (error) {
            if (this.engine === 'v3' && error instanceof ACPError && error.rpcCode === -32601) {
                this.unsupportedExtensions.add(method);
                this.publishSessionState(sessionId);
                throw new ACPUnsupportedMethodError(`This Kiro server does not support ${method}`);
            }
            throw error;
        }
    }

    getSessionState(sessionId: string) {
        const state = this.snapshots.state(sessionId, this.sessionInfo.get(sessionId));
        state.nativeEngine = this.engine;
        if (this.engine === 'v3') {
            const advertised = new Map(state.commands?.map((command) => [command.name, command]));
            state.commands = v3CommandNames(this.sessionInfo.get(sessionId), (method) => this.supportsExtension(method))
                .map((name) => advertised.get(name) ?? { name });
        }
        return state;
    }

    onSessionState(sessionId: string, notify: () => void): () => void {
        return this.snapshots.subscribe(sessionId, notify);
    }

    private publishSessionState(sessionId: string): void {
        if (this.loadingSessions.has(sessionId)) return;
        this.snapshots.changed(sessionId);
        if (this.activePrompts.has(sessionId)) this.injectUpdate(sessionId, {
            sessionUpdate: 'session_state', state: this.getSessionState(sessionId),
        });
    }

    getLastUserMessageId(sessionId: string): string | undefined {
        return this.lastUserMessageId.get(sessionId);
    }

    protected override interceptMessage(msg: AcpIncomingMessage): boolean {
        if (typeof msg?.method === 'string' && (msg.id === undefined || msg.id === null)
            && (msg.method.startsWith('_kiro/workflow/') || msg.method === '_kiro/session/notify')) {
            this.emitWorkflowEvent(msg.method, msg.params ?? {});
            return true;
        }
        return false;
    }

    /** A permission request of a turn Kiro started on its own waits on that turn. */
    protected override routePermissionRequest(sessionId: string, update: AcpUpdate): 'delivered' | 'dropped' | 'none' {
        if (this.rejectPermissions && update.sessionUpdate === 'permission_request') {
            this.observability.log('warn', 'acp', 'kiro permission request rejected', { sessionId, tool: update.toolCall?.title });
            this.respondToPermissionKind(update.requestId, 'reject_once');
            return 'delivered';
        }
        return this.agentTurns.deliver(sessionId, update);
    }

    protected override routeUnqueuedPermission(sessionId: unknown, requestId: number, toolCall: unknown, options: unknown): boolean {
        if (this.rejectPermissions) {
            this.observability.log('warn', 'acp', 'kiro permission request rejected', { sessionId });
            this.respondToPermissionKind(requestId, 'reject_once');
            return true;
        }
        return this.routeWorkflowPermission(sessionId, requestId, toolCall, options)
            || this.routeSubagentPermission(sessionId, requestId, toolCall, options);
    }

    /**
     * A V2 subagent's approval goes to the turn of the session that spawned
     * it (the roster maps the child; it arrives before the child's first
     * tool call), labelled with the child. False when no running turn of
     * that parent can answer it: it is cancelled, as before.
     */
    private routeSubagentPermission(sessionId: unknown, requestId: number, toolCall: unknown, options: unknown): boolean {
        if (typeof sessionId !== 'string') return false;
        const parentSid = this.subagentParentMap.get(sessionId);
        if (!parentSid || !this.activePrompts.has(parentSid) || !this.sessionQueues.has(parentSid)) return false;
        const raw = Array.isArray(options) ? options : [];
        const update: AcpUpdate = {
            sessionUpdate: 'permission_request',
            requestId,
            toolCall,
            options: this.profile.mapPermissionOptions ? this.profile.mapPermissionOptions(raw) : raw,
            _meta: this.pendingPermissions.get(requestId)?.meta,
            subagentSessionId: sessionId,
            ...(this.subagentNames.get(sessionId) ? { subagentName: this.subagentNames.get(sessionId) } : {}),
        };
        this.forwardedPermissions.set(requestId, parentSid);
        const held = this.heldPermissions.get(parentSid) ?? [];
        this.heldPermissions.set(parentSid, [...held, update]);
        this.releaseHeldPermissions(parentSid);
        return true;
    }

    /** An approval of the parent's (its own or a subagent's) is waiting for an answer and not held. */
    private hasShownPermission(parentSid: string): boolean {
        const held = new Set((this.heldPermissions.get(parentSid) ?? []).map((update) => update.requestId));
        for (const [requestId, entry] of this.pendingPermissions) {
            if (held.has(requestId)) continue;
            if (entry.sessionId === parentSid || this.forwardedPermissions.get(requestId) === parentSid) return true;
        }
        return false;
    }

    /** Show the parent's oldest held subagent approval once nothing else waits; without a running turn, cancel them. */
    private releaseHeldPermissions(parentSid: string): void {
        const held = this.heldPermissions.get(parentSid);
        if (!held) return;
        const queue = this.activePrompts.has(parentSid) ? this.sessionQueues.get(parentSid) : undefined;
        if (!queue) {
            this.dropHeldPermissions(parentSid);
            return;
        }
        while (held.length > 0 && !this.hasShownPermission(parentSid)) {
            const next = held.shift()!;
            if (this.pendingPermissions.has(next.requestId)) queue.push({ update: next });
            else this.forwardedPermissions.delete(next.requestId);
        }
        if (held.length === 0) this.heldPermissions.delete(parentSid);
    }

    private dropHeldPermissions(parentSid: string): void {
        const held = this.heldPermissions.get(parentSid) ?? [];
        this.heldPermissions.delete(parentSid);
        for (const update of held) this.cancelPermission(update.requestId);
    }

    /** The session whose turn shows this approval: a subagent's parent, else the requester. */
    private permissionOwner(requestId: number): string | undefined {
        return this.forwardedPermissions.get(requestId) ?? this.pendingPermissions.get(requestId)?.sessionId;
    }

    override respondToPermission(requestId: number, optionId: string): void {
        const owner = this.permissionOwner(requestId);
        super.respondToPermission(requestId, optionId);
        this.afterPermissionSettled(requestId, owner);
    }

    override cancelPermission(requestId: number): void {
        const owner = this.permissionOwner(requestId);
        const requester = this.pendingPermissions.get(requestId)?.sessionId;
        super.cancelPermission(requestId);
        if (requester && !this.pendingPermissions.has(requestId)) this.recordCancelledSubagentApproval(requester);
        this.afterPermissionSettled(requestId, owner);
    }

    /**
     * kiro-cli ends a V2 stage whose approval is cancelled, with a bare
     * `terminated`; tell its parent's running turn why it stopped. Never
     * into an idle queue, whose next prompt it would join.
     */
    private recordCancelledSubagentApproval(subagentSessionId: string): void {
        const parentSid = this.subagentParentMap.get(subagentSessionId);
        if (!parentSid || !this.activePrompts.has(parentSid)) return;
        this.sessionQueues.get(parentSid)?.push({ update: kiroV2ApprovalCancelledUpdate(subagentSessionId) });
    }

    private afterPermissionSettled(requestId: number, owner: string | undefined): void {
        if (this.pendingPermissions.has(requestId)) return;
        this.forwardedPermissions.delete(requestId);
        if (!owner) return;
        const held = this.heldPermissions.get(owner);
        if (held?.some((update) => update.requestId === requestId)) {
            this.heldPermissions.set(owner, held.filter((update) => update.requestId !== requestId));
        }
        this.releaseHeldPermissions(owner);
    }

    /** A session's own approvals, and its subagents' shown or held ones. */
    override cancelPermissionsForSession(sessionId: string): void {
        this.cancelSubagentPermissions(sessionId);
        super.cancelPermissionsForSession(sessionId);
    }

    /** The subagent approvals shown or held in this parent's turn. */
    private cancelSubagentPermissions(parentSid: string): void {
        this.dropHeldPermissions(parentSid);
        for (const [requestId, owner] of this.forwardedPermissions) {
            if (owner === parentSid) this.cancelPermission(requestId);
        }
    }

    protected override claimSessionUpdate(sid: string, update: AcpUpdate, msg: AcpIncomingNotification): boolean {
        // A workflow step's own session: Michi never opened it, so it has
        // no queue and keeps no per-session state here. Its tagged frames
        // feed the workflow run, not a chat turn.
        if (this.isWorkflowStepSession(sid) || (update._meta?.kiro?.workflow && !this.sessionQueues.has(sid))) {
            if (update._meta?.kiro?.workflow) this.emitWorkflowEvent("session/update", msg.params);
            return true;
        }
        return false;
    }

    protected override beforeQueueUpdate(sid: string, update: AcpUpdate, _msg: AcpIncomingNotification): boolean {
        if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
            this.snapshots.set(sid, { commands: update.availableCommands });
            this.publishSessionState(sid);
            return true;
        }
        const nativeUserId = update._meta?.kiro?.userMessageId;
        if (typeof nativeUserId === 'string') this.lastUserMessageId.set(sid, nativeUserId);
        // load already rehydrates Michi's transcript from SQLite. Keep
        // identity/config metadata, never append replay as live output.
        // Known behavior, pinned by golden S14: returning here skips the
        // core's idle-timer reset (see the core's loading return and
        // follow-up task B).
        if (this.loadingSessions.has(sid) || update._meta?.kiro?.replay === true) return true;
        if (this.engine === 'v3' && update.sessionUpdate === 'session_info_update') {
            const kind = update._meta?.kiro?.kind;
            if (kind === 'turn_start') {
                this.wakeCandidates.delete(sid);
                if (!this.activePrompts.has(sid)) {
                    // Kiro starting a turn while no prompt of ours runs: it
                    // woke the session itself (a workflow finished).
                    if (this.sessionQueues.has(sid)) this.agentTurns.start(sid);
                } else if (this.promptTurnEnded.has(sid)) {
                    // After our prompt's own turn ended: see wakeCandidates.
                    this.wakeCandidates.add(sid);
                } else {
                    // Our prompt's own turn started: a wake it overtook is
                    // over, even if Kiro never reported that wake's end.
                    this.agentTurns.endOvertaken(sid);
                }
            }
            if (this.agentTurns.has(sid)) {
                if (kind === 'turn_end') {
                    const stop = update._meta?.kiro?.stopReason ?? update._meta?.kiro?.turnEnd?.stopReason;
                    this.agentTurns.end(sid, typeof stop === 'string' ? stop : 'end_turn');
                    return true;
                }
                for (const normalized of v3InfoUpdates(update)) {
                    if (normalized.sessionUpdate === 'context_usage') {
                        this.lastMetadata.set(sid, { ...this.lastMetadata.get(sid), ...normalized });
                    }
                    this.agentTurns.deliver(sid, normalized);
                }
                return true;
            }
            if (kind === 'turn_end') {
                this.wakeCandidates.delete(sid);
                if (this.activePrompts.has(sid)) this.promptTurnEnded.add(sid);
            }
            for (const normalized of v3InfoUpdates(update)) {
                if (normalized.sessionUpdate === 'usage_summary') {
                    const context = this.lastMetadata.get(sid)?.contextUsagePercentage;
                    this.lastMetadata.set(sid, { ...normalized,
                        ...(context !== undefined ? { contextUsagePercentage: context } : {}),
                    });
                } else if (normalized.sessionUpdate === 'context_usage') {
                    this.lastMetadata.set(sid, { ...this.lastMetadata.get(sid), ...normalized });
                    this.injectUpdate(sid, normalized);
                } else this.injectUpdate(sid, normalized);
            }
            return true;
        }
        return false;
    }

    /** Kiro's own turns take their frames; a tagged wake frame never joins our prompt. */
    protected override routeSessionUpdate(sid: string | undefined, msg: AcpIncomingNotification): boolean {
        // While our prompt runs, Kiro's own wake chunks are tagged
        // `agentInitiated` (recorded wires): they never belong to the
        // prompt, whatever order they arrive in. (Untagged frames are not
        // taken as proof that the wake is over: until Kiro ends it or the
        // prompt's turn starts, they are discarded with the wake.)
        const promptActive = !!sid && this.activePrompts.has(sid);
        const wakeTagged = msg.params?.update?._meta?.kiro?.agentInitiated === true;
        if (sid && wakeTagged && this.wakeCandidates.delete(sid) && this.sessionQueues.has(sid)) {
            this.agentTurns.start(sid);
        }
        const toAgentTurn = sid ? this.agentTurns.deliver(sid, msg.params) : 'none';
        const q = toAgentTurn === 'none' && sid && !(promptActive && wakeTagged) ? this.sessionQueues.get(sid) : undefined;
        if (q) q.push({ update: msg.params });
        return true;
    }

    protected override afterSessionUpdate(sid: string | undefined, msg: AcpIncomingNotification): void {
        const updateKind = msg.params?.update?.sessionUpdate;
        // The parent's `Run Workflow` result names the workflow it launched.
        const launched = updateKind === "tool_call_update" ? msg.params?.update?.rawOutput?.workflowId : undefined;
        if (sid && typeof launched === "string" && launched) {
            this.emitWorkflowEvent("michi/workflow_launched", {
                sessionId: sid,
                workflowId: launched,
                toolCallId: msg.params?.update?.toolCallId,
            });
        }
        // Track subagent ownership: when a tool_call title matches
        // subagent-related patterns, record the toolCallId → sessionId mapping.
        if (updateKind === "tool_call" && sid) {
            const title = String(msg.params?.update?.title ?? "").trim().toLowerCase();
            if (
                title === "agent" ||
                title === "task" ||
                title.includes("subagent") ||
                title.includes("agent crew") ||
                title.includes("spawn")
            ) {
                const toolCallId = msg.params?.update?.toolCallId;
                if (toolCallId) {
                    this.subagentOwners.set(toolCallId, sid);
                    this.subagentOwnerOrder.set(toolCallId, ++this.subagentOwnerSeq);
                }
            }
        }
        // Release subagent ownership when the owning tool_call completes.
        if (updateKind === "tool_call_update" && sid) {
            const status = msg.params?.update?.status;
            const toolCallId = msg.params?.update?.toolCallId;
            if (
                toolCallId &&
                this.subagentOwners.get(toolCallId) === sid &&
                (status === "completed" || status === "error")
            ) {
                this.subagentOwners.delete(toolCallId);
                this.subagentOwnerOrder.delete(toolCallId);
                // Only clear parent mappings that belong to this owner.
                // Other concurrent sessions keep their own subagent→parent entries.
                for (const [subSid, parentSid] of this.subagentParentMap) {
                    if (parentSid === sid) this.forgetSubagent(subSid);
                }
            }
        }
        // Forward child narration (V2 child sessions have no queue of their
        // own) so the subagent's trail shows what it says, not only tools.
        if (sid && updateKind === "agent_message_chunk") {
            const parentSid = this.subagentParentMap.get(sid);
            const text = msg.params?.update?.content?.text;
            if (parentSid && typeof text === "string" && text) {
                this.sessionQueues.get(parentSid)?.push({ update: {
                    sessionUpdate: "subagent_message_chunk",
                    subagentSessionId: sid,
                    text,
                }});
            }
        }
        // Forward subagent tool_call events to the parent session
        // so the UI can show what each subagent is doing.
        if (sid && (updateKind === "tool_call" || updateKind === "tool_call_update")) {
            const parentSid = this.subagentParentMap.get(sid);
            if (parentSid) {
                const update = msg.params?.update ?? {};
                const parentQ = this.sessionQueues.get(parentSid);
                if (parentQ) {
                    // The child frame rides along whole: KiroSession derives
                    // the activity row, its output and the V2 summary result.
                    parentQ.push({ update: {
                        sessionUpdate: "subagent_tool_activity",
                        subagentSessionId: sid,
                        toolCallId: update.toolCallId ?? "",
                        title: update.title ?? "",
                        status: update.status ?? "",
                        kind: update.kind ?? "",
                        childUpdate: update,
                    }});
                }
            }
        }
    }

    protected override handleNotification(msg: AcpIncomingNotification): void {
        if (msg?.method === "_kiro.dev/mcp/server_initialized") {
            const { sessionId, serverName } = msg.params ?? {};
            if (typeof sessionId === 'string' && typeof serverName === 'string') {
                const known = this.toolCatalogs.get(sessionId)?.initializedServers ?? [];
                if (!known.includes(serverName)) this.recordToolCatalog(sessionId, { initializedServers: [...known, serverName] });
            }
        }
        if (this.engine === 'v3' && msg?.method === '_kiro/mcp/status') {
            const { sessionId, servers } = msg.params ?? {};
            if (typeof sessionId !== 'string' || !Array.isArray(servers)) return;
            this.snapshots.set(sessionId, { servers });
            this.publishSessionState(sessionId);
            return;
        }

        if (this.engine === 'v3' && msg?.method === '_kiro/tools/didChange') {
            const { sessionId, tools, tags } = msg.params ?? {};
            if (typeof sessionId === 'string' && Array.isArray(tools)) this.snapshots.set(sessionId, { tools });
            if (typeof sessionId === 'string' && Array.isArray(tags)) this.recordToolCatalog(sessionId, { tags });
            return;
        }

        // _kiro.dev/* methods — route updates to the appropriate session queue.

        // _kiro.dev/session/update — Kiro extension session updates (e.g. tool_call_chunk).
        // These mirror session/update but on a separate channel.
        if (msg?.method === "_kiro.dev/session/update") {
            const sid: string | undefined = msg.params?.sessionId;
            if (this.observability.streamProbe?.enabled()) this.writeRawUpdateProbe(sid, "_kiro.dev/session/update", msg.params?.update);
            if (sid) {
                // Known behavior, pinned by golden S14: unlike session/update,
                // this also extends hard (recovery) deadlines. Kept as is; see
                // follow-up task A, "_kiro.dev/session/update and
                // _kiro.dev/metadata should not extend hard deadlines".
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid) this.resetIdleTimer(p);
                }
            }
            // Forward to session queue as-is (tool_call_chunk etc.)
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) q.push({ update: msg.params });
        }

        // _kiro.dev/subagent/list_update — no sessionId in payload.
        // Route to the session that owns the subagent tool call.
        // With the per-tool-call Map, a single active owner is deterministic.
        // Multiple concurrent owners → pick the most recently registered (LIFO).
        // No owners → discard the event.
        if (msg?.method === "_kiro.dev/subagent/list_update") {
            const params = msg.params ?? {};
            const subagents = params.subagents ?? [];
            const owner = this.resolveSubagentOwner();
            const targetSid = owner?.sessionId ?? null;
            if (owner) {
                // Entries already attributed stay with their parent session.
                // New entries go to the most recent owner; when several
                // sessions are delegating at once that guess may be wrong, so
                // it is not stamped with a chip link (the roster then shows
                // under the message instead of on another chat's chip).
                const ambiguous = new Set(this.subagentOwners.values()).size > 1;
                const groups = new Map<string, { entries: any[]; guessed: boolean }>();
                for (const sa of subagents) {
                    const mapped = sa?.sessionId ? this.subagentParentMap.get(sa.sessionId) : undefined;
                    const parentSid = mapped ?? owner.sessionId;
                    if (!mapped && sa?.sessionId) this.subagentParentMap.set(sa.sessionId, parentSid);
                    const name = typeof sa?.sessionName === 'string' && sa.sessionName ? sa.sessionName
                        : typeof sa?.agentName === 'string' ? sa.agentName : '';
                    if (sa?.sessionId && name) this.subagentNames.set(sa.sessionId, name);
                    const group = groups.get(parentSid) ?? { entries: [], guessed: false };
                    group.entries.push(sa);
                    if (!mapped && ambiguous) group.guessed = true;
                    groups.set(parentSid, group);
                }
                for (const [parentSid, group] of groups) {
                    const q = this.sessionQueues.get(parentSid);
                    const toolCallId = this.latestOwnerToolCall(parentSid);
                    if (!q) continue;
                    q.push({ update: {
                        sessionUpdate: "subagent_list_update",
                        subagents: group.entries,
                        ...(toolCallId && !group.guessed ? { parentToolCallId: toolCallId } : {}),
                    }});
                }
                if (subagents.length === 0) {
                    this.sessionQueues.get(owner.sessionId)?.push({ update: { sessionUpdate: "subagent_list_update", subagents } });
                }
            }
            // When roster empties, clear ONLY the resolved owner's entries
            if (subagents.length === 0 && targetSid) {
                for (const [subSid, parentSid] of this.subagentParentMap) {
                    if (parentSid === targetSid) this.forgetSubagent(subSid);
                }
            }
        }

        // _kiro.dev/mcp/server_init_failure — MCP server failed to initialize.
        if (msg?.method === "_kiro.dev/mcp/server_init_failure") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            this.observability.log('error', "mcp", "kiro mcp server initialization failed", {
                pid: this.proc?.pid,
                cwd: this.cwd,
                model: this.model,
                sessionId: sid,
                serverName: params.serverName ?? "",
                error: rpcErrorDataForLog(params.error),
            });
            const q = sid ? this.sessionQueues.get(sid) : undefined;
            if (q) {
                q.push({ update: {
                    sessionUpdate: "mcp_server_error",
                    serverName: params.serverName ?? "",
                    error: params.error ?? "",
                }});
            }
        }

        if (msg?.method === "_kiro.dev/session/inbox_notification") {
            const params = msg.params ?? {};
            const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                this.observability.log('info', 'acp', `inbox notification for session ${sid}: ${params.messageCount ?? 0} message(s) from ${(params.senders ?? []).join(', ')}`);
            }
        }

        // _kiro.dev/compaction/status — compaction lifecycle notification.
        // Emitted by kiro-cli when `/compact` is executed (either via
        // commands/execute or as a prompt-text slash command). The agent
        // pushes { type: "started" } then { type: "completed", summary }.
        if (msg?.method === "_kiro.dev/compaction/status") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            const statusType = params.status?.type; // "started" | "completed"
            if (sid) {
                if (statusType === 'completed') this.compactions.get(sid)?.resolve();
                if (statusType === 'failed' || statusType === 'error') {
                    this.compactions.get(sid)?.reject(new ACPError(params.status?.message ?? 'Kiro compaction failed'));
                }
                const q = this.sessionQueues.get(sid);
                if (q) {
                    if (statusType === "started") {
                        q.push({ update: { sessionUpdate: "compaction_start" } });
                    } else if (statusType === "completed") {
                        q.push({ update: {
                            sessionUpdate: "compaction_end",
                            summary: typeof params.summary === "string" ? params.summary : undefined,
                        }});
                    }
                }
            }
        }

        // _kiro.dev/clear/status — session history cleared notification.
        // Emitted after `/clear` completes via commands/execute.
        if (msg?.method === "_kiro.dev/clear/status") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                const q = this.sessionQueues.get(sid);
                if (q) {
                    q.push({ update: { sessionUpdate: "clear_status" } });
                }
            }
        }

        // _kiro.dev/mcp/server_initialized — skipped, noisy
        // _kiro.dev/commands/available — skipped, future command palette feature

        if (msg?.method === "_kiro.dev/metadata") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                // Known behavior, pinned by golden S14: this also extends hard
                // (recovery) deadlines. Kept as is; see follow-up task A, as
                // for _kiro.dev/session/update above.
                for (const p of this.pending.values()) {
                    if (p.sessionId === sid) this.resetIdleTimer(p);
                }
            }
            if (sid && params.meteringUsage) {
                // Turn-end metadata with usage summary — buffer only.
                // prompt() will yield it before turn_end. Do NOT also push
                // to the queue, or it will be emitted twice.
                this.lastMetadata.set(sid, params);
            } else if (sid) {
                // Mid-turn or between-turn metadata — context usage only.
                // Also buffer (prompt() drain would clear queued items).
                // If a prompt is in-flight, also push to queue for immediate delivery.
                this.lastMetadata.set(sid, params);
                if (this.sessionInFlight.has(sid)) {
                    const q = this.sessionQueues.get(sid);
                    if (q) {
                        q.push({ update: {
                            sessionUpdate: "context_usage",
                            contextUsagePercentage: params.contextUsagePercentage,
                        }});
                    }
                }
            }
        }
    }

    protected override onFailAllPending(err: Error): void {
        for (const compaction of this.compactions.values()) compaction.reject(err);
    }

    /** The core's, with Kiro's session options (workflowsEnabled, policyPresets) and MCP entries. */
    override async newSession(mcpServers: AcpMcpServer[] = [], options: AcpSessionOptions = {}): Promise<AcpSessionInfo & { sessionId: string }> {
        const result = await super.newSession(mcpServers, options);
        this.rememberOpening(result.sessionId, this.cwd, mcpServers, options);
        return result;
    }

    /** The core's, with Kiro's session options and MCP entries. */
    override async loadSession(
        sessionId: string,
        cwd: string,
        mcpServers: AcpMcpServer[] = [],
        timeoutMs?: number,
        options: AcpSessionOptions = {},
    ): Promise<AcpSessionInfo> {
        const result = await super.loadSession(sessionId, cwd, mcpServers, timeoutMs, options);
        this.rememberOpening(sessionId, cwd, mcpServers, options);
        return result;
    }

    private rememberOpening(sessionId: string, cwd: string, mcpServers: AcpMcpServer[], options: AcpSessionOptions): void {
        this.sessionOpenings.set(sessionId, { cwd, mcpServers, options });
        // v2 has no policy presets: it ignores the field.
        this.sessionPolicyPresets.set(sessionId, this.engine === 'v3' ? [...new Set(options.policyPresets ?? [])].sort() : []);
    }

    /** The policy presets a session was opened with here; undefined for one this process has not opened. */
    policyPresets(sessionId: string): readonly string[] | undefined {
        return this.sessionPolicyPresets.get(sessionId);
    }

    /**
     * Open an idle V3 session again with `presets`. Kiro seeds presets only at
     * session/new and session/load, and loading a session it holds keeps its
     * policy, so this closes the session first. The session keeps its MCP
     * servers and other options; config options (model, effort, mode) that
     * the load reset are set back. A failed load leaves the session closed:
     * it is quarantined, so the next turn recovers it.
     */
    async reopenWithPolicyPresets(sessionId: string, presets: readonly string[], timeoutMs?: number): Promise<void> {
        if (this.engine !== 'v3') throw new ACPError('Policy presets require Kiro v3');
        const opening = this.sessionOpenings.get(sessionId);
        if (!opening) throw new ACPError('This Kiro process has not opened the session');
        if (!this.capabilities?.sessionCapabilities?.close) throw new ACPError('Kiro did not advertise session/close');
        const busy = () => this.activePrompts.has(sessionId) || this.agentTurns.has(sessionId) || this.compactingSessions.has(sessionId);
        // Closing would end a turn Kiro runs on its own (a workflow wake).
        if (busy()) throw new ACPError('Cannot reopen an active Kiro session');
        // As a prompt does: wait for the session's previous turn to let go.
        const previous = this.sessionInFlight.get(sessionId);
        const release = this.reserveSession(sessionId);
        this.reopeningSessions.add(sessionId);
        try {
            if (previous) await previous;
            if (busy()) throw new ACPError('Cannot reopen an active Kiro session');
            const before = this.sessionInfo.get(sessionId)?.configOptions ?? [];
            const options: AcpSessionOptions = { ...opening.options, policyPresets: [...presets] };
            try {
                await this.send('session/close', { sessionId }, timeoutMs ?? this.idleTimeoutMs, sessionId);
                this.sessionPolicyPresets.delete(sessionId);
                await super.loadSession(sessionId, opening.cwd, opening.mcpServers, timeoutMs, options);
            } catch (error) {
                // Unsent, the session is as it was; otherwise it may be closed.
                if (!(error instanceof ACPRequestNotSentError) || !this.sessionPolicyPresets.has(sessionId)) this.quarantine(sessionId);
                throw error;
            }
            this.rememberOpening(sessionId, opening.cwd, opening.mcpServers, options);
            const after = this.sessionInfo.get(sessionId)?.configOptions ?? [];
            for (const option of before) {
                const now = after.find((candidate) => candidate.id === option.id);
                if (now && option.currentValue !== undefined && now.currentValue !== option.currentValue) {
                    await this.setConfigOption(sessionId, option.id, option.currentValue, timeoutMs);
                }
            }
        } finally {
            this.reopeningSessions.delete(sessionId);
            release();
        }
    }

    override async setModel(sessionId: string, modelId: string, timeoutMs?: number): Promise<void> {
        if (this.engine === 'v3') {
            const option = this.sessionInfo.get(sessionId)?.configOptions?.find((c) => c.id === 'model' || c.category === 'model');
            if (!option) throw new ACPError('This Kiro session does not expose a model config option');
            await this.setConfigOption(sessionId, option.id, modelId, timeoutMs);
        } else {
            await super.setModel(sessionId, modelId, timeoutMs);
        }
    }

    async setConfigOption(sessionId: string, configId: string, value: string | boolean, timeoutMs?: number): Promise<AcpConfigOption[]> {
        if (this.engine !== 'v3') throw new ACPError('Generic config options require Kiro v3');
        const result = await this.send('session/set_config_option', { sessionId, configId, value }, timeoutMs, sessionId, timeoutMs !== undefined);
        if (!Array.isArray(result?.configOptions)) throw new ACPError('Kiro returned no config options after configuration');
        this.rememberSessionInfo(sessionId, result);
        const applied = result.configOptions.find((c: AcpConfigOption) => c.id === configId);
        if (applied && applied.currentValue !== value) throw new ACPError(`Kiro did not apply config option ${configId}`);
        return result.configOptions;
    }

    async steer(sessionId: string, message: string): Promise<{ queued: boolean; messageId?: string }> {
        if (!message.trim() || !this.activePrompts.has(sessionId)) return { queued: false };
        if (this.cancelledPrompts.has(sessionId)) return { queued: false };
        if (!this.supportsExtension('_session/steer')) return { queued: false };
        const requests = this.steerRequests.get(sessionId) ?? new Set<Promise<unknown>>();
        this.steerRequests.set(sessionId, requests);
        const request = this.sendExtension('_session/steer', { sessionId, message }, 10_000, sessionId);
        requests.add(request);
        try {
            const result = await request;
            if (result?.queued === true) this.steeredSessions.add(sessionId);
            return { queued: result?.queued === true && !this.cancelledPrompts.has(sessionId),
                ...(typeof result?.messageId === 'string' ? { messageId: result.messageId } : {}),
            };
        } catch (error) {
            if (error instanceof ACPUnsupportedMethodError) return { queued: false };
            throw error;
        } finally {
            requests.delete(request);
            if (requests.size === 0) this.steerRequests.delete(sessionId);
        }
    }

    async clearSteer(sessionId: string): Promise<{ cleared: boolean; messageIds?: string[] }> {
        const result = await this.sendExtension('_session/steer/clear', { sessionId }, 10_000, sessionId);
        if (result?.cleared === true) this.steeredSessions.delete(sessionId);
        return { cleared: result?.cleared === true,
            ...(Array.isArray(result?.messageIds) ? { messageIds: result.messageIds.filter((id: unknown) => typeof id === 'string') } : {}),
        };
    }

    async forkSession(sessionId: string, point?: { logIndex?: number; messageId?: string }): Promise<string> {
        if (this.sessionInFlight.has(sessionId)) throw new ACPError('Cannot fork an active Kiro session');
        let release!: () => void;
        const lock = new Promise<void>((resolve) => { release = resolve; });
        this.sessionInFlight.set(sessionId, lock);
        try {
            let childId: unknown;
            if (this.engine === 'v2' && this.launch?.standardFork) {
                if (!this.capabilities?.sessionCapabilities?.fork) throw new ACPError('Crew did not advertise session/fork');
                const result = await this.send('session/fork', { sessionId, cwd: this.cwd,
                    ...(point?.messageId ? { _meta: { kiro: { messageId: point.messageId } } } : {}),
                }, this.idleTimeoutMs, sessionId);
                childId = result?.sessionId;
            } else if (this.engine === 'v2') {
                const catalog = await this.executeCommand(sessionId, 'rewind', {});
                if (!catalog.success) throw new ACPError(catalog.message ?? 'Kiro rewind failed');
                const points = rewindPoints(catalog);
                const index = point?.logIndex ?? points[0]?.logIndex;
                if (index === undefined || !points.some((row) => row.logIndex === index)) throw new ACPError('No matching Kiro rewind point');
                const result = await this.executeCommand(sessionId, 'rewind', { value: String(index) });
                if (!result.success) throw new ACPError(result.message ?? 'Kiro rewind failed');
                childId = (result.data as any)?.sessionId;
            } else {
                if (!this.capabilities?.sessionCapabilities?.fork) throw new ACPError('Kiro did not advertise session/fork');
                const result = await this.send('session/fork', { sessionId, cwd: this.cwd,
                    ...(point?.messageId ? { _meta: { kiro: { messageId: point.messageId, createdReason: 'rewind' } } } : {}),
                }, this.idleTimeoutMs, sessionId);
                childId = result?.sessionId;
            }
            if (typeof childId !== 'string' || !childId || childId === sessionId) throw new ACPError('Kiro fork did not return an independent session');
            // The runtime loads this child with its own MCP slot before use.
            return childId;
        } finally {
            release();
            if (this.sessionInFlight.get(sessionId) === lock) this.sessionInFlight.delete(sessionId);
        }
    }

    /** Reserve the idle session until native compaction actually completes.
     * v2's command response is only an acknowledgement; completion is a later
     * notification. v3's dedicated request resolves after compaction. */
    async compact(sessionId: string, instructions?: string, timeoutMs = this.idleTimeoutMs): Promise<{ success: boolean; message?: string }> {
        this.assertSessionUsable(sessionId);
        const prompting = this.activePrompts.has(sessionId)
            && [...this.pending.values()].some((request) => request.sessionId === sessionId && request.method === 'session/prompt');
        if (prompting || this.compactingSessions.has(sessionId)) return { success: false, message: 'Cannot compact an active Kiro session' };
        // A turn Kiro started on its own ends only when Kiro says so (one
        // stopped but not ended holds the session until the quarantine
        // deadline): waiting behind it could wait long or forever.
        if (this.agentTurns.has(sessionId)) {
            return { success: false, message: 'Kiro is running a turn of its own on this session. Try again when it ends.' };
        }
        const previous = this.sessionInFlight.get(sessionId);
        let release!: () => void;
        const finished = new Promise<void>((resolve) => { release = resolve; });
        const lock = previous ? previous.then(() => finished) : finished;
        this.sessionInFlight.set(sessionId, lock);
        this.compactingSessions.add(sessionId);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // The prompt response can precede consumer/steering cleanup. Keep
            // that boundary intact even when the UI already received done.
            await previous;
            this.assertSessionUsable(sessionId);
            const completed = this.engine === 'v2' ? new Promise<void>((resolve, reject) => {
                this.compactions.set(sessionId, { resolve, reject });
                timer = setTimeout(() => reject(new ACPSessionRecoveryRequiredError('Kiro compaction completion timed out', { sessionId })), timeoutMs);
            }) : undefined;
            // A process exit may reject completion before the command responds.
            void completed?.catch(() => {});
            const result = await this.executeCommand(sessionId, 'compact', instructions?.trim() ? { instructions: instructions.trim() } : undefined, timeoutMs);
            if (!result.success) return result;
            await completed;
            return { success: true, message: 'Compaction completed' };
        } catch (error) {
            // Do not reuse a session whose compaction may still be in flight.
            this.quarantine(sessionId);
            throw error;
        } finally {
            clearTimeout(timer);
            this.compactions.delete(sessionId);
            this.compactingSessions.delete(sessionId);
            release();
            if (this.sessionInFlight.get(sessionId) === lock) this.sessionInFlight.delete(sessionId);
        }
    }

    /**
     * Take turns Kiro V3 starts on its own (a finished workflow waking the
     * parent session). Without a handler, or when it declines a session,
     * such a turn is cancelled and its frames discarded, never buffered into
     * the next prompt.
     */
    setAgentTurnHandler(handler: AcpAgentTurnHandler | null): void {
        this.agentTurns.setHandler(handler);
    }

    /** Kiro is running a turn of its own on this session. */
    hasAgentTurn(sessionId: string): boolean {
        return this.agentTurns.has(sessionId);
    }

    /** Stop a turn Kiro started on its own (see acpAgentTurns.ts). */
    async cancelAgentTurn(sessionId: string): Promise<boolean> {
        return this.agentTurns.cancel(sessionId);
    }

    /** The consumer of an agent-initiated turn stopped reading before its end. */
    releaseAgentTurn(sessionId: string): void {
        this.agentTurns.release(sessionId);
    }

    /**
     * A turn of ours will prompt this session soon (the chat accepted a
     * message and is saving it). From now until that prompt starts, a turn
     * Kiro starts on its own is overtaken rather than shown: shown, it would
     * queue behind our turn while our prompt waited for it. Returns the
     * release, for a turn that ends without prompting.
     */
    announcePrompt(sessionId: string): () => void {
        // The chat runs its turns one at a time, so the next prompt to start
        // on this session belongs to the oldest announcement.
        const token = Symbol('prompt');
        const intents = this.promptIntents.get(sessionId) ?? [];
        intents.push(token);
        this.promptIntents.set(sessionId, intents);
        this.agentTurns.overtake(sessionId);
        return () => {
            const current = this.promptIntents.get(sessionId);
            const index = current?.indexOf(token) ?? -1;
            if (!current || index < 0) return; // Its prompt started.
            current.splice(index, 1);
            if (current.length > 0) return;
            this.promptIntents.delete(sessionId);
            // No prompt is coming to supersede a wake that gave way.
            if (!this.activePrompts.has(sessionId)) this.agentTurns.abandonOvertaken(sessionId);
        };
    }

    /** A workflow step session's approval goes to its run; false to decline. */
    private routeWorkflowPermission(sessionId: unknown, requestId: number, toolCall: unknown, options: unknown): boolean {
        if (typeof sessionId !== 'string' || !this.isWorkflowStepSession(sessionId) || !Array.isArray(options)) return false;
        try {
            return this.workflowRouter?.requestPermission({
                sessionId,
                requestId,
                toolCall: toolCall && typeof toolCall === 'object' ? toolCall as Record<string, unknown> : undefined,
                options: options.filter((option): option is { optionId: string; name?: string; kind?: string } =>
                    !!option && typeof option.optionId === 'string'),
            }) === true;
        } catch { return false; }
    }

    /**
     * Execute a Kiro slash command via the ACP `_kiro.dev/commands/execute`
     * request instead of sending it as prompt text. Returns the structured
     * response `{ success, message?, data? }`.
     *
     * Only verified-safe commands should use this path; commands that hang
     * (e.g. `/help`, `/model`) must fall back to prompt text.
     *
     * Side-effects like `_kiro.dev/compaction/status` are delivered as
     * separate notifications and routed to the session queue by handleNotification().
     */
    async executeCommand(
        sessionId: string,
        command: string,
        args?: Record<string, unknown>,
        timeoutMs = this.idleTimeoutMs,
    ): Promise<{ success: boolean; message?: string; data?: unknown }> {
        if (this.engine === 'v3') {
            if (command === 'mcp') return { success: true, data: (this.snapshots.get(sessionId)?.servers ?? []).map((server) => ({
                name: server.name, status: server.status, error: server.errorMessage ?? server.error,
            })) };
            if (command === 'tools') return { success: true, data: this.snapshots.get(sessionId)?.tools ?? [],
                message: this.snapshots.get(sessionId)?.tools ? undefined : 'Kiro has not published its tool catalog yet.' };
            if (command === 'effort') {
                const selection = effortSelection(this.getSessionInfo(sessionId), args?.value);
                if ('message' in selection) return { success: args?.value === undefined, message: selection.message };
                await this.setConfigOption(sessionId, 'effortLevel', selection.value, timeoutMs);
                return { success: true, message: `Effort set to ${selection.value}.` };
            }
            const method = V3_COMMAND_METHODS[command];
            if (!method) return { success: false, message: `/${command} is not supported by Michi's Kiro V3 command interface.` };
            try {
                const result = await this.sendExtension(method, { ...args, sessionId }, timeoutMs, sessionId);
                return { success: result?.success !== false, message: result?.message, data: result };
            } catch (error) {
                if (error instanceof ACPUnsupportedMethodError) return { success: false, message: error.message };
                throw error;
            }
        }
        const payload: Record<string, unknown> = {
            sessionId,
            command: { command, args: args ?? {} },
        };
        return this.send(
            "_kiro.dev/commands/execute",
            payload,
            timeoutMs,
            sessionId,
            true,
        );
    }

    protected override onPromptRequested(sessionId: string, signal: AbortSignal | undefined): void {
        // A turn Kiro started on its own that has shown nothing yet gives
        // way to this prompt instead of holding it (see acpAgentTurns.ts).
        if (!signal?.aborted) this.agentTurns.overtake(sessionId);
    }

    /** Michi's view of the session (mode, model, commands...), when there is any, opens the turn. */
    protected override promptPrelude(sessionId: string): AcpUpdate[] {
        const state = this.getSessionState(sessionId);
        return Object.keys(state).some((key) => !['runtimeId', 'nativeEngine', 'version'].includes(key)) ? [{ sessionUpdate: 'session_state', state }] : [];
    }

    /** Returns the wake this prompt overtook, for onPromptEnding. */
    protected override onPromptStart(sessionId: string): object | undefined {
        // This prompt is the one the oldest announced turn promised.
        const intents = this.promptIntents.get(sessionId);
        intents?.shift();
        if (intents?.length === 0) this.promptIntents.delete(sessionId);
        // A wake that started while this prompt waited, and has shown
        // nothing, is overtaken now too (Kiro ends it on our prompt).
        this.agentTurns.overtake(sessionId);
        const supersededTurn = this.agentTurns.overtakenTurn(sessionId);
        this.promptTurnEnded.delete(sessionId);
        this.wakeCandidates.delete(sessionId);
        return supersededTurn;
    }

    /**
     * The prompt's RPC settled. A turn Kiro started after the prompt's own
     * turn ended (see wakeCandidates) is a wake now, tagged or not: no prompt
     * of ours is left for its frames to belong to.
     */
    protected override onPromptSettled(sessionId: string): void {
        this.promptTurnEnded.delete(sessionId);
        // No turn is left to show a subagent's approval: answer it, so the
        // stage does not wait forever (it is cancelled, as before).
        this.cancelSubagentPermissions(sessionId);
        if (this.wakeCandidates.delete(sessionId) && this.sessionQueues.has(sessionId)
            && !this.exitError && !this.stopped && !this.needsSessionRecovery(sessionId)) {
            this.agentTurns.start(sessionId);
        }
    }

    protected override onPromptEnding(sessionId: string, supersededTurn: object | undefined, promptRejected: boolean): void {
        // The wake this prompt overtook cannot outlive it (only that
        // wake: one a later turn overtook is that turn's to end). If
        // Kiro refused the prompt, it may not have ended the wake: as
        // for a turn that never prompted, a wake that lost nothing is
        // restored and one that did is stopped (its frames are
        // discarded until Kiro ends it). A turn already announced
        // will supersede it instead.
        if (supersededTurn && !promptRejected) this.agentTurns.endOvertaken(sessionId, supersededTurn);
        else if (supersededTurn && !this.promptIntents.has(sessionId)) this.agentTurns.abandonOvertaken(sessionId, supersededTurn);
    }

    protected override async onPromptEnded(sessionId: string): Promise<void> {
        this.promptTurnEnded.delete(sessionId);
        await Promise.allSettled(this.steerRequests.get(sessionId) ?? []);
        if (this.steeredSessions.has(sessionId) && !this.needsSessionRecovery(sessionId)) {
            try {
                if (!(await this.clearSteer(sessionId)).cleared) this.quarantine(sessionId);
            } catch { this.quarantine(sessionId); }
        }
    }

    protected override onSessionInfoChanged(sessionId: string): void {
        this.publishSessionState(sessionId);
    }

    /**
     * v3 loads only a session its catalog proves exists (nativeSessionLookup),
     * except one this process just closed to reopen: a session without a
     * prompt yet is not in the catalog.
     */
    protected override beforeLoadSession(sessionId: string, cwd: string, timeoutMs: number | undefined): Promise<void> | undefined {
        if (this.reopeningSessions.has(sessionId)) return undefined;
        return this.engine === 'v3' ? this.verifyNativeSession(sessionId, cwd, timeoutMs) : undefined;
    }

    private async verifyNativeSession(sessionId: string, cwd: string, timeoutMs: number | undefined): Promise<void> {
        if (!this.capabilities?.loadSession || !this.capabilities.sessionCapabilities?.list) {
            throw new ACPError('This Kiro server cannot verify native session history; original binding retained');
        }
        const exists = await nativeSessionExists(sessionId, cwd,
            (params, timeout) => this.send('session/list', params, timeout, undefined, true), timeoutMs);
        if (!exists) throw new ACPNativeSessionMissingError('Kiro native session is no longer available', {
            method: 'session/load', sessionId,
        });
    }

    protected override hasBackgroundWork(): boolean {
        // Background workflows run inside this process; restarting it
        // to recover one session would end them all.
        return this.hasOpenWorkflowRuns();
    }

    /** End any turn Kiro runs on its own in a quarantined session. */
    protected override onQuarantine(sessionId: string): void {
        this.agentTurns.close(sessionId, 'cancelled');
    }

    protected override routeInjectedUpdate(sessionId: string, update: AcpUpdate): boolean | undefined {
        // MCP side effects arrive over HTTP, unordered with Kiro's stdout.
        // While a wake our prompt overtook is still open, one is the wake's
        // (the prompt's own tool calls follow its turn_start, which ends that
        // wake): discard it with the wake, which then cannot be shown whole.
        // Michi's own session_state still belongs to the running prompt.
        if (update.sessionUpdate !== 'session_state' && this.agentTurns.overtakenTurn(sessionId)) {
            this.agentTurns.deliver(sessionId, update);
            return false;
        }
        if (!this.activePrompts.has(sessionId)) {
            const toAgentTurn = this.agentTurns.deliver(sessionId, update);
            if (toAgentTurn !== 'none') return toAgentTurn === 'delivered';
        }
        return undefined;
    }

    protected override spareBackgroundTurn(sessionId: string): boolean {
        // A turn of ours stopped while no prompt of ours is out (before it
        // went out, or after its result): the only native turn a cancel would
        // reach is a wake, which is not this turn's to stop. One this turn
        // overtook is restored or stopped when the turn ends (see
        // announcePrompt); one that started after the turn was announced and
        // has shown nothing gives way now, as it would on its first visible
        // frame; any other is shown, with its own Stop.
        // Its approvals are the wake's too (only a shown wake can hold one).
        if (this.promptIntents.has(sessionId)) this.agentTurns.overtake(sessionId);
        return this.agentTurns.has(sessionId);
    }

    override destroySession(sessionId: string): void {
        this.compactions.get(sessionId)?.reject(new ACPError('Kiro session released during compaction'));
        super.destroySession(sessionId);
    }

    /** What Kiro has published about a session's tools so far. */
    toolCatalog(sessionId: string): AcpToolCatalogState | undefined {
        return this.toolCatalogs.get(sessionId);
    }

    /** Called after every change to the session's tool catalog, until unsubscribed or the session is destroyed. */
    onToolCatalogChange(sessionId: string, listener: () => void): () => void {
        const listeners = this.toolCatalogWaiters.get(sessionId) ?? new Set<() => void>();
        this.toolCatalogWaiters.set(sessionId, listeners);
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (!listeners.size && this.toolCatalogWaiters.get(sessionId) === listeners) this.toolCatalogWaiters.delete(sessionId);
        };
    }

    /**
     * Wait until `ready` holds for the session's tool catalog, re-checked on
     * every change. Resolves with the state at that point, or with the latest
     * state (possibly undefined) once `timeoutMs` passes.
     */
    waitForToolCatalog(
        sessionId: string,
        ready: (state: AcpToolCatalogState | undefined) => boolean,
        timeoutMs: number,
    ): Promise<AcpToolCatalogState | undefined> {
        if (ready(this.toolCatalogs.get(sessionId))) return Promise.resolve(this.toolCatalogs.get(sessionId));
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                off();
                resolve(this.toolCatalogs.get(sessionId));
            };
            const timer = setTimeout(finish, timeoutMs);
            const off = this.onToolCatalogChange(sessionId, () => { if (ready(this.toolCatalogs.get(sessionId))) finish(); });
        });
    }

    private recordToolCatalog(sessionId: string, change: Partial<Omit<AcpToolCatalogState, 'seq'>>): void {
        const previous = this.toolCatalogs.get(sessionId);
        this.toolCatalogs.set(sessionId, {
            initializedServers: [], ...previous, ...change, seq: (previous?.seq ?? 0) + 1,
        });
        for (const check of [...(this.toolCatalogWaiters.get(sessionId) ?? [])]) check();
    }

    protected override onDestroySession(sessionId: string): void {
        this.toolCatalogs.delete(sessionId);
        this.toolCatalogWaiters.delete(sessionId);
        this.agentTurns.close(sessionId, 'cancelled');
        this.promptTurnEnded.delete(sessionId);
        this.wakeCandidates.delete(sessionId);
        this.lastUserMessageId.delete(sessionId);
        this.snapshots.delete(sessionId);
        this.steeredSessions.delete(sessionId);
        this.sessionPolicyPresets.delete(sessionId);
        this.sessionOpenings.delete(sessionId);
    }

    protected override onProcessExit(): void {
        this.forwardedPermissions.clear();
        this.heldPermissions.clear();
        this.agentTurns.exited();
    }
}
