import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, AgentTurnInput, ChatMessage } from "../types";
import type { NormalizedEvent, PlanEntry } from "../../services/chatEvents";
import type { AcpPromptBlock } from "../../services/acpClient";
import type { AcpAgentRuntime } from "../acp/AcpRuntime";
import { followUpReminder } from "../preamble";
import { classifyAcpError, isRetryable, needsRespawn, toErrorKind } from "./acpErrors";

const KIRO_IMAGE_MEDIA_TYPES: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

/** Read local image attachments into ACP image prompt blocks. kiro-cli
 *  advertises promptCapabilities.image: true; non-image or unreadable files
 *  are skipped rather than failing the turn. */
function buildKiroImageBlocks(input?: AgentTurnInput): AcpPromptBlock[] {
    const blocks: AcpPromptBlock[] = [];
    const seen = new Set<string>();
    for (const attachment of input?.attachments ?? []) {
        const absPath = attachment.absPath;
        if (!path.isAbsolute(absPath) || seen.has(absPath)) continue;
        const mimeType = KIRO_IMAGE_MEDIA_TYPES[path.extname(absPath).toLowerCase()];
        if (!mimeType) continue;
        try {
            if (!fs.statSync(absPath).isFile()) continue;
            const data = fs.readFileSync(absPath).toString("base64");
            seen.add(absPath);
            blocks.push({ type: "image", mimeType, data });
        } catch {
            // Unreadable attachment — skip.
        }
    }
    return blocks;
}

export const KIRO_METADATA_DONE_SENTINEL = "[MICHI_METADATA_DONE]";

const KIRO_METADATA_DONE_TOOL_RESULT =
    `Branch overview updated. Respond with exactly ${KIRO_METADATA_DONE_SENTINEL} and no other text.`;

function stripMetadataCompletionInstruction(output: string): string {
    return output.split(KIRO_METADATA_DONE_TOOL_RESULT).join("Branch overview updated.");
}

class StreamingSentinelStripper {
    private held = "";

    constructor(private readonly sentinel: string) {}

    push(chunk: string): string {
        let remaining = this.held + chunk;
        this.held = "";
        let text = "";

        while (remaining.length > 0) {
            const markerIndex = remaining.indexOf(this.sentinel);
            if (markerIndex >= 0) {
                text += remaining.slice(0, markerIndex);
                remaining = remaining.slice(markerIndex + this.sentinel.length);
                continue;
            }

            let heldLength = 0;
            const maxPrefixLength = Math.min(this.sentinel.length - 1, remaining.length);
            for (let length = maxPrefixLength; length > 0; length -= 1) {
                if (this.sentinel.startsWith(remaining.slice(-length))) {
                    heldLength = length;
                    break;
                }
            }
            text += remaining.slice(0, remaining.length - heldLength);
            this.held = remaining.slice(remaining.length - heldLength);
            break;
        }

        return text;
    }

    flush(): string {
        const text = this.held;
        this.held = "";
        return text;
    }
}

const BRANCH_OVERVIEW_TOOL_REMINDER = `

[Before ending this turn, call the MCP tool set_branch_overview exactly once with {"overview":"..."}: 1-3 concise sentences describing what this turn did — what was explored, decided, or discovered. It appends to the branch's journal; do not restate earlier turns. Match the user's language. Keep the existing [BRANCH-OVERVIEW: ...] sentinel as a fallback.]`;

