import type { AgentSession, ChatMessage } from "../types";
import type { NormalizedEvent, PermissionOption } from "../../services/chatEvents";
import type { AgentToolBridge } from "../toolBridge";
import { getRuntimeDeps } from "../runtimeDeps";
import { getProviderInfo } from "./piProviders";
import { getModelAttemptIds, getUpstreamProviderId } from "./piProviders";
import { loadPiAi, loadPiAgentCore } from "./piAi";
import { buildPiTools } from "./piTools";
import { mapAgentEvent, type MapperContext } from "./eventMapper";
import type { MinimalAgentMessage } from "./historyAdapter";
import { makeTurnImageQuota, type TurnImageQuota } from "../tools/read";
import { resolvePolicy } from "../permissionPolicy";

export interface PiSessionDeps {
    bridge: AgentToolBridge;
    /** Preamble injected as system prompt. Built by PiRuntime. */
    preamble: string;
    cwd: string;
    enableFollowUps: boolean;
    parentChatId?: string;
    /** Workspace this session belongs to. Used by globalContext tools. */
    workspaceId: string | null;
    /**
     * Better-Auth user id of the chat owner. When set (cloud BYOK mode)
     * provider keys are looked up per-user. When null (local desktop /
     * Electron) the legacy env / disk store is used.
     */
    ownerUserId: string | null;
    /**
     * Prior messages from SQLite (rehydrate path). When non-empty:
     *   - Agent.initialState.messages is seeded with them
     *   - getHistory() reflects these messages so ancestor preamble stitching works
     */
    initialMessages?: MinimalAgentMessage[];
}

/**
 * AgentSession backed by pi-agent-core's Agent.
 *
 * The Agent owns the messages array, abort controller, tool dispatch, and
 * per-turn loop. We subscribe to its events, push translated NormalizedEvents
 * onto an internal queue, and yield from the queue inside send().
 *
     * The "MCP" tools (set_title / set_follow_ups / spawn_branches /
     * save_context / update_context) are wired through the AgentToolBridge by buildPiTools —
 * same business effects as the Kiro path.
 */
export class PiSession implements AgentSession {
    public readonly id: string;
    public readonly runtimeId = "pi";
    public parentChatId?: string;
    private readonly cwd: string;
    private readonly bridge: AgentToolBridge;
    private readonly preamble: string;
    private readonly enableFollowUps: boolean;
    private readonly workspaceId: string | null;
    /**
     * Better-Auth user id of the chat owner, or null on local /
     * Electron deployments. Threaded into getProviderApiKey() so cloud
     * BYOK users can resolve their own encrypted key.
     */
    private readonly ownerUserId: string | null;
    private readonly history: ChatMessage[] = [];
    /**
     * Mutable per-turn budget shared with the read tool. Built once and
     * reused across turns; usedBytes is reset to 0 at the start of every
     * runTurn so each user turn gets a fresh image quota.
     */
    private readonly imageQuota: TurnImageQuota = makeTurnImageQuota();
    /**
     * Absolute paths the agent has successfully read this session. write
     * blocks overwriting an existing file the agent has not read; edit
     * always requires a prior read. Set is session-scoped (not turn) — once
     * seen, subsequent edits in later turns are unblocked.
     */
    private readonly seenPaths: Set<string> = new Set();
    private agent: any | undefined;
    private destroyed = false;
    private pendingAssistantBuf: string[] | undefined;
    /**
     * Set at the start of every runTurn so beforeToolCall (which is wired
     * once when the Agent is built and lives across turns) can push
     * permission_request events into the active turn's event queue.
     * Cleared at turn end.
     */
    private activePush: ((ev: NormalizedEvent) => void) | undefined;
    /**
     * Outstanding permission requests keyed by requestId. Resolved by
     * respondToPermission/cancelPermission, rejected on session destroy
     * or 5-minute timeout.
     */
    private readonly pendingPermissions = new Map<
        number,
        { resolve: (optionId: string | null) => void; timer: NodeJS.Timeout }
    >();
    private nextRequestId = 1;

