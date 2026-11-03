import { ApprovalCoordinator, chatApprovalOptions } from '../../core/approvals';
import { acpPermissionToolName, kiroBrokerToolName, KiroToolCallNames, type KiroToolNameResolver } from './kiroToolNames';
import { isHeadlessOwner, isInteractiveOwner } from './kiroOwner';
import { interactiveOwner } from '../../contract/types';
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
    extractToolUsePurpose,
    KiroSteeringParser,
    parseSubagentActivityPayload,
    parseSubagentRoster,
    type SteeringSegment,
    type SubagentActivityPayload,
} from "michi-shared";
import {
    createSubtaskNarration,
    isKiroDelegation,
    kiroChildToolActivity,
    kiroSubtaskId,
    kiroV2ResultPatch,
    kiroV2RosterEntry,
    kiroV2SummaryResult,
    kiroV3DelegationEntry,
    subagentPermissionTitle,
} from "./kiroSubagents";
import type {
    AgentSession,
    AgentTurnInput,
    CancelAck,
    ChatMessage,
    CompactResult,
    MaintenanceExecutionContext,
    SteerResult,
    RuntimePermissionBroker,
    RuntimeSessionOwner,
    RuntimeToolProfile,
} from "../../contract/types";
import type { NormalizedEvent, PlanEntry } from "../../contract/events";
import { ACPRequestNotSentError, type AcpClient, type AcpPromptBlock, type AcpUpdate } from "./acpClient";
import type { AcpAgentRuntime } from "./AcpAgentRuntime";
import { KIRO_FLAVOR, type AcpAgentFlavor } from "./acpAgentFlavor";
import { injectedHostEvent } from "./kiroHostEvents";
import { KIRO_APPROVE_FOR_ME_PRESET, KIRO_METADATA_DONE_SENTINEL } from "./kiroProtocol";
import { imageMimeType, prepareAttachments, type ResolvedAttachment } from "../../core/attachments";
import { classifyAcpError, isRetryable, KiroCancelRecoveryBusyError, needsRespawn, retryReason, toErrorKind } from "./acpErrors";
import { HEARTBEAT_INTERVAL_MS } from "../../core/constants";

/** How often a cancel recovery blocked by a busy peer checks again. */
const CANCEL_RECOVERY_POLL_MS = 500;

/** Read local image attachments into ACP image prompt blocks. kiro-cli
 *  advertises promptCapabilities.image: true. Paths have already been
 *  stat-checked by partitionAttachments; a file that vanished since then is
 *  skipped rather than failing the turn. */
function buildKiroImageBlocks(images: ResolvedAttachment[]): AcpPromptBlock[] {
    const blocks: AcpPromptBlock[] = [];
    for (const attachment of images) {
        const mimeType = imageMimeType(attachment.absPath);
        if (!mimeType) continue;
        try {
            const data = fs.readFileSync(attachment.absPath).toString("base64");
            blocks.push({ type: "image", mimeType, data });
        } catch {
            // Unreadable attachment — skip.
        }
    }
    return blocks;
}

/** Local image attachments as ACP resource_link blocks to their files
 *  (AcpAgentFlavor.promptImages 'resourceLink'); the agent reads them itself. */
function buildImageLinkBlocks(images: ResolvedAttachment[]): AcpPromptBlock[] {
    return images.flatMap((attachment) => {
        const mimeType = imageMimeType(attachment.absPath);
        if (!mimeType) return [];
        // AcpPromptBlock names only image and resource; resource_link is a standard ACP block too.
        const block = {
            type: "resource_link",
            uri: pathToFileURL(attachment.absPath).href,
            name: attachment.name || path.basename(attachment.absPath),
            mimeType,
        } as unknown as AcpPromptBlock;
        return [block];
    });
}

/** The prompt note naming linked images, so the model knows to open them. */
function describeLinkedImages(images: ResolvedAttachment[]): string {
    const lines = images.filter((attachment) => imageMimeType(attachment.absPath))
        .map((attachment) => `- ${attachment.name || path.basename(attachment.absPath)} → ${attachment.absPath}`);
    if (lines.length === 0) return "";
    return ["", "[Attached images]", "The user attached these images. Read them with your file tool:", ...lines].join("\n");
}

const ACP_TOKEN_FIELDS = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const;

/** Standard ACP token counts of a usage_summary (source 'acp'); absent ones stay absent. */
function acpTokenUsage(update: AcpUpdate): Partial<Record<typeof ACP_TOKEN_FIELDS[number], number>> {
    const usage: Partial<Record<typeof ACP_TOKEN_FIELDS[number], number>> = {};
    for (const field of ACP_TOKEN_FIELDS) {
        const value = update[field];
        if (typeof value === "number" && Number.isFinite(value)) usage[field] = value;
    }
    return usage;
}

/**
 * A standard ACP agent's tool output. rawOutput `{}` says nothing (agy sends
 * it beside the diff of a completed edit), so the content blocks show; a
 * string `output` is the text itself, not JSON to quote.
 */
function standardToolOutput(rawOutput: unknown, contentOutput: string | undefined): string | undefined {
    if (typeof rawOutput === "string" && rawOutput) return rawOutput;
    if (rawOutput && typeof rawOutput === "object") {
        const output = (rawOutput as { output?: unknown }).output;
        if (typeof output === "string" && output) return output;
        if (Object.keys(rawOutput).length > 0) return JSON.stringify(rawOutput);
    } else if (rawOutput != null && typeof rawOutput !== "string") {
        return JSON.stringify(rawOutput);
    }
    return contentOutput || undefined;
}

export { KIRO_METADATA_DONE_SENTINEL };

const WHITESPACE = /\s/;

/**
 * Removes the sentinel only when it ends the assistant text. A trailing
 * region (one or more sentinels plus whitespace) is held until later text
 * shows it was ordinary prose, in which case it is released verbatim, or
 * until the turn ends, in which case it is dropped. A sentinel quoted in the
 * middle of an answer therefore stays visible.
 */
class TrailingSentinelStripper {
    private held = "";

    constructor(private readonly sentinel: string) {}

    push(chunk: string): string {
        let remaining = this.held + chunk;
        this.held = "";
        let text = "";

        while (remaining.length > 0) {
            const markerIndex = remaining.indexOf(this.sentinel);
            if (markerIndex < 0) {
                const heldLength = this.partialPrefixLength(remaining);
                text += remaining.slice(0, remaining.length - heldLength);
                this.held = remaining.slice(remaining.length - heldLength);
                break;
            }

            text += remaining.slice(0, markerIndex);
            remaining = remaining.slice(markerIndex);
            const regionEnd = this.sentinelRegionEnd(remaining);
            const rest = remaining.slice(regionEnd);
            if (rest.length === 0 || this.sentinel.startsWith(rest)) {
                // Only whitespace or a possible sentinel prefix follows, so
                // this may still be the end of the reply.
                this.held = remaining;
                break;
            }
            // Other text follows: the sentinel was prose, not the tail.
            text += remaining.slice(0, regionEnd);
            remaining = rest;
        }

        return text;
    }

    /** End of turn: drop a held trailing sentinel region, release anything else. */
    flush(): string {
        const held = this.held;
        this.held = "";
        const isTrailingRegion = held.startsWith(this.sentinel)
            && this.sentinelRegionEnd(held) === held.length;
        return isTrailingRegion ? "" : held;
    }