/**
 * KiroSession wraps an ACP `AcpClient.prompt(sessionId, text)` async
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
export class KiroSession implements AgentSession {
    public readonly runtimeId: string;
    public parentChatId?: string;
    private history: ChatMessage[] = [];
    private pendingAssistantBuf: string[] | undefined;
    private enableFollowUps: boolean;

    constructor(
        public readonly id: string,
        public readonly nativeSessionId: string,
        private readonly runtime: AcpAgentRuntime,
        private readonly cwd: string,
        opts?: { parentChatId?: string; enableFollowUps?: boolean },
    ) {
        this.runtimeId = runtime.id;
        this.parentChatId = opts?.parentChatId;
        this.enableFollowUps = opts?.enableFollowUps !== false;
    }

    getEnableFollowUps(): boolean {
        return this.enableFollowUps;
    }

    get currentModeId(): string | null {
        return this.runtime.getCurrentMode(this.nativeSessionId) ?? null;
    }

    get currentModelId(): string | null {
        return this.runtime.getCurrentModel(this.nativeSessionId) ?? null;
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
     * by KiroRuntime.newSession to prime the first user turn.
     */
    primeFirstMessage(preamble: string): void {
        this.firstMessagePreamble = preamble;
    }

    private firstMessagePreamble: string | null = null;

    async *send(text: string, input?: AgentTurnInput): AsyncIterableIterator<NormalizedEvent> {
        this.history.push({ role: "user", content: text });

        // Append follow-up reminder for the model only — history stays clean.
        const userTurnCount = this.history.filter(m => m.role === "user").length;
        const reminder = followUpReminder(userTurnCount, this.enableFollowUps);
        const sendOverviewReminder = typeof this.runtime.shouldSendBranchOverviewReminder === "function"
            ? this.runtime.shouldSendBranchOverviewReminder()
            : this.runtimeId !== "cursor" && this.runtimeId !== "grok";
        const overviewReminder = sendOverviewReminder ? BRANCH_OVERVIEW_TOOL_REMINDER : "";
        const textForModel = text + (reminder || "") + overviewReminder;

        const transportText = this.firstMessagePreamble
            ? `${this.firstMessagePreamble}\n${textForModel}`
            : textForModel;
        this.firstMessagePreamble = null;
        const imageBlocks = this.runtime.allowsImagePrompt?.(this.cwd) !== false
            ? buildKiroImageBlocks(input)
            : [];
        const buf: string[] = [];
        this.pendingAssistantBuf = buf;
        try {
            for await (const ev of this.streamUpdates(transportText, imageBlocks)) {
                if (ev.kind === "chunk") buf.push(ev.text);
                yield ev;
                if (ev.kind === "turn_end") break;
            }
        } finally {
            if (buf.length > 0) {
                this.history.push({ role: "assistant", content: buf.join("") });
            }
            this.pendingAssistantBuf = undefined;
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
     */
    private async *streamUpdates(text: string, imageBlocks: AcpPromptBlock[] = []): AsyncIterableIterator<NormalizedEvent> {
        let attempt = 0;
        while (true) {
            let firstVisibleYielded = false;
            try {
                for await (const ev of this.runPromptOnce(text, imageBlocks)) {
                    if (ev.kind !== "heartbeat") firstVisibleYielded = true;
                    yield ev;
                }
                return;
            } catch (err) {
                const cls = classifyAcpError(err);
                const canRetry = attempt === 0 && !firstVisibleYielded && isRetryable(cls);
                if (!canRetry) {
                    (err as { acpErrorKind?: string }).acpErrorKind = toErrorKind(cls);
                    throw err;
                }
                attempt += 1;
                if (needsRespawn(cls)) {
                    const recovered = await this.runtime.recoverSession(this.nativeSessionId, this.cwd);
                    if (!recovered) {
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

    /**
     * Run a single prompt turn, translating raw kiro `session/update` payloads
     * into NormalizedEvents. Wrapped by `streamUpdates`, which handles the
     * single connection-class auto-retry. This inner generator is deliberately
     * left as-is on its error path: it flushes any held sentinel tail as a
     * `chunk` before rethrowing, so a turn that produced ANY visible output is
     * observable to the wrapper (which then declines to retry).
     */
    private async *runPromptOnce(text: string, imageBlocks: AcpPromptBlock[] = []): AsyncIterableIterator<NormalizedEvent> {
        const c = await this.runtime.ensureClient(this.cwd);
        const completionStripper = new StreamingSentinelStripper(KIRO_METADATA_DONE_SENTINEL);
        try {
            for await (const update of c.prompt(this.nativeSessionId, text, imageBlocks)) {
                const kind = update.sessionUpdate;
                if (kind === "agent_message_chunk") {
                    const content = update.content;
                    const blocks = Array.isArray(content) ? content : content ? [content] : [];
                    for (const b of blocks) {
                        if (b && b.type === "text" && b.text) {
                            const filtered = completionStripper.push(b.text);
                            if (filtered) yield { kind: "chunk", text: filtered };
                        }
                    }
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
            } else if (kind === "tool_call" || kind === "tool_call_update") {
                const rawInput = update.rawInput;
                const toolTitle = update.title || "";
                const purpose = typeof rawInput?.__tool_use_purpose === "string"
                    ? rawInput.__tool_use_purpose
                    : typeof rawInput?.description === "string"
                        ? rawInput.description
                        : typeof rawInput?.file_path === "string"
                            ? `${toolTitle}: ${rawInput.file_path}`
                            : undefined;
                const inputStr = rawInput != null
                    ? (typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput))
                    : undefined;
                const rawOutputStr = update.rawOutput != null
                    ? (typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput))
                    : undefined;
                const outputStr = rawOutputStr
                    ? stripMetadataCompletionInstruction(rawOutputStr)
                    : undefined;
                const MAX_PAYLOAD = 16 * 1024;
                yield {
                    kind,
                    toolCallId: update.toolCallId || "",
                    title: toolTitle,
                    status: update.status || "",
                    kindType: update.kind || undefined,
                    detail: purpose,
                    inputJson: inputStr && inputStr.length > MAX_PAYLOAD ? inputStr.slice(0, MAX_PAYLOAD) : inputStr,
                    output: outputStr && outputStr.length > MAX_PAYLOAD ? outputStr.slice(0, MAX_PAYLOAD) : outputStr,
                };
            } else if (kind === "__heartbeat__") {
                yield { kind: "heartbeat", idleMs: update.idleMs || 0 };
            } else if (kind === "spawn_branches") {
                yield {
                    kind: "spawn_branches",
                    topics: Array.isArray(update.topics) ? update.topics : [],
                };
            } else if (kind === "artifact_saved") {
                if (typeof update.name === "string" && typeof update.filePath === "string") {
                    yield {
                        kind: "artifact_saved",
                        contextId: typeof update.contextId === "string" ? update.contextId : undefined,
                        name: update.name,
                        filePath: update.filePath,
                        size: typeof update.size === "number" ? update.size : undefined,
                    };
                }
            } else if (kind === "artifact_updated") {
                if (typeof update.name === "string" && typeof update.filePath === "string") {
                    yield {
                        kind: "artifact_updated",
                        contextId: typeof update.contextId === "string" ? update.contextId : undefined,
                        name: update.name,
                        filePath: update.filePath,
                        size: typeof update.size === "number" ? update.size : undefined,
                    };
                }
            } else if (kind === "branch_overview") {
                if (typeof update.overview === "string" && update.overview.trim()) {
                    yield {
                        kind: "branch_overview",
                        overview: update.overview.trim(),
                    };
                }
            } else if (kind === "follow_ups") {
                const followUps = Array.isArray(update.followUps)
                    ? update.followUps.map((f: unknown) => String(f).trim()).filter(Boolean).slice(0, 3)
                    : [];
                if (followUps.length > 0) {
                    yield { kind: "follow_ups" as const, followUps };
                }
            } else if (kind === "permission_request") {
                // Incoming permission request from kiro-cli — forward to SSE
                // so the frontend can show an approval dialog.
                yield {
                    kind: "permission_request" as const,
                    requestId: update.requestId,
                    toolCallId: update.toolCall?.toolCallId,
                    title: update.toolCall?.title ?? "Tool call",
                    options: Array.isArray(update.options) ? update.options : [],
                };
            } else if (kind === "subagent_list_update") {
                yield {
                    kind: "subagent_list_update" as const,
                    subagents: (update.subagents ?? []).map((s: any) => ({
                        sessionId: String(s.sessionId ?? ""),
                        sessionName: String(s.sessionName ?? ""),
                        agentName: String(s.agentName ?? ""),
                        initialQuery: String(s.initialQuery ?? ""),
                        status: s.status?.type === "working" ? "working" as const : "terminated" as const,
                        statusMessage: s.status?.message ? String(s.status.message) : undefined,
                        group: String(s.group ?? ""),
                        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
                    })),
                };
            } else if (kind === "subagent_tool_activity") {
                yield {
                    kind: "subagent_tool_activity" as const,
                    subagentSessionId: String(update.subagentSessionId ?? ""),
                    title: String(update.title ?? ""),
                    status: String(update.status ?? ""),
                };
            } else if (kind === "context_usage") {
                const pct = Number(update.contextUsagePercentage);
                if (Number.isFinite(pct)) {
                    yield { kind: "context_usage" as const, contextUsagePercentage: pct };
                }
            } else if (kind === "usage_summary") {
                const pct = Number(update.contextUsagePercentage);
                const credits = (update.meteringUsage ?? []).reduce(
                    (sum: number, m: any) => sum + (Number(m.value) || 0), 0
                );
                const dur = Number(update.turnDurationMs);
                yield {
                    kind: "usage_summary" as const,
                    contextUsagePercentage: Number.isFinite(pct) ? pct : 0,
                    totalCredits: Number.isFinite(credits) ? credits : 0,
                    turnDurationMs: Number.isFinite(dur) ? dur : 0,
                };
            } else if (kind === "mcp_server_error") {
                yield {
                    kind: "mcp_server_error" as const,
                    serverName: String(update.serverName ?? ""),
                    error: String(update.error ?? ""),
                };
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
                    const held = completionStripper.flush();
                    if (held) yield { kind: "chunk", text: held };
                    yield { kind: "turn_end", stopReason: update.stopReason };
                    break;
                }
            }
        } catch (err) {
            const held = completionStripper.flush();
            if (held) yield { kind: "chunk", text: held };
            throw err;
        }
        const held = completionStripper.flush();
        if (held) yield { kind: "chunk", text: held };
    }

    async cancel(): Promise<void> {
        const c = this.runtime.getClient(this.cwd);
        await c?.cancel(this.nativeSessionId);
    }

    async setMode(modeId: string): Promise<void> {
        await this.runtime.setMode(this.nativeSessionId, modeId);
    }

    async setModel(modelId: string): Promise<void> {
        await this.runtime.setModel(this.nativeSessionId, modelId);
    }

    respondToPermission(requestId: number, optionId: string): void {
        this.runtime.respondToPermission(this.nativeSessionId, requestId, optionId);
    }

    cancelPermission(requestId: number): void {
        this.runtime.cancelPermission(this.nativeSessionId, requestId);
    }

    respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>): void {
        this.runtime.respondToUserInput(requestId, answers);
    }

    skipUserInput(requestId: number): void {
        this.runtime.skipUserInput(requestId);
    }
}