    constructor(id: string, deps: PiSessionDeps) {
        this.id = id;
        this.cwd = deps.cwd;
        this.bridge = deps.bridge;
        this.preamble = deps.preamble;
        this.enableFollowUps = deps.enableFollowUps;
        this.parentChatId = deps.parentChatId;
        this.workspaceId = deps.workspaceId;
        this.ownerUserId = deps.ownerUserId;

        // Seed history from SQLite-rehydrated messages (text-only).
        const seed = deps.initialMessages ?? [];
        for (const m of seed) {
            const text = m.content[0]?.text ?? "";
            if (!text) continue;
            this.history.push({ role: m.role, content: text });
        }
    }

    get currentModeId(): string | null {
        return null;
    }

    getHistory(): ChatMessage[] {
        return this.history;
    }

    getPendingAssistant(): string | undefined {
        return this.pendingAssistantBuf?.join("");
    }

    async *send(rawUserText: string): AsyncIterableIterator<NormalizedEvent> {
        if (this.destroyed) {
            yield { kind: "turn_end", stopReason: "error" };
            return;
        }

        this.history.push({ role: "user", content: rawUserText });

        const buf: string[] = [];
        this.pendingAssistantBuf = buf;

        try {
            for await (const ev of this.runTurn(rawUserText)) {
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

    private async *runTurn(rawText: string): AsyncIterableIterator<NormalizedEvent> {
        const ownerUserId = this.ownerUserId ?? undefined;
        const deps = getRuntimeDeps();
        const cfg = deps.agentConfig.getAgentConfig(ownerUserId);
        const provider = cfg.provider;
        const upstreamProvider = getUpstreamProviderId(provider);
        const requestedModel = deps.agentConfig.resolveModel(this.runtimeId, ownerUserId);
        const modelAttemptIds = getModelAttemptIds(provider, requestedModel);
        const apiKey = deps.providerKeys.getProviderApiKey(provider, ownerUserId);
        if (!apiKey) {
            const name = getProviderInfo(provider)?.name ?? provider;
            // Tailor the error so cloud users see "set your key in Settings"
            // rather than the desktop-flavored "API key not configured".
            const hint = this.ownerUserId
                ? `${name} API key not set for your account — add it in Settings.`
                : `${name} API key not configured`;
            throw new Error(hint);
        }

        const piMod: any = await loadPiAi();
        const piAgentCore: any = await loadPiAgentCore();
        const { Type } = piMod;
        const model = piMod.getModel(upstreamProvider, modelAttemptIds[0] ?? requestedModel);

        // Reset the per-turn image budget before each LLM-driven loop.
        this.imageQuota.usedBytes = 0;

        // Lazily build the Agent on the first turn (and reuse on subsequent turns).
        if (!this.agent) {
            const tools = buildPiTools({
                bridge: this.bridge,
                cwd: this.cwd,
                // parentChatId here is the parent OF the spawned children (= this session),
                // distinct from this.parentChatId which is *this* session's ancestor.
                parentChatId: this.id,
                workspaceId: this.workspaceId,
                enableFollowUps: this.enableFollowUps,
                imageQuota: this.imageQuota,
                seenPaths: this.seenPaths,
                Type,
                ownerUserId: this.ownerUserId,
                // Stable closure: tools are built once, but activePush is rebound
                // each turn. show_image routes its inline image through here.
                emitImage: (ev) => this.activePush?.(ev),
            });

            // Per-workspace Instructions panel feeds the system prompt directly
            // here. Pi has no warm pool, so we can apply it at session creation
            // without violating any pool-key invariants.
            const workspaceInstructions = this.workspaceId
                ? deps.historyStore.getWorkspaceInstructions(this.workspaceId)
                : null;
            const systemPrompt = [this.preamble, workspaceInstructions]
                .filter(Boolean)
                .join("\n\n");
            this.agent = new piAgentCore.Agent({
                initialState: {
                    systemPrompt,
                    model,
                    tools,
                    // pi thinkingLevel doesn't accept "max"; clamp to xhigh.
                    thinkingLevel: (() => {
                        const r = deps.agentConfig.resolveReasoning(this.runtimeId, ownerUserId);
                        if (r === "max") return "xhigh";
                        return r ?? "off";
                    })(),
                    messages: [],
                },
                streamFn: (_m: any, c: any, o: any) => streamSimpleWithFallback(
                    piMod,
                    upstreamProvider,
                    modelAttemptIds,
                    c,
                    { ...o, apiKey },
                ),
                beforeToolCall: async (
                    bcCtx: { toolCall: { name: string }; args: unknown },
                    signal?: AbortSignal,
                ): Promise<{ block: boolean; reason?: string } | undefined> => {
                    const policy = resolvePolicy(this.workspaceId, bcCtx.toolCall.name, bcCtx.args);
                    if (policy === "allow") return undefined;
                    if (policy === "deny") return { block: true, reason: "denied by policy" };
                    const decision = await this.requestPermission(bcCtx.toolCall.name, bcCtx.args, signal);
                    if (decision === "allow_always" && this.workspaceId) {
                        getRuntimeDeps().historyStore.grantPermission(this.workspaceId, bcCtx.toolCall.name);
                    }
                    if (decision === "reject_once" || decision === null) {
                        return { block: true, reason: "user denied" };
                    }
                    return undefined;
                },
            });

            // Seed prior history (rehydrate).
            const seedMessages = this.collectSeed();
            if (seedMessages.length > 0) {
                this.agent.state.messages = seedMessages;
            }
        }

        const ctx: MapperContext = {
            cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
            contextWindow: (model as any).contextWindow,
            runStartMs: Date.now(),
        };

        const queue: NormalizedEvent[] = [];
        let resolveNext: ((v: NormalizedEvent | null) => void) | undefined;
        let done = false;
        let terminated = false;

        const push = (ev: NormalizedEvent) => {
            if (resolveNext) {
                const r = resolveNext;
                resolveNext = undefined;
                r(ev);
            } else {
                queue.push(ev);
            }
        };
        this.activePush = push;
        const finish = () => {
            terminated = true;
            done = true;
            if (resolveNext) {
                const r = resolveNext;
                resolveNext = undefined;
                r(null);
            }
        };

        const unsubscribe = this.agent.subscribe((event: any) => {
            for (const out of mapAgentEvent(event, ctx)) {
                push(out);
            }
            if (event.type === "agent_end") {
                finish();
            }
        });

        // Kick off the prompt; don't await it here — yield events as they arrive.
        const promptPromise = this.agent.prompt(rawText).catch((err: unknown) => {
            // If agent_end already finished the turn, drop late rejections.
            if (terminated) return;
            // Provider/runtime threw before agent_end could fire. Surface as turn_end:error.
            const aborted = (err as any)?.name === "AbortError";
            push({ kind: "turn_end", stopReason: aborted ? undefined : "error" });
            finish();
        });

        try {
            while (true) {
                let ev: NormalizedEvent | null;
                if (queue.length > 0) {
                    ev = queue.shift()!;
                } else if (done) {
                    break;
                } else {
                    ev = await new Promise<NormalizedEvent | null>((r) => (resolveNext = r));
                }
                if (ev === null) break;
                yield ev;
                if (ev.kind === "turn_end") break;
                // Local tools complete in <1ms, so tool_execution_start and tool_execution_end
                // land in the same frame; this gap lets the frontend render the "pending" chip.
                if (ev.kind === "tool_call") await new Promise((r) => setTimeout(r, 16));
            }
        } finally {
            unsubscribe();
            await promptPromise;
            this.activePush = undefined;
        }
    }

    /**
     * Build a permission_request event, push it onto the active turn's
     * queue, and await the user's decision (or 5-min timeout). Returns
     * the chosen optionId or null on timeout/abort/cancel.
     *
     * Called from beforeToolCall when policy === "ask". Honors the
     * pi-agent-core abort signal so cancelling a turn unblocks the
     * blocked tool call.
     */
    private async requestPermission(
        toolName: string,
        args: unknown,
        signal: AbortSignal | undefined,
    ): Promise<string | null> {
        if (!this.activePush) return null;
        const requestId = this.nextRequestId++;
        const options: PermissionOption[] = [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always", name: "Allow always for this workspace", kind: "allow_always" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ];
        const title = formatPermissionTitle(toolName, args);

        return new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingPermissions.delete(requestId);
                resolve(null);
            }, 5 * 60 * 1000);
            this.pendingPermissions.set(requestId, { resolve, timer });

            signal?.addEventListener(
                "abort",
                () => {
                    const entry = this.pendingPermissions.get(requestId);
                    if (!entry) return;
                    clearTimeout(entry.timer);
                    this.pendingPermissions.delete(requestId);
                    resolve(null);
                },
                { once: true },
            );

            this.activePush!({
                kind: "permission_request",
                requestId,
                title,
                options,
            });
        });
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

    private collectSeed(): MinimalAgentMessage[] {
        // Reconstruct seed messages from this.history. The constructor already
        // primed history from initialMessages; on first turn we project that
        // history back into Agent message shape.
        const out: MinimalAgentMessage[] = [];
        for (const m of this.history) {
            if (m.role === "user") {
                out.push({
                    role: "user",
                    content: [{ type: "text", text: m.content }],
                    timestamp: Date.now(),
                });
            } else if (m.role === "assistant") {
                out.push({
                    role: "assistant",
                    content: [{ type: "text", text: m.content }],
                    api: "rehydrated",
                    provider: "rehydrated",
                    model: "rehydrated",
                    usage: {
                        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                    timestamp: Date.now(),
                });
            }
        }
        // Drop the most recent user entry — runTurn will add it via prompt(). Otherwise it
        // would appear twice.
        if (out.length > 0 && out[out.length - 1].role === "user") {
            out.pop();
        }
        return out;
    }

    cancel(): void {
        try {
            this.agent?.abort();
        } catch {
            /* ignore */
        }
    }

    destroy(): void {
        this.destroyed = true;
        this.cancel();
        for (const [, entry] of this.pendingPermissions) {
            clearTimeout(entry.timer);
            entry.resolve(null);
        }
        this.pendingPermissions.clear();
        this.agent = undefined;
    }
}

async function* streamSimpleWithFallback(
    piMod: any,
    upstreamProvider: string,
    modelIds: string[],
    context: any,
    options: any,
): AsyncIterableIterator<any> {
    const attempts = modelIds.length > 0 ? modelIds : [undefined];
    let lastErrorEvent: any;
    let lastThrown: unknown;

    for (let i = 0; i < attempts.length; i += 1) {
        const modelId = attempts[i];
        const model = modelId ? piMod.getModel(upstreamProvider, modelId) : undefined;
        let yieldedAny = false;
        try {
            for await (const ev of piMod.streamSimple(model, context, options)) {
                if (ev?.type === "error" && !yieldedAny && i < attempts.length - 1) {
                    lastErrorEvent = ev;
                    break;
                }
                yieldedAny = true;
                yield ev;
            }
            if (!lastErrorEvent || yieldedAny || i === attempts.length - 1) return;
            lastErrorEvent = undefined;
        } catch (err) {
            if (yieldedAny || i === attempts.length - 1) throw err;
            lastThrown = err;
        }
    }

    if (lastErrorEvent) {
        yield lastErrorEvent;
        return;
    }
    if (lastThrown) throw lastThrown;
}

/**
 * Build the permission banner title. Phrased as a question so the
 * frontend can render it verbatim without prefixing "Allow X to ...".
 * Each ask-class tool gets a tailored phrasing.
 */
function formatPermissionTitle(toolName: string, args: unknown): string {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const path = typeof a.path === "string" ? a.path : "";
    const command = typeof a.command === "string" ? a.command : "";
    const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

    switch (toolName) {
        case "write":
            return path ? `Write to ${truncate(path, 80)}?` : "Write a file?";
        case "edit":
            return path ? `Edit ${truncate(path, 80)}?` : "Edit a file?";
        case "bash":
            return command ? `Run: ${truncate(command, 100)}` : "Run a shell command?";
        default: {
            // Fallback for any future ask-class tool.
            const summary = path || command || "";
            return summary ? `${toolName}: ${truncate(summary, 80)}` : `Run ${toolName}?`;
        }
    }
}