    /** Length of the leading run of sentinels and whitespace in `input`. */
    private sentinelRegionEnd(input: string): number {
        let end = 0;
        while (end < input.length) {
            if (input.startsWith(this.sentinel, end)) {
                end += this.sentinel.length;
            } else if (WHITESPACE.test(input[end])) {
                end += 1;
            } else {
                break;
            }
        }
        return end;
    }

    /** Length of the longest suffix of `input` that is a proper sentinel prefix. */
    private partialPrefixLength(input: string): number {
        const maxPrefixLength = Math.min(this.sentinel.length - 1, input.length);
        for (let length = maxPrefixLength; length > 0; length -= 1) {
            if (this.sentinel.startsWith(input.slice(-length))) return length;
        }
        return 0;
    }
}

/**
 * AcpAgentSession wraps an ACP `AcpClient.prompt(sessionId, text)` async
 * generator. Each instance corresponds to one ACP sessionId on a specific
 * cwd. The `send()` method translates raw `session/update` payloads into
 * the unified `NormalizedEvent` stream that ChatManager (and the SSE
 * route) consume.
 *
 * Concerns intentionally NOT in this class:
 *   - Building the first-message preamble / history transcript (ChatManager).
 *   - Mirroring streamed `chunk` text into ChatSession.history and the
 *     auto-branch shared buffer (ChatManager).
 *   - Perf timing of `first_chunk` (ChatManager — needs the original `tStart`).
 */
export class AcpAgentSession implements AgentSession {
    /** Owning runtime id; chatHub resolves the runtime by it. Default "kiro". */
    public readonly runtimeId: string;
    public readonly owner?: RuntimeSessionOwner;
    /** How the agent differs from kiro-cli; read instead of the runtime id. */
    private readonly flavor: AcpAgentFlavor;
    private turnPermissionMode: import('michi-shared').ChatPermissionMode = 'ask';
    private readonly approvals: ApprovalCoordinator;
    private readonly pendingChatPermissions = new Map<number, {
        toolName?: string; allowOptionId?: string; options: import('michi-shared').PermissionOption[]; signal: AbortSignal;
    }>();
    /** The tool call of each approval shown and not yet answered, by requestId (see settleDeclinedToolCall). */
    private readonly permissionToolCalls = new Map<number, string>();
    /** Tool calls whose approval was declined; their later non-terminal updates stay failed. */
    private readonly declinedToolCalls = new Set<string>();
    public readonly runtimeProfileHash?: string | null;
    public parentChatId?: string;
    private history: ChatMessage[] = [];
    private pendingAssistantBuf: string[] | undefined;
    private activeTurn: AbortController | null = null;
    private activePageTurnAttribution: { turnId: string; assistantId: string } | null = null;
    private enableFollowUps: boolean;
    private readonly toolProfile?: RuntimeToolProfile;
    private readonly permissionBroker?: RuntimePermissionBroker;
    private readonly workspaceId: string | null;
    private readonly ownerUserId: string | null;
    private activeMaintenanceExecutionContext: MaintenanceExecutionContext | null = null;
    private agentTurn: AbortController | null = null;

    get nativeEngine() { return this.runtime.engine; }

    getActivePageTurnAttribution(): { turnId: string; assistantId: string } | null {
        return this.owner?.mode === 'interactive' ? this.activePageTurnAttribution : null;
    }

    getActiveMaintenanceExecutionContext(): MaintenanceExecutionContext | null {
        return this.activeMaintenanceExecutionContext;
    }

    private maintenanceContextForSend(input?: AgentTurnInput): MaintenanceExecutionContext | null {
        if (!this.runtime.host.profile.isMaintenance?.(this.toolProfile)) {
            if (input?.maintenanceContext) throw new Error('Maintenance context supplied to a non-maintenance Kiro session');
            return null;
        }
        const context = input?.maintenanceContext;
        if (!context || this.owner?.mode !== 'interactive' || !input?.turnId || !input.assistantMessageId
            || context.workspaceId !== this.workspaceId
            || context.ownerUserId !== (this.ownerUserId ?? 'local-user')
            || !context.jobId || !context.runId || !context.claimedBy || !context.planId
            || !Number.isSafeInteger(context.configRevision) || context.configRevision < 1
            || !Array.isArray(context.sources)) {
            throw new Error('Maintenance Kiro send is missing a valid owner, workspace, or canonical turn binding');
        }
        return { ...context, execution: { nodeId: this.owner.key, turnId: input.turnId, assistantId: input.assistantMessageId, runId: context.runId } };
    }

    getNativeResumeToken() {
        return { engine: this.nativeEngine, sessionId: this.nativeSessionId };
    }

    constructor(
        public readonly id: string,
        public readonly nativeSessionId: string,
        private readonly runtime: AcpAgentRuntime,
        private readonly cwd: string,
        opts?: {
            runtimeId?: string;
            /** Default: the runtime's flavor, else KIRO_FLAVOR. */
            flavor?: AcpAgentFlavor;
            parentChatId?: string;
            enableFollowUps?: boolean;
            owner?: RuntimeSessionOwner;
            runtimeProfileHash?: string | null;
            toolProfile?: RuntimeToolProfile;
            permissionBroker?: RuntimePermissionBroker;
            /** Reported to the Run permission broker. */
            ownerUserId?: string | null;
            workspaceId?: string | null;
        },
    ) {
        this.runtimeId = opts?.runtimeId ?? "kiro";
        // A runtime stand-in without a flavor (tests) speaks kiro-cli.
        this.flavor = opts?.flavor ?? runtime.flavor ?? KIRO_FLAVOR;
        // Chat grants keep the name Kiro sent; the host's grant key decides
        // which pending requests one always-allow answer also covers.
        const permissions = runtime.host.permissions;
        this.approvals = new ApprovalCoordinator({
            permissions,
            canonicalize: (toolName) => permissions.grantKey?.(toolName) ?? toolName,
        });
        this.parentChatId = opts?.parentChatId;
        this.enableFollowUps = opts?.enableFollowUps !== false;
        this.owner = opts?.owner;
        this.runtimeProfileHash = opts?.runtimeProfileHash ?? null;
        this.toolProfile = opts?.toolProfile;
        this.permissionBroker = opts?.permissionBroker;
        this.ownerUserId = opts?.ownerUserId ?? null;
        this.workspaceId = opts?.workspaceId ?? null;
    }

    getEnableFollowUps(): boolean {
        return this.enableFollowUps;
    }

    /** The agent speaks standard ACP only (AcpLaunch.standardAcp). */
    private get standardAcp(): boolean {
        return this.runtime.standardAcp === true;
    }

    /** The agent's own name for a tool call, when the flavor reads one. */
    private get toolNameResolver(): KiroToolNameResolver | undefined {
        return this.flavor.tools?.name ? (toolCall) => this.flavor.tools?.name?.(toolCall) : undefined;
    }

    /** A tool call's display title: the flavor's, else the agent's own. */
    private toolTitle(update: AcpUpdate | undefined): string | undefined {
        const mapped = update && this.flavor.tools?.title ? this.flavor.tools.title(update) : undefined;
        return mapped ?? update?.title;
    }

    /**
     * A standard ACP agent (agy 1.4.12) ends its turn when an approval is
     * declined and never gives that tool call a terminal status, so its
     * card would stay running: mark it failed.
     */
    private settleDeclinedToolCall(toolCallId: unknown): void {
        if (!this.standardAcp || typeof toolCallId !== 'string' || !toolCallId) return;
        this.declinedToolCalls.add(toolCallId);
        this.runtime.getClient?.(this.cwd)?.injectUpdate(this.nativeSessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    }

    private rememberPermissionToolCall(update: AcpUpdate): void {
        const toolCallId = update.toolCall?.toolCallId;
        if (typeof toolCallId === 'string' && toolCallId) this.permissionToolCalls.set(update.requestId, toolCallId);
    }

    private clearPermissions(): void {
        this.pendingChatPermissions.clear();
        this.permissionToolCalls.clear();
    }

    get currentModeId(): string | null {
        return this.runtime.getCurrentMode(this.nativeSessionId) ?? null;
    }

    get currentModelId(): string | null {
        return this.runtime.getCurrentModel(this.nativeSessionId) ?? null;
    }

    getSessionState() {
        return this.runtime.getClient?.(this.cwd)?.getSessionState?.(this.nativeSessionId) ?? { runtimeId: this.runtimeId };
    }

    private stateClient?: AcpClient;
    private detachState?: () => void;
    private readonly stateListeners = new Set<() => void>();

    private observeClient(client: AcpClient | undefined): void {
        if (client === this.stateClient) return;
        this.detachState?.();
        this.stateClient = client;
        this.detachState = client?.onSessionState?.(this.nativeSessionId, () => {
            for (const notify of this.stateListeners) notify();
        });
    }

    onSessionState(notify: () => void): () => void {
        this.stateListeners.add(notify);
        this.observeClient(this.runtime.getClient?.(this.cwd));
        return () => {
            this.stateListeners.delete(notify);
            if (!this.stateListeners.size) { this.detachState?.(); this.stateClient = undefined; }
        };
    }

    getHistory(): ChatMessage[] {
        return this.history;
    }

    getPendingAssistant(): string | undefined {
        return this.pendingAssistantBuf?.join("");
    }

    /**
     * Set a preamble that will be glued onto the next call's transport text
     * (the bytes sent to kiro-cli) without being recorded in `history`. Used
     * by AcpAgentRuntime.newSession to prime the first user turn.
     */
    primeFirstMessage(preamble: string): void {
        this.firstMessagePreamble = preamble;
    }

    private firstMessagePreamble: string | null = null;

    /**
     * ChatHub committed to a turn that will prompt this session: a turn Kiro
     * started on its own and has not shown yet gives way to it (see
     * acpAgentTurns.ts). Prompts outside ChatHub are handled by AcpClient.
     */
    claimTurn(): () => void {
        return this.runtime.getClient?.(this.cwd)?.announcePrompt?.(this.nativeSessionId) ?? (() => {});
    }

    async *send(text: string, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
        const metaAgent = this.runtime.host.profile.isRestricted(this.toolProfile);
        const maintenanceContext = this.maintenanceContextForSend(input);
        if (metaAgent) {
            // kiro-cli runs a leading slash command itself (e.g. /agent swap).
            if (text.trimStart().startsWith('/')) throw new Error('Kiro commands are off for the Meta agent.');
            this.runtime.assertMetaAgentReady(this.nativeSessionId);
        }
        this.turnPermissionMode = this.runtime.host.permissions.mode(this.owner);
        const turn = new AbortController();
        this.activeTurn = turn;
        this.pendingCancelAck = null;
        const pageTurnAttribution = this.owner?.mode === 'interactive' && input?.turnId && input.assistantMessageId
            ? { turnId: input.turnId, assistantId: input.assistantMessageId } : null;
        this.history.push({ role: "user", content: text });

        // The host's per-turn reminders go to the model only — history stays clean.
        const userTurnCount = this.history.filter(m => m.role === "user").length;
        // Non-image attachments have no ACP block type, so name them by path
        // instead of dropping them silently; kiro-cli can read them itself.
        const { images: imageAttachments, promptNote } = prepareAttachments(input?.attachments);
        const linkImages = this.flavor.promptImages === 'resourceLink';
        const turnSuffix = metaAgent || this.toolProfile?.assistant || maintenanceContext ? '' : this.runtime.host.prompt.turnSuffix({
            metadataChannel: this.flavor.prompt.metadataChannel,
            userTurnCount,
            enableFollowUps: this.enableFollowUps,
            owner: this.owner,
        });
        const textForModel = (this.runtime.host.profile.maintenancePromptPrefix?.(maintenanceContext) ?? '')
            + (input?.pageContext ? `${input.pageContext}\n\n---\n\n` : '')
            + text + promptNote + (linkImages ? describeLinkedImages(imageAttachments) : '') + turnSuffix
            + (this.runtime.getMcpSessionReminder?.(this.nativeSessionId) ?? '');

        const transportText = this.firstMessagePreamble
            ? `${this.firstMessagePreamble}\n${textForModel}`
            : textForModel;
        this.firstMessagePreamble = null;
        const imageBlocks = linkImages ? buildImageLinkBlocks(imageAttachments) : buildKiroImageBlocks(imageAttachments);
        const buf: string[] = [];
        this.pendingAssistantBuf = buf;
        try {
            this.activePageTurnAttribution = pageTurnAttribution;
            this.activeMaintenanceExecutionContext = maintenanceContext;
            for await (const ev of this.streamUpdates(transportText, imageBlocks, turn.signal)) {
                if (ev.kind === "chunk") buf.push(ev.text);
                if (ev.kind === 'turn_end' && ev.stopReason !== 'cancelled' && ev.stopReason !== 'error' && input?.assistantMessageId) {
                    await this.runtime.recordForkAnchor?.(this.id, this.nativeSessionId, input);
                }
                // The host hears this turn's cancel ack before its end: the
                // ack settles with the prompt, ahead of the end it yields.
                const cancelAck = this.pendingCancelAck as Promise<CancelAck> | null;
                if (ev.kind === 'turn_end' && ev.stopReason === 'cancelled' && this.activeTurn === turn && cancelAck) {
                    await cancelAck.catch(() => undefined);
                }
                yield ev;
                if (ev.kind === "turn_end") break;
            }
            // A catalog change Kiro published mid-turn cancelled it; say why.
            if (metaAgent) this.runtime.assertMetaAgentReady(this.nativeSessionId);
        } finally {
            this.clearPermissions();
            this.declinedToolCalls.clear();
            if (buf.length > 0) {
                this.history.push({ role: "assistant", content: buf.join("") });
            }
            if (this.activeTurn === turn) {
                this.activeTurn = null;
                this.pendingAssistantBuf = undefined;
            }
            if (this.activePageTurnAttribution === pageTurnAttribution) this.activePageTurnAttribution = null;
            if (this.activeMaintenanceExecutionContext === maintenanceContext) this.activeMaintenanceExecutionContext = null;
        }
    }

    /**
     * Prompt-turn stream with a single connection-class auto-retry.
     *
     * When kiro's model connection dies mid-turn (`dispatch failure`, stalled
     * stream, dead process) or hiccups transiently (throttle, model briefly
     * unavailable, "failed to generate a response"), a lone retry usually
     * clears it. We retry ONCE, and ONLY when the failed attempt produced zero
     * visible output — otherwise a resend would duplicate or garble the answer
     * the user already saw.
     *
     *   - connection class → respawn the kiro process AND `session/load` the
     *     same sid (restores on-disk transcript, so prior-turn memory survives),
     *     then resend. If recovery itself fails, surface the original error.
     *   - transient class  → the connection is fine; resend on the same session.
     *   - auth / generic   → never retried; rethrown immediately.
     *
     * The thrown error carries `acpErrorKind` (connection | auth | generic) so
     * ChatHub can hand the UI a class-appropriate banner.
     *
     * Agent Run sessions (a headless owner) disable the hidden auto-retry.
     * A tool may have produced a non-visible side effect before the transport
     * failed, making an automatic resend unsafe. Durable Run recovery is owned
     * by the Coordinator and uses the persisted ACP session id.
     */
    private async *streamUpdates(text: string, imageBlocks: AcpPromptBlock[], signal: AbortSignal): AsyncIterableIterator<NormalizedEvent> {
        let attempt = 0;
        let retryActive = false;
        while (true) {
            let firstVisibleYielded = false;
            try {
                for await (const ev of this.runPromptOnce(text, imageBlocks, signal)) {
                    if (retryActive && ev.kind !== "heartbeat") {
                        yield { kind: "retry_end" };
                        retryActive = false;
                    }
                    if (!["heartbeat", "session_state", "commands"].includes(ev.kind)) firstVisibleYielded = true;
                    yield ev;
                }
                if (retryActive) {
                    yield { kind: "retry_end" };
                    retryActive = false;
                }
                return;
            } catch (err) {
                // The retry stays visible while the retried prompt is in flight.
                // Close it before cancellation or a terminal error is surfaced.
                if (retryActive) {
                    yield { kind: "retry_end" };
                    retryActive = false;
                }
                // A cancelled prompt can fail with a normal connection/transient
                // error. Retrying it would restart work the user just stopped
                // (and connection recovery kills other sessions on this cwd).
                if (signal.aborted) {
                    yield { kind: "turn_end", stopReason: "cancelled" };
                    return;
                }
                if (isHeadlessOwner(this.owner)) throw err;
                const cls = classifyAcpError(err);
                // V3 has no idempotency key: an absent response does not prove
                // the submitted prompt did no work. Only a transport preflight
                // rejection is known not to have reached the server.
                const safeToResend = this.nativeEngine !== 'v3' || err instanceof ACPRequestNotSentError;
                const canRetry = safeToResend && attempt === 0 && !firstVisibleYielded && isRetryable(cls);
                if (!safeToResend && isRetryable(cls) && err instanceof Error) {
                    err.message = `Kiro stopped responding after the request was submitted. It may have performed actions. Check the session before retrying. ${err.message}`;
                }
                if (!canRetry) {
                    (err as { acpErrorKind?: string }).acpErrorKind = toErrorKind(cls);
                    throw err;
                }
                attempt += 1;
                // Make the hidden retry visible. Until now the UI showed a
                // static "…" for the whole retry and only revealed anything on
                // final failure, so a working auto-retry looked like a hang.
                // Keep this activity open until the retried prompt produces its
                // first non-heartbeat event, finishes without output, or fails.
                yield { kind: "retry_start", detail: `${retryReason(cls)}. Retrying (attempt ${attempt})…` };
                retryActive = true;
                if (needsRespawn(cls)) {
                    let recovered: boolean;
                    try {
                        recovered = await this.runtime.recoverSession(this.nativeSessionId, this.cwd);
                    } catch {
                        yield { kind: "retry_end" };
                        retryActive = false;
                        (err as { acpErrorKind?: string }).acpErrorKind = toErrorKind(cls);
                        throw err;
                    }
                    if (!recovered) {
                        yield { kind: "retry_end" };
                        retryActive = false;
                        (err as { acpErrorKind?: string }).acpErrorKind = toErrorKind(cls);
                        throw err;
                    }
                }
                // Loop: resend the same transport text. For connection recovery
                // the process is fresh + session reloaded; for transient it's
                // the same live session.
            }
        }
    }

    private readonly cancelRecoveryPollMs = CANCEL_RECOVERY_POLL_MS;
    private readonly cancelRecoveryHeartbeatMs = HEARTBEAT_INTERVAL_MS;

    /**
     * Restoring a quarantined session restarts the shared Kiro process, which
     * the runtime refuses while a healthy peer still uses it. Keep retrying
     * until the peer finishes instead of failing the turn. The wait holds no
     * lock, so other chats on this process keep working; the user's message
     * is sent only after the restore, so it is never sent twice. Returns
     * undefined when the turn is stopped while waiting.
     */
    private async *recoverCancelledSessionWhenFree(signal: AbortSignal): AsyncGenerator<NormalizedEvent, AcpClient | undefined> {
        const startedAt = Date.now();
        let lastSignalAt = startedAt;
        for (;;) {
            let workflowRunning = false;
            try {
                return await this.runtime.recoverCancelledSession(this.nativeSessionId, this.cwd);
            } catch (error) {
                if (!(error instanceof KiroCancelRecoveryBusyError)) throw error;
                workflowRunning = error.workflowRunning;
            }
            lastSignalAt = Date.now();
            yield {
                kind: 'retry_start',
                // A paused workflow never finishes by itself; say what unblocks it.
                detail: workflowRunning
                    ? 'Waiting for the workflow using this Kiro process to finish. Resume or stop a paused workflow from its card'
                    : 'Waiting for another task using this Kiro process to finish',
            };
            // The runtime makes the final decision; this check only times the
            // next attempt and keeps the status label accurate.
            do {
                const waited = await delay(this.cancelRecoveryPollMs, undefined, { signal }).then(() => true, () => false);
                if (!waited) return undefined;
                // No ACP prompt is running yet, so nothing else keeps the stream alive.
                if (Date.now() - lastSignalAt >= this.cancelRecoveryHeartbeatMs) {
                    lastSignalAt = Date.now();
                    yield { kind: 'heartbeat', idleMs: lastSignalAt - startedAt };
                }
            } while (this.runtime.getClient(this.cwd)?.hasHealthyWork());
            yield { kind: 'retry_start', detail: 'Restoring original Kiro session' };
        }
    }

    /**
     * Run a single prompt turn, translating raw kiro `session/update` payloads
     * into NormalizedEvents. Wrapped by `streamUpdates`, which handles the
     * single connection-class auto-retry. This inner generator is deliberately
     * left as-is on its error path: it flushes any held sentinel tail as a
     * `chunk` before rethrowing, so a turn that produced ANY visible output is
     * observable to the wrapper (which then declines to retry).
     */
    private async *runPromptOnce(text: string, imageBlocks: AcpPromptBlock[], signal: AbortSignal): AsyncIterableIterator<NormalizedEvent> {
        this.clearPermissions();
        if (signal.aborted) {
            yield { kind: "turn_end", stopReason: "cancelled" };
            return;
        }
        let c = await this.runtime.ensureClient(this.cwd);
        if (c.needsSessionRecovery?.(this.nativeSessionId)) {
            yield { kind: 'retry_start', detail: 'Restoring original Kiro session' };
            const recovered = yield* this.recoverCancelledSessionWhenFree(signal);
            yield { kind: 'retry_end' };
            if (!recovered) {
                yield { kind: 'turn_end', stopReason: 'cancelled' };
                return;
            }
            c = recovered;
        }
        if (signal.aborted) {
            yield { kind: 'turn_end', stopReason: 'cancelled' };
            return;
        }
        if (this.stateListeners.size) this.observeClient(c);
        await this.reconcilePolicyPresets(c);
        let endMcpTurn: (() => void) | undefined;
        try {
            // Recovery can replace the MCP group. Activate the rebuilt binding
            // only once the native client is ready to accept this prompt.
            endMcpTurn = this.runtime.beginMcpSessionTurn?.(this.nativeSessionId, () => this.getActivePageTurnAttribution());
            yield* this.translateUpdates(c.prompt(this.nativeSessionId, text, imageBlocks, signal), signal);
        } finally {
            endMcpTurn?.();
        }
    }

    /**
     * Whether this chat would approve, without asking, a tool request from a
     * workflow it launched: the rule its own requests follow, under the mode
     * the chat has now (the run outlives the turn that launched it).
     * Restricted and headless sessions never do.
     */
    approvesWorkflowRequest(toolCall: unknown, meta?: unknown): boolean {
        if (this.runtime.host.profile.isRestricted(this.toolProfile)) return false;
        const owner = this.owner ?? interactiveOwner(this.id);
        if (!isInteractiveOwner(owner)) return false;
        const toolName = acpPermissionToolName(toolCall, meta);
        const mode = this.runtime.host.permissions.mode(this.owner);
        return this.approvals.policy(owner, null, toolName ?? '', true, mode) === 'allow';
    }

    /**
     * Kiro V3 seeds Approve for me only when it opens a session, so this
     * reopens the session when a turn in Ask needs the preset and lacks it,
     * or must not keep one from an earlier choice. Trust and YOLO approve
     * everything anyway and leave the session as it is. Not removing it fails
     * the turn: its classifier would approve what the person asked to review.
     */
    private async reconcilePolicyPresets(c: AcpClient): Promise<void> {
        if (this.turnPermissionMode !== 'ask' || !this.runtime.approveForMe) return;
        const current = c.policyPresets?.(this.nativeSessionId);
        if (current === undefined) return;
        const has = current.includes(KIRO_APPROVE_FOR_ME_PRESET);
        const wants = this.runtime.policyPresetsFor(this.owner, this.ownerUserId, this.toolProfile).includes(KIRO_APPROVE_FOR_ME_PRESET);
        if (has === wants) return;
        const presets = current.filter((preset) => preset !== KIRO_APPROVE_FOR_ME_PRESET).concat(wants ? [KIRO_APPROVE_FOR_ME_PRESET] : []);
        try {
            // Closing the session could end a workflow Kiro runs for it.
            if (c.hasOpenWorkflowRuns?.()) throw new Error('a Kiro workflow is running in this process');
            await c.reopenWithPolicyPresets(this.nativeSessionId, presets);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const intact = !c.needsSessionRecovery?.(this.nativeSessionId) && c.policyPresets(this.nativeSessionId) === current;
            // Still without the preset, Kiro asks for everything, as Ask does.
            if (intact && !has) {
                this.runtime.host.observability.log('warn', 'acp', 'Kiro could not turn on Approve for me; asking as in Ask', { sessionId: this.nativeSessionId, error: detail });
                return;
            }
            // The next message restores a session left closed, with the current choice.
            throw new Error(has
                ? `Kiro could not turn off Approve for me for this chat: ${detail}. Send the message again, or choose Approve for me.`
                : `Kiro could not turn on Approve for me for this chat: ${detail}. Send the message again.`);
        }
    }

    /**
     * A turn Kiro started on its own (a finished workflow woke this chat to
     * report back), as the events of a self-initiated chat turn. ChatHub
     * consumes it; Stop reaches it through `cancelAgentTurn`.
     */
    async *agentTurnEvents(updates: AsyncIterableIterator<AcpUpdate>): AsyncIterableIterator<NormalizedEvent> {
        this.turnPermissionMode = this.runtime.host.permissions.mode(this.owner);
        const turn = new AbortController();
        this.agentTurn = turn;
        const buf: string[] = [];
        let ended = false;
        let endMcpTurn: (() => void) | undefined;
        try {
            endMcpTurn = this.runtime.beginMcpSessionTurn?.(this.nativeSessionId, () => this.getActivePageTurnAttribution());
            for await (const ev of this.translateUpdates(updates, turn.signal)) {
                if (ev.kind === 'chunk') buf.push(ev.text);
                if (ev.kind === 'turn_end') ended = true;
                yield ev;
                if (ev.kind === 'turn_end') break;
            }
        } finally {
            endMcpTurn?.();
            this.clearPermissions();
            if (buf.length > 0) this.history.push({ role: 'assistant', content: buf.join('') });
            if (this.agentTurn === turn) this.agentTurn = null;
            // The chat stopped showing it before Kiro ended it (an error, or
            // the chat went away): stop the native turn, so it cannot hold
            // the session or wait on approvals nobody sees.
            if (!ended) this.runtime.getClient(this.cwd)?.releaseAgentTurn(this.nativeSessionId);
        }
    }

    /** Stop the turn Kiro started on its own, if one is running. */
    async cancelAgentTurn(): Promise<CancelAck> {
        this.agentTurn?.abort();
        const c = this.runtime.getClient(this.cwd);
        const dispatched = (await c?.cancelAgentTurn(this.nativeSessionId)) === true;
        return { acknowledged: dispatched, source: 'inferred', confidence: 'unknown', nativeMethod: 'session/cancel' };
    }

    /** Translate raw kiro `session/update` payloads into NormalizedEvents. */
    private async *translateUpdates(updates: AsyncIterable<AcpUpdate>, signal: AbortSignal): AsyncIterableIterator<NormalizedEvent> {
        const completionStripper = new TrailingSentinelStripper(KIRO_METADATA_DONE_SENTINEL);
        const steeringParser = new KiroSteeringParser();
        const steeringEvents = (segments: SteeringSegment[]): NormalizedEvent[] => segments.map((segment) =>
            segment.kind === 'text' ? { kind: 'chunk', text: segment.text }
                : { kind: 'steering_report', reports: [segment.report] });
        // V3 streams subagent narration on the parent session; it belongs to
        // the subagent's activity, never to the parent answer.
        const narration = createSubtaskNarration();
        const narrationEvents = (items: SubagentActivityPayload[]): NormalizedEvent[] =>
            items.map((activity) => ({ kind: 'subagent_tool_activity' as const, ...activity }));
        // What kiro-cli named this turn's tool calls; v2 permission requests carry no name.
        const resolveToolName = this.toolNameResolver;
        const toolCallNames = new KiroToolCallNames(undefined, resolveToolName);
        const flush = (): NormalizedEvent[] => [
            ...narrationEvents(narration.flushAll()),
            ...steeringEvents(steeringParser.push(completionStripper.flush())),
            ...steeringEvents(steeringParser.finish()),
        ];
        try {
            for await (const update of updates) {
                const kind = update.sessionUpdate;
                if (kind === 'tool_call' || kind === 'tool_call_update') toolCallNames.remember(update);
                if (kind === 'session_state') {
                    yield { kind: 'session_state', state: update.state };
                } else if (kind === "agent_message_chunk") {
                    const content = update.content;
                    const blocks = Array.isArray(content) ? content : content ? [content] : [];
                    const subtaskId = kiroSubtaskId(update);
                    for (const b of blocks) {
                        if (b && b.type === "text" && b.text) {
                            if (subtaskId) {
                                yield* narrationEvents(narration.push(subtaskId, update._meta?.kiro?.replayId, b.text));
                                continue;
                            }
                            const filtered = completionStripper.push(b.text);
                            if (filtered) yield* steeringEvents(steeringParser.push(filtered));
                        }
                    }
                } else if (kind === "agent_thought_chunk" && kiroSubtaskId(update)) {
                    // A subagent's private reasoning is not parent output.
                    continue;
                } else if (kind === "agent_thought_chunk") {
                // Same ContentChunk shape as agent_message_chunk, but it's
                // the agent's internal reasoning — do NOT append to the
                // assistant's visible history. Stream it through for UI to
                // optionally display.
                const content = update.content;
                const blocks = Array.isArray(content) ? content : content ? [content] : [];
                for (const b of blocks) {
                    if (b && b.type === "text" && b.text) {
                        yield { kind: "thought", text: b.text };
                    }
                }
            } else if (kind === 'session_info_update') {
                yield* this.flavor.sessionInfoEvents(update);
            } else if (kind === "plan") {
                const entries = Array.isArray(update.entries) ? update.entries : [];
                yield {
                    kind: "plan",
                    entries: entries.map((e: any) => ({
                        content: String(e?.content ?? ""),
                        priority: (e?.priority === "high" || e?.priority === "low" ? e.priority : "medium") as PlanEntry["priority"],
                        status: (e?.status === "in_progress" || e?.status === "completed" ? e.status : "pending") as PlanEntry["status"],
                    })),
                };
            } else if ((kind === "tool_call" || kind === "tool_call_update")
                && kiroSubtaskId(update) && !isKiroDelegation(update)) {
                // V3 child tool of a subagent: it is the subagent's activity,
                // not a parent tool chip.
                const subtaskId = kiroSubtaskId(update)!;
                const pending = narration.boundary(subtaskId);
                if (pending) yield* narrationEvents([pending]);
                yield { kind: 'subagent_tool_activity', ...kiroChildToolActivity(subtaskId, update) };
            } else if (kind === "tool_call" || kind === "tool_call_update") {
                const rawInput = update.rawInput;
                const toolTitle = this.toolTitle(update) || "";
                const purpose = extractToolUsePurpose(rawInput);
                const inputStr = rawInput != null
                    ? (typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput))
                    : undefined;
                const contentOutput = Array.isArray(update.content) ? update.content
                    .flatMap((block: any) => block?.type === 'content' && block.content?.type === 'text'
                        ? [block.content.text] : block?.type === 'diff' ? [JSON.stringify(block)] : [])
                    .join('\n') : undefined;
                const rawOutputStr = this.standardAcp ? standardToolOutput(update.rawOutput, contentOutput) : (update.rawOutput != null
                    ? (typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput))
                    : contentOutput) || undefined;
                const outputStr = rawOutputStr
                    ? this.runtime.host.prompt.toolResultForDisplay?.(rawOutputStr) ?? rawOutputStr
                    : undefined;
                const MAX_PAYLOAD = 16 * 1024;
                const delegation = isKiroDelegation(update);
                // agy keeps reporting a declined call as in_progress after the decline.
                const declined = this.standardAcp && this.declinedToolCalls.has(update.toolCallId)
                    && update.status !== 'completed' && update.status !== 'failed';
                yield {
                    kind,
                    toolCallId: update.toolCallId || "",
                    title: toolTitle,
                    status: declined ? 'failed' : update.status || "",
                    // V3 delegation chips carry the explicit subagent kind so
                    // the UI renders them as subagent cards.
                    kindType: delegation ? 'subagent' : update.kind || undefined,
                    detail: purpose,
                    inputJson: inputStr && inputStr.length > MAX_PAYLOAD ? inputStr.slice(0, MAX_PAYLOAD) : inputStr,
                    output: outputStr && outputStr.length > MAX_PAYLOAD ? outputStr.slice(0, MAX_PAYLOAD) : outputStr,
                };
                if (delegation) {
                    const entry = kiroV3DelegationEntry(update);
                    if (entry) {
                        if (entry.status === 'terminated') {
                            const pending = narration.flush(entry.sessionId);
                            if (pending) yield* narrationEvents([pending]);
                        }
                        yield { kind: 'subagent_list_update', subagents: [entry] };
                    }
                }
            } else if (kind === "__heartbeat__") {
                yield { kind: "heartbeat", idleMs: update.idleMs || 0 };
            } else if (kind === "host_event") {
                // What the host's tools reported through the slot's sink (AcpAgentRuntime.slotEventSink).
                const event = injectedHostEvent(update);
                if (event) yield event;
            } else if (kind === "branch_overview") {
                if (typeof update.overview === "string" && update.overview.trim()) {
                    yield {
                        kind: "host_event",
                        type: "branch_overview",
                        payload: { overview: update.overview.trim() },
                    };
                }
            } else if (kind === "follow_ups") {
                const followUps = Array.isArray(update.followUps)
                    ? update.followUps.map((f: unknown) => String(f).trim()).filter(Boolean).slice(0, 3)
                    : [];
                if (followUps.length > 0) {
                    yield { kind: "host_event" as const, type: "follow_ups", payload: { followUps } };
                }
            } else if (kind === "permission_resolved") {
                this.pendingChatPermissions.delete(update.requestId);
                this.permissionToolCalls.delete(update.requestId);
                yield { kind: "permission_resolved" as const, requestId: update.requestId };
            } else if (kind === "permission_request") {
                if (signal.aborted || this.runtime.host.profile.isRestricted(this.toolProfile)) { this.runtime.cancelPermission(this.nativeSessionId, update.requestId); continue; }
                // Incoming permission request from kiro-cli — headless owners
                // route through the Run permission broker; interactive owners
                // forward to SSE for the frontend approval dialog.
                if (isHeadlessOwner(this.owner) && this.permissionBroker) {
                    // Broker the permission asynchronously. ACP is blocked
                    // waiting for our JSON-RPC response, so the agent stays
                    // paused until we answer.
                    // The title is prose, so the policy needs the canonical
                    // name; an unnamed tool stays "unknown", never its title.
                    const toolName = kiroBrokerToolName(update.toolCall, update._meta, toolCallNames.get(update.toolCall?.toolCallId), resolveToolName);
                    const decision = await this.permissionBroker.requestPermission({
                        owner: this.owner,
                        ownerUserId: this.ownerUserId,
                        workspaceId: this.workspaceId,
                        toolName,
                        input: update.toolCall,
                        toolCallId: update.toolCall?.toolCallId,
                    });
                    const rawOptions: any[] = Array.isArray(update.options) ? update.options : [];
                    if (decision === "allow_once" || decision === "allow_always") {
                        // Run grants are Attempt-scoped. Always select allow_once
                        // on the wire, never persist a broader provider grant.
                        const allowOption = rawOptions.find(
                            (o: any) => o.kind === 'allow_once',
                        ) ?? rawOptions.find((o: any) => !o.kind && (o.optionId === 'allow' || o.optionId === 'yes'));
                        if (allowOption) {
                            this.runtime.respondToPermission(this.nativeSessionId, update.requestId, allowOption.optionId);
                        } else {
                            this.runtime.cancelPermission(this.nativeSessionId, update.requestId);
                            this.settleDeclinedToolCall(update.toolCall?.toolCallId);
                        }
                        // allow_always for Runs is Attempt-scoped only — do NOT
                        // write a normal chat Workspace grant.
                    } else if (decision === "deny") {
                        this.runtime.cancelPermission(this.nativeSessionId, update.requestId);
                        this.settleDeclinedToolCall(update.toolCall?.toolCallId);
                    } else {
                        // "ask" — surface as a Run interaction so the Executor/UI
                        // can handle it. Yield the permission_request event.
                        this.rememberPermissionToolCall(update);
                        yield {
                            kind: "permission_request" as const,
                            requestId: update.requestId,
                            toolCallId: update.toolCall?.toolCallId,
                            title: subagentPermissionTitle(update, this.toolTitle(update.toolCall) ?? "Tool call"),
                            options: rawOptions,
                            source: "acp_permission",
                        };
                    }
                } else {
                    const options = (Array.isArray(update.options) ? update.options : []).filter(
                        (option: { kind?: string }) => option.kind !== 'allow_always' && option.kind !== 'reject_always',
                    );
                    const allow = options.find((option: { kind?: string }) => option.kind === 'allow_once');
                    const toolName = acpPermissionToolName(update.toolCall, update._meta, resolveToolName);
                    const owner = this.owner ?? interactiveOwner(this.id);
                    if (allow && this.approvals.policy(owner, null, toolName ?? '', true, this.turnPermissionMode) === 'allow') {
                        this.runtime.respondToPermission(this.nativeSessionId, update.requestId, allow.optionId);
                        continue;
                    }
                    if (allow && isInteractiveOwner(owner)) {
                        options.push(...chatApprovalOptions(toolName).filter((option) => option.kind === 'allow_always' || option.kind === 'allow_session')
                            .map((option) => ({ ...option, optionId: `michi:${option.optionId}` })));
                    }
                    this.pendingChatPermissions.set(update.requestId, { toolName, allowOptionId: allow?.optionId, options, signal });
                    this.rememberPermissionToolCall(update);
                    yield {
                        kind: "permission_request" as const,
                        requestId: update.requestId,
                        toolCallId: update.toolCall?.toolCallId,
                        title: subagentPermissionTitle(update, toolName ? `Approve ${toolName}?` : this.toolTitle(update.toolCall) ?? "Tool call"),
                        detail: typeof update.toolCall?.rawInput === 'string' ? update.toolCall.rawInput
                            : update.toolCall?.rawInput != null ? JSON.stringify(update.toolCall.rawInput) : undefined,
                        options,
                        source: "acp_permission",
                    };
                }
            } else if (kind === "subagent_list_update" && update.michi === true) {
                // Crew's adapter already speaks the shared roster contract.
                const subagents = parseSubagentRoster(update.subagents);
                if (subagents.length > 0) yield { kind: "subagent_list_update" as const, subagents };
            } else if (kind === "subagent_tool_activity" && update.michi === true) {
                yield { kind: "subagent_tool_activity" as const, ...parseSubagentActivityPayload(update) };
            } else if (kind === "subagent_list_update") {
                const parentToolCallId = typeof update.parentToolCallId === 'string' ? update.parentToolCallId : undefined;
                const subagents = (Array.isArray(update.subagents) ? update.subagents : [])
                    .map((s: any) => kiroV2RosterEntry(s, parentToolCallId))
                    .filter((s: { sessionId: string }) => s.sessionId);
                if (subagents.length > 0) yield { kind: "subagent_list_update" as const, subagents };
            } else if (kind === "subagent_message_chunk") {
                // V2 child narration, forwarded by AcpClient from the child session.
                const subagentSessionId = String(update.subagentSessionId ?? "");
                const text = typeof update.text === 'string' ? update.text : '';
                if (subagentSessionId && text) yield* narrationEvents(narration.push(subagentSessionId, undefined, text));
            } else if (kind === "subagent_tool_activity") {
                const subagentSessionId = String(update.subagentSessionId ?? "");
                const child = update.childUpdate && typeof update.childUpdate === 'object' ? update.childUpdate : null;
                const pending = narration.boundary(subagentSessionId);
                if (pending) yield* narrationEvents([pending]);
                if (child) {
                    toolCallNames.remember(child);
                    yield { kind: "subagent_tool_activity" as const, ...kiroChildToolActivity(subagentSessionId, child) };
                    const result = kiroV2SummaryResult(child);
                    if (result) yield { kind: "subagent_list_update" as const, subagents: [kiroV2ResultPatch(subagentSessionId, result)] };
                } else {
                    yield {
                        kind: "subagent_tool_activity" as const,
                        subagentSessionId,
                        title: String(update.title ?? ""),
                        status: String(update.status ?? ""),
                        ...(update.toolCallId ? { toolCallId: String(update.toolCallId) } : {}),
                        ...(update.kind ? { toolKind: String(update.kind) } : {}),
                    };
                }
            } else if (kind === "context_usage") {
                const pct = Number(update.contextUsagePercentage);
                if (Number.isFinite(pct)) {
                    yield { kind: "context_usage" as const, contextUsagePercentage: pct };
                }
            } else if (kind === "compaction_start") {
                yield { kind: "compaction_start" as const, detail: "compact" };
            } else if (kind === "compaction_end") {
                yield {
                    kind: "compaction_end" as const,
                    detail: typeof update.summary === "string" ? update.summary : "compact",
                };
            } else if (kind === "clear_status") {
                // Session history was cleared. Emit as a compaction pair so the
                // UI can show a brief "cleared" indicator without a new event kind.
                yield { kind: "compaction_start" as const, detail: "clear" };
                yield { kind: "compaction_end" as const, detail: "clear" };
            } else if (kind === "usage_summary") {
                if (update.source === 'acp') {
                    // Token counts only: a standard ACP agent reports no credits, cost or context
                    // window. They are the agent's own counts, so the source is native, as for Codex.
                    const tokens = acpTokenUsage(update);
                    yield { kind: 'usage_summary', source: Object.keys(tokens).length ? 'native' : 'unverifiable', ...tokens };
                    continue;
                }
                if (update.source === 'kiro-v3') {
                    yield {
                        kind: 'usage_summary', source: 'kiro-v3',
                        contextUsagePercentage: update.contextUsagePercentage,
                        totalCredits: update.totalCredits,
                        ...(typeof update.totalCredits === 'number' ? { charge: { amount: update.totalCredits, unit: 'credits' as const, provenance: 'native_metering' as const } } : {}),
                        turnDurationMs: update.turnDurationMs,
                    };
                    continue;
                }
                const pct = Number(update.contextUsagePercentage);
                const credits = (update.meteringUsage ?? []).reduce(
                    (sum: number, m: any) => sum + (Number(m.value) || 0), 0
                );
                const dur = Number(update.turnDurationMs);
                yield {
                    kind: "usage_summary" as const,
                    contextUsagePercentage: Number.isFinite(pct) ? pct : 0,
                    totalCredits: Number.isFinite(credits) ? credits : 0,
                    charge: { amount: Number.isFinite(credits) ? credits : 0, unit: "credits" as const, provenance: "native_metering" as const },
                    source: "native",
                    turnDurationMs: Number.isFinite(dur) ? dur : 0,
                };
            } else if (kind === "mcp_server_error") {
                yield {
                    kind: "mcp_server_error" as const,
                    serverName: String(update.serverName ?? ""),
                    error: String(update.error ?? ""),
                };
            } else if (kind === 'runtime_error') {
                yield { kind: 'runtime_error', error: String(update.error ?? 'Kiro reported an error') };
            } else if (kind === "user_input_request") {
                yield {
                    kind: "user_input_request" as const,
                    requestId: update.requestId,
                    questions: Array.isArray(update.questions) ? update.questions : [],
                };
            } else if (kind === "user_input_resolved") {
                yield {
                    kind: "user_input_resolved" as const,
                    requestId: update.requestId,
                    answers: Array.isArray(update.answers) ? update.answers : [],
                };
            } else if (kind === "available_commands_update") {
                // Kiro publishes its slash-command catalog (e.g. /compact,
                // /mode, custom per-agent commands) via this update. We
                // surface it unchanged so the UI can render an autocomplete.
                const raw = Array.isArray(update.availableCommands)
                    ? update.availableCommands
                    : [];
                const commands = raw
                    .map((c: any) => ({
                        name: typeof c?.name === "string" ? c.name : "",
                        description:
                            typeof c?.description === "string" ? c.description : undefined,
                        input:
                            c?.input && typeof c.input === "object"
                                ? { type: String(c.input.type ?? "unstructured") }
                                : undefined,
                    }))
                    .filter((c: { name: string }) => c.name.length > 0);
                yield { kind: "commands", commands };
                } else if (kind === "turn_end") {
                    yield* flush();
                    yield { kind: "turn_end", stopReason: update.stopReason };
                    break;
                }
            }
        } catch (err) {
            yield* flush();
            throw err;
        }
        yield* flush();
        const held = completionStripper.flush();
        if (held) yield { kind: "chunk", text: held };
    }

    /**
     * `session/cancel` is a notification, so the ack comes from the flavor's
     * KiroCancelAck. kiro-cli settles the pending `session/prompt` with
     * stopReason "cancelled" (2.35.1: 0-30 ms on both engines); that answer
     * within the cancel deadline is a native acknowledgement. Kiro Crew's
     * Gateway records the stop, read after the dispatch. Any other outcome
     * (no prompt out, another stopReason, a failed prompt, no record, the
     * deadline) reports only that the cancel was dispatched, tagged
     * `inferred`. The cancel watchdog in AcpClient still quarantines a
     * session whose agent does not stop, and the hub's force-finish timer
     * bounds the UI.
     */
    cancel(): Promise<CancelAck> {
        // Only a turn Kiro started on its own is running: stop that one. A
        // prompt cancel would also mark the session's next prompt cancelled.
        if (!this.activeTurn && this.agentTurn) return this.cancelAgentTurn();
        const ack = this.cancelPrompt();
        // The turn's end waits for the ack (see send): ChatHub drops an ack
        // that arrives after the turn has ended.
        this.pendingCancelAck = ack;
        return ack;
    }

    /** The ack of this turn's cancel, held until the turn's end is passed on (see send). */
    private pendingCancelAck: Promise<CancelAck> | null = null;

    private async cancelPrompt(): Promise<CancelAck> {
        this.runtime.endMcpSessionTurn?.(this.nativeSessionId);
        this.activeTurn?.abort();
        const c = this.runtime.getClient(this.cwd);
        const inferred = (dispatched: boolean): CancelAck => ({
            acknowledged: dispatched,
            source: "inferred",
            confidence: "unknown",
            nativeMethod: "session/cancel",
        });
        if (!c) return inferred(false);
        const by = this.flavor.cancelAck;
        if (by?.kind === 'prompt-settlement') {
            const settled = await c.cancelAndSettle(this.nativeSessionId, { spareOvertakenWake: true });
            if (settled.dispatched && settled.stopReason === 'cancelled') {
                return { acknowledged: true, source: "native", confidence: "native", nativeMethod: "session/cancel + stopReason cancelled" };
            }
            return inferred(settled.dispatched);
        }
        const dispatched = (await c.cancel(this.nativeSessionId, { spareOvertakenWake: true })) === true;
        if (dispatched && by?.kind === 'agent-record') {
            const confirmed = await by.confirm(c, this.nativeSessionId).catch(() => undefined);
            if (confirmed) return confirmed;
        }
        return inferred(dispatched);
    }

    async steer(text: string): Promise<SteerResult> {
        const turn = this.activeTurn;
        if (!turn || turn.signal.aborted || !text.trim()) return { accepted: false, reason: 'no_active_turn' };
        if (this.runtime.host.profile.isRestricted(this.toolProfile) && text.trimStart().startsWith('/')) return { accepted: false, reason: 'not_queued' };
        const c = this.runtime.getClient(this.cwd);
        if (!c) return { accepted: false, reason: 'client_not_running' };
        const result = await c.steer(this.nativeSessionId, text);
        if (!result.queued) return { accepted: false, reason: 'not_queued' };
        this.history.push({ role: 'user', content: text });
        return { accepted: true, pending: true };
    }

    async clearQueue(): Promise<void> {
        const c = this.runtime.getClient(this.cwd);
        if (!c) throw new Error('Kiro client is not running');
        const result = await c.clearSteer(this.nativeSessionId);
        if (!result.cleared) throw new Error('Kiro did not clear the steering queue');
    }

    /**
     * Execute a Kiro slash command via the dedicated ACP RPC instead of
     * sending it as prompt text. Returns the structured response. Side
     * effects (compaction/clear notifications) arrive on the session queue
     * and will be yielded during the next prompt turn, or can be consumed
     * by polling the session queue directly.
     */
    async executeCommand(
        command: string,
        args?: Record<string, unknown>,
    ): Promise<{ success: boolean; message?: string; data?: unknown }> {
        const c = await this.runtime.ensureClient(this.cwd);
        if (command === 'compact') {
            const instructions = args?.instructions ?? args?.value;
            return c.compact(this.nativeSessionId, typeof instructions === 'string' ? instructions : undefined);
        }
        if (this.runtime.host.profile.isRestricted(this.toolProfile)) return { success: false, message: 'Kiro commands are off for the Meta agent.' };
        return c.executeCommand(this.nativeSessionId, command, args);
    }

    /** Wait for native completion, including v2's asynchronous status event. */
    async compact(instructions?: string): Promise<CompactResult> {
        const client = await this.runtime.ensureClient(this.cwd);
        const result = await client.compact(this.nativeSessionId, instructions);
        if (!result.success) {
            return { started: false, detail: result.message };
        }
        return { started: true, completed: true, detail: result.message };
    }

    async setMode(modeId: string): Promise<void> {
        await this.runtime.setMode(this.nativeSessionId, modeId);
    }

    async setModel(modelId: string): Promise<void> {
        await this.runtime.setModel(this.nativeSessionId, modelId);
    }

    respondToPermission(requestId: number, optionId: string): void {
        const toolCallId = this.permissionToolCalls.get(requestId);
        if (isHeadlessOwner(this.owner)) {
            const c = this.runtime.getClient(this.cwd);
            const kind = optionId === 'allow_once' || optionId === 'allow_always' ? 'allow_once' : 'reject_once';
            c?.respondToPermissionKind(requestId, kind);
            this.permissionToolCalls.delete(requestId);
            if (kind === 'reject_once') this.settleDeclinedToolCall(toolCallId);
            return;
        }
        const pending = this.pendingChatPermissions.get(requestId);
        if (!pending || pending.signal.aborted) return;
        const option = pending.options.find((candidate) => candidate.optionId === optionId && !candidate.disabled);
        if (!option) throw new Error('Invalid permission option');
        this.pendingChatPermissions.delete(requestId);
        const owner = this.owner ?? interactiveOwner(this.id);
        const allow = pending.allowOptionId && this.approvals.accept(option.kind, owner, pending.toolName);
        this.runtime.respondToPermission(this.nativeSessionId, requestId, allow ? pending.allowOptionId! : optionId);
        this.permissionToolCalls.delete(requestId);
        if (!allow && option.kind?.startsWith('reject')) this.settleDeclinedToolCall(toolCallId);
        if (allow && (option.kind === 'allow_session' || option.kind === 'allow_always')) {
            for (const [id, request] of this.pendingChatPermissions) {
                if (request.allowOptionId && !request.signal.aborted && this.approvals.covers(option.kind, pending.toolName, request.toolName)) {
                    this.respondToPermission(id, request.allowOptionId);
                }
            }
        }
    }

    cancelPermission(requestId: number): void {
        const toolCallId = this.permissionToolCalls.get(requestId);
        this.pendingChatPermissions.delete(requestId);
        this.permissionToolCalls.delete(requestId);
        this.runtime.cancelPermission(this.nativeSessionId, requestId);
        this.settleDeclinedToolCall(toolCallId);
    }

    respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>): void {
        this.runtime.respondToUserInput(requestId, answers);
    }

    skipUserInput(requestId: number): void {
        this.runtime.skipUserInput(requestId);
    }
}
