import { CrewMcpBindings } from '../crewMcpBinding';
import { MICHI_CREW_AGENT_TEMPLATE } from '../crewPrompt';
/**
 * Crew ACP stdio server: speaks ACP (NDJSON JSON-RPC 2.0) to Michi and drives
 * a Kiro Crew Gateway through {@link CrewGateway}. One process serves every
 * session Michi opens on a cwd. Nothing but JSON-RPC is written to `output`.
 */

import { randomBytes } from 'crypto';
import { watchCrewApprovals } from './crewApprovalBridge';
import { isCrewMemoryMode } from 'michi-shared';
import { StringDecoder } from 'string_decoder';
import type { CrewGateway, CrewModel, CrewAgent, CrewHistoryRow, CrewMemoryMode, CrewPendingApproval } from './gatewayTypes';
import { CrewTurn } from './crewTurn';
import {
    RECEIPT_NOTICE,
    errorMessage,
    messageNotice,
    sanitizeErrorMessage,
    translateFrame,
    type AcpUpdate,
} from './crewFrames';

export interface CrewAcpServerOptions {
    gateway: CrewGateway;
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    log?: (msg: string) => void;
    /** Model for sessions that never chose one; `"default"` leaves the slot on the Gateway default. */
    defaultModel?: string;
    /** Crew agent for new slots; Gateway default when absent. */
    agent?: string;
    /** Prefer this installed Michi template for new chats; never changes resumed identities. */
    preferredAgent?: string;
    /** New slots only. Resumed and forked slots retain their Gateway memory policy. */
    memoryMode?: CrewMemoryMode;
    newSessionId?: () => string;
    /** How long `session/cancel` waits for the Gateway to stop and become idle before answering the prompt. */
    cancelGraceMs?: number;
    /** After a failed model list, wait this long before asking the Gateway again. */
    modelRetryMs?: number;
    dashboardBaseUrl?: string;
}

export interface CrewAcpServer {
    /** Resolves after input ends or shutdown finishes. */
    closed: Promise<void>;
    shutdown(): Promise<void>;
}

const DEFAULT_MODEL_ID = 'default';
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const DEFAULT_MODEL_RETRY_MS = 60_000;

const ERR_INVALID_PARAMS = -32602;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;
const ERR_BUSY = -32000;

type RpcId = number | string;

class RpcError extends Error {
    constructor(readonly code: number, message: string, readonly data?: { code: string }) {
        super(message);
    }
}

interface Turn {
    controller: AbortController;
    cancelled: boolean;
    resolve: (result: unknown) => void;
    reject: (err: RpcError) => void;
    projection?: CrewTurn;
    releaseMcp?: () => Promise<void>;
    controlWork?: Promise<unknown>;
    completion?: Promise<unknown>;
    nativeStarted?: boolean;
    unsubscribe?: () => void;
}

interface CrewSession {
    cwd: string;
    memoryMode?: CrewMemoryMode;
    mcpServers?: unknown[];
    model?: string;
    effort?: string;
    agent?: string;
    template?: boolean;
    slotReady: boolean;
    slotCreated?: boolean;
    settingsBusy?: boolean;
    setup?: Promise<void>;
    turn?: Turn;
}

type Params = Record<string, unknown>;

const defaultLog = (msg: string): void => {
    process.stderr.write(`[kirocrew-acp] ${msg}\n`);
};

const defaultSessionId = (): string => `michi-${randomBytes(6).toString('hex')}`;

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireSessionId(params: Params): string {
    const sessionId = asString(params.sessionId);
    if (!sessionId) throw new RpcError(ERR_INVALID_PARAMS, 'sessionId is required');
    return sessionId;
}

/** Text blocks joined by newlines; other blocks become an omission marker. */
function promptMessage(prompt: unknown): string {
    if (!Array.isArray(prompt)) throw new RpcError(ERR_INVALID_PARAMS, 'prompt must be an array of content blocks');
    const parts = prompt.map((block) => {
        const b = (block ?? {}) as Params;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        return `[${asString(b.type) ?? 'unknown'} attachment omitted]`;
    });
    const message = parts.join('\n');
    if (!message.trim()) throw new RpcError(ERR_INVALID_PARAMS, 'prompt is empty');
    return message;
}

class CrewAcpServerImpl {
    private readonly gateway: CrewGateway;
    private readonly output: NodeJS.WritableStream;
    private readonly log: (msg: string) => void;
    private readonly defaultModel?: string;
    private readonly agent?: string;
    private readonly preferredAgent: string;
    private readonly memoryMode?: CrewMemoryMode;
    private readonly newSessionId: () => string;
    private readonly cancelGraceMs: number;
    private readonly modelRetryMs: number;
    private readonly sessions = new Map<string, CrewSession>();
    private modelsPromise?: Promise<CrewModel[]>;
    /** Set when the last model list failed; cleared on the next attempt. */
    private modelsFailedAt?: number;
    private readonly mcpBindings = new CrewMcpBindings();
    private toolSeq = 0;
    private permissionSeq = 1000000;
    private readonly permissionResponses = new Map<number, (result: unknown) => void>();
    private readonly dashboardBaseUrl?: string;
    private closing = false;

    constructor(opts: CrewAcpServerOptions) {
        this.gateway = opts.gateway;
        this.output = opts.output;
        this.log = opts.log ?? defaultLog;
        this.defaultModel = asString(opts.defaultModel);
        this.agent = asString(opts.agent);
        this.preferredAgent = opts.preferredAgent ?? MICHI_CREW_AGENT_TEMPLATE;
        this.memoryMode = opts.memoryMode;
        this.newSessionId = opts.newSessionId ?? defaultSessionId;
        this.cancelGraceMs = opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
        this.modelRetryMs = opts.modelRetryMs ?? DEFAULT_MODEL_RETRY_MS;
        this.dashboardBaseUrl = opts.dashboardBaseUrl;
    }

    // ---- transport -------------------------------------------------------

    handleLine(raw: string): void {
        if (this.closing) return;
        const line = raw.trim();
        if (!line) return;
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            this.log(`ignoring unparseable input line (${line.length} chars)`);
            return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            this.log('ignoring input line that is not a JSON-RPC object');
            return;
        }
        const m = msg as Params;
        if (typeof m.method !== 'string') {
            if (typeof m.id === 'number') this.permissionResponses.get(m.id)?.(m.result);
            return;
        }
        const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Params;
        const hasId = typeof m.id === 'number' || typeof m.id === 'string';
        if (hasId) void this.handleRequest(m.id as RpcId, m.method, params);
        else this.handleNotification(m.method, params);
    }

    /** The adapter owns the live turn and MCP lease, so stop it before exiting. */
    async shutdown(): Promise<void> {
        this.closing = true;
        const completions: Promise<unknown>[] = [];
        for (const [sessionId, session] of this.sessions) {
            if (!session.turn?.completion) continue;
            completions.push(session.turn.completion);
            // AcpClient escalates SIGTERM after five seconds. Leave room for
            // approval/MCP cleanup and process exit after the native stop.
            this.cancel({ sessionId }, Math.min(this.cancelGraceMs, 3_000));
        }
        await Promise.allSettled(completions);
        this.gateway.close?.();
        await this.mcpBindings.close().catch(() => this.log('Could not clean Crew MCP bindings'));
    }

    private write(msg: Params): void {
        if (!this.output.writable) return;
        try {
            this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
        } catch (err) {
            this.log(`failed to write to output: ${errorMessage(err)}`);
        }
    }

    private notifyUpdate(sessionId: string, update: AcpUpdate): void {
        this.write({ method: 'session/update', params: { sessionId, update } });
    }

    private async handleRequest(id: RpcId, method: string, params: Params): Promise<void> {
        try {
            const result = await this.dispatch(method, params);
            this.write({ id, result });
        } catch (err) {
            const rpc = err instanceof RpcError ? err : new RpcError(ERR_INTERNAL, `Crew: ${errorMessage(err)}`);
            if (!(err instanceof RpcError)) this.log(`${method} failed: ${errorMessage(err)}`);
            this.write({ id, error: { code: rpc.code, message: sanitizeErrorMessage(rpc.message), ...(rpc.data ? { data: rpc.data } : {}) } });
        }
    }

    private handleNotification(method: string, params: Params): void {
        if (method === 'session/cancel') this.cancel(params);
    }

    private dispatch(method: string, params: Params): Promise<unknown> {
        switch (method) {
            case 'initialize':
                return Promise.resolve(this.initialize());
            case 'session/new':
                return this.newSession(params);
            case 'session/load':
                return this.loadSession(params);
            case 'session/prompt':
                return this.prompt(params);
            case 'session/set_model':
                return this.setModel(params);
            case 'session/set_mode':
                return this.setMode(params);
            case 'session/fork':
                return this.fork(params);
            case '_kiro.dev/commands/execute':
                return this.executeCommand(params);
            case '_session/steer':
                return Promise.resolve({ queued: false });
            case '_session/steer/clear':
                return Promise.resolve({ cleared: true, messageIds: [] });
            default:
                return Promise.reject(new RpcError(ERR_METHOD_NOT_FOUND, `Method not found: ${method}`));
        }
    }

    // ---- lifecycle -------------------------------------------------------

    private initialize(): unknown {
        return {
            protocolVersion: 1,
            agentCapabilities: {
                loadSession: true,
                ...(this.gateway.forkSlot ? { sessionCapabilities: { fork: {} } } : {}),
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            agentInfo: { name: 'kirocrew-acp', version: '0.3.0' },
            authMethods: [],
        };
    }

    private mcpServers(params: Params): unknown[] {
        if (params.mcpServers === undefined) return [];
        if (!Array.isArray(params.mcpServers)) throw new RpcError(ERR_INVALID_PARAMS, 'mcpServers must be an array');
        return params.mcpServers;
    }

    private requestPermission(sessionId: string, approval: CrewPendingApproval, signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) return Promise.resolve(false);
        const id = ++this.permissionSeq;
        return new Promise((resolve) => {
            const done = (allow: boolean) => {
                this.permissionResponses.delete(id);
                signal.removeEventListener('abort', abort);
                resolve(allow);
            };
            const abort = () => {
                this.write({ method: '_michi/permission_resolved', params: { sessionId, requestId: id } });
                done(false);
            };
            signal.addEventListener('abort', abort, { once: true });
            this.permissionResponses.set(id, (result) => {
                const outcome = (result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
                done(outcome?.outcome === 'selected' && outcome.optionId === 'allow_once');
            });
            this.write({ id, method: 'session/request_permission', params: { sessionId,
                _meta: { toolName: approval.tool_name },
                toolCall: { toolCallId: approval.tool_call_id || approval.request_mid,
                    title: approval.tool, rawInput: approval.input ?? '',
                    content: [{ type: 'content', content: { type: 'text', text: approval.input ?? '' } }] },
                options: [
                    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
                    { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
                ],
            } });
        });
    }

    private mintSessionId(): string {
        for (;;) {
            const id = this.newSessionId();
            if (!this.sessions.has(id)) return id;
        }
    }

    private async newSession(params: Params): Promise<unknown> {
        const cwd = asString(params.cwd);
        if (!cwd) throw new RpcError(ERR_INVALID_PARAMS, 'cwd is required');
        const mcpServers = this.mcpServers(params);
        const sessionId = this.mintSessionId();
        const requestedMemory = (params._meta as { crew?: { memoryMode?: unknown } } | undefined)?.crew?.memoryMode;
        if (requestedMemory !== undefined && !isCrewMemoryMode(requestedMemory)) throw new RpcError(ERR_INVALID_PARAMS, 'Invalid Crew memory mode');
        const agents = await this.loadAgents();
        const agent = this.agent ?? agents.find(row => row.id === this.preferredAgent)?.id;
        if (!agent) this.log('Michi Agent template is unavailable; update the Michi Crew App to use concise system instructions. Using the Gateway default.');
        const session: CrewSession = { cwd, mcpServers, slotReady: false, agent,
            template: !!agent && agents.some(row => row.id === agent),
            memoryMode: requestedMemory ?? this.memoryMode ?? 'persistent' };
        this.sessions.set(sessionId, session);
        return { sessionId, models: await this.modelsBlock(session), modes: await this.modesBlock(session, undefined, agents), _meta: { crewMemoryMode: session.memoryMode } };
    }

    private async loadSession(params: Params): Promise<unknown> {
        const sessionId = requireSessionId(params);
        const mcpServers = this.mcpServers(params);
        const known = this.sessions.get(sessionId);
        if (known?.turn || known?.settingsBusy || known?.setup) throw new RpcError(ERR_BUSY, 'Crew session is busy');
        const session: CrewSession = { ...known, mcpServers, cwd: asString(params.cwd) ?? known?.cwd ?? '', slotReady: false, settingsBusy: true };
        this.sessions.set(sessionId, session);
        try {
            if (!await this.gateway.slotExists(sessionId)) {
                throw new RpcError(ERR_INVALID_PARAMS, `Crew session not found: ${sessionId}`, { code: 'crew_session_unavailable' });
            }
            if (this.gateway.listSlots) {
                const settings = (await this.gateway.listSlots()).find((slot) => slot.key === sessionId);
                if (!settings) throw new RpcError(ERR_INVALID_PARAMS, `Crew session not found: ${sessionId}`, { code: 'crew_session_unavailable' });
                session.model = asString(settings.model) ?? DEFAULT_MODEL_ID;
                session.effort = asString(settings.reasoning_effort);
                session.agent = asString(settings.agent);
                session.template = settings.agent_kind === 'template';
                session.memoryMode = isCrewMemoryMode(settings.memory_mode) ? settings.memory_mode : undefined;
            }
            const result = { models: await this.modelsBlock(session), modes: await this.modesBlock(session, sessionId), _meta: { crewMemoryMode: session.memoryMode } };
            session.slotReady = true;
            return result;
        } catch (error) {
            if (known) this.sessions.set(sessionId, known);
            else this.sessions.delete(sessionId);
            throw error;
        } finally { session.settingsBusy = false; }
    }

    private loadAgents(slot?: string): Promise<CrewAgent[]> {
        return (this.gateway.listAgents?.(slot) ?? Promise.resolve([])).catch((error) => {
            this.log(`Crew template catalog unavailable: ${errorMessage(error)}`);
            return [];
        });
    }

    private async modesBlock(session: CrewSession, slot?: string, catalog?: CrewAgent[]): Promise<unknown> {
        const agents = catalog ?? await this.loadAgents(slot);
        const currentModeId = session.template && session.agent ? `template:${session.agent}` : 'current';
        return { currentModeId, availableModes: [
            // `current` is a state, not a selectable reset operation. A global mode
            // picker can outlive this session's template switch.
            ...(session.template && session.agent && !agents.some((agent) => agent.id === session.agent)
                ? [{ id: currentModeId, name: `Template: ${session.agent}`, description: 'Current template; catalog unavailable.' }] : []),
            ...agents.map((agent) => ({ id: `template:${agent.id}`, name: `Template: ${agent.name}`,
                description: agent.description || 'Changes the Crew agent template when idle. Pinned member identities cannot switch.' })),
        ] };
    }

    private async setMode(params: Params): Promise<unknown> {
        const sessionId = requireSessionId(params);
        const session = this.sessions.get(sessionId);
        const mode = asString(params.modeId);
        if (!session || !mode) throw new RpcError(ERR_INVALID_PARAMS, 'Unknown session or missing agent template');
        if (session.turn || session.settingsBusy || session.setup) throw new RpcError(ERR_BUSY, 'Crew session is busy');
        if (mode === 'current' && !session.template) return {};
        session.settingsBusy = true;
        try {
            const agent = (await this.loadAgents(session.slotReady ? sessionId : undefined)).find((row) => `template:${row.id}` === mode);
            if (!agent || !this.gateway.setAgent) throw new RpcError(ERR_INVALID_PARAMS, 'Unknown or unavailable Crew template');
            if (session.slotReady || session.slotCreated) await this.gateway.setAgent(sessionId, agent.id);
            session.agent = agent.id;
            session.template = true;
            this.notifyUpdate(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode });
            return {};
        } finally { session.settingsBusy = false; }
    }

    private async forkRows(sessionId: string): Promise<Array<{ logIndex: number; messageId: string; label: string }>> {
        if (!this.gateway.getSlot) throw new RpcError(ERR_METHOD_NOT_FOUND, 'Crew history is unavailable');
        const detail = await this.gateway.getSlot(sessionId);
        if (detail.running) throw new RpcError(ERR_BUSY, 'Cannot fork a running Crew session');
        const offset = detail.next_before ?? Math.max(0, (detail.total ?? detail.messages.length) - detail.messages.length);
        return detail.messages.flatMap((row: CrewHistoryRow, index) => {
            const mid = asString(row.meta?.mid);
            return row.role === 'assistant' && mid
                ? [{ logIndex: offset + index, messageId: mid, label: 'Gateway transcript fork (context replay)' }] : [];
        }).reverse();
    }

    private async fork(params: Params): Promise<unknown> {
        const sessionId = requireSessionId(params);
        const session = this.sessions.get(sessionId);
        if (!session || !session.slotReady || !this.gateway.forkSlot) throw new RpcError(ERR_INVALID_PARAMS, 'Crew parent session unavailable');
        if (session.turn || session.settingsBusy || session.setup) throw new RpcError(ERR_BUSY, 'Crew session is busy');
        const requested = asString((params._meta as any)?.kiro?.messageId);
        session.settingsBusy = true;
        try {
            const points = await this.forkRows(sessionId);
            // Send a server-minted stable message id, never a stale positional index.
            const messageId = requested ?? points[0]?.messageId;
            if (!messageId) throw new RpcError(ERR_INVALID_PARAMS, 'No completed Crew message to fork');
            const child = await this.gateway.forkSlot(sessionId, messageId);
            this.sessions.set(child.key, { ...session, turn: undefined, mcpServers: [], slotReady: true, settingsBusy: false });
            return { sessionId: child.key };
        } finally { session.settingsBusy = false; }
    }

    /**
     * Fetched once and cached. A failure is cached only for `modelRetryMs`, so
     * a Gateway that was restarting when the adapter booted does not leave the
     * picker on "Crew default" for the whole process lifetime.
     */
    private loadModels(): Promise<CrewModel[]> {
        const failedAt = this.modelsFailedAt;
        const retryDue = failedAt !== undefined && Date.now() - failedAt >= this.modelRetryMs;
        if (this.modelsPromise && !retryDue) return this.modelsPromise;
        this.modelsFailedAt = undefined;
        this.modelsPromise = this.gateway.listModels().then(
            (models) => (Array.isArray(models) ? models : []),
            (err) => {
                this.log(`could not list Crew models: ${errorMessage(err)}`);
                this.modelsFailedAt = Date.now();
                return [];
            },
        );
        return this.modelsPromise;
    }

    private async modelsBlock(session: CrewSession): Promise<unknown> {
        const models = await this.loadModels();
        const availableModels = [
            { modelId: DEFAULT_MODEL_ID, name: 'Crew default' },
            ...models
                .filter((m) => asString(m?.modelId) && m.modelId !== DEFAULT_MODEL_ID)
                .map((m) => ({
                    modelId: m.modelId,
                    name: asString(m.name) ?? m.modelId,
                    ...(asString(m.description) ? { description: m.description } : {}),
                })),
        ];
        return { currentModelId: this.effectiveModel(session), availableModels };
    }

    private effectiveModel(session: CrewSession): string {
        return session.model ?? this.defaultModel ?? DEFAULT_MODEL_ID;
    }

    private async ensureSlot(sessionId: string, session: CrewSession): Promise<void> {
        if (session.slotReady) return;
        if (!session.setup) session.setup = this.configureSlot(sessionId, session).finally(() => { session.setup = undefined; });
        await session.setup;
    }

    private async configureSlot(sessionId: string, session: CrewSession): Promise<void> {
        const model = this.effectiveModel(session);
        if (!session.slotCreated) try {
            await this.gateway.createSlot({
                name: sessionId,
                ...(session.agent ? { agent: session.agent } : {}),
                ...(session.template ? { agent_kind: 'template' as const } : {}),
                ...(model !== DEFAULT_MODEL_ID ? { model } : {}),
                ...(session.memoryMode ? { memory_mode: session.memoryMode } : {}),
            });
            session.slotCreated = true;
        } catch (err) {
            throw new RpcError(ERR_INTERNAL, `Crew: could not create session ${sessionId}: ${errorMessage(err)}`);
        }
        await this.gateway.setProject(sessionId, session.cwd);
        const effort = session.effort;
        if (effort) {
            await this.gateway.setReasoningEffort(sessionId, effort);
        }
        session.slotReady = true;
    }

    // ---- turns -----------------------------------------------------------

    private prompt(params: Params): Promise<unknown> {
        const sessionId = requireSessionId(params);
        const session = this.sessions.get(sessionId);
        if (!session) throw new RpcError(ERR_INVALID_PARAMS, `Unknown session: ${sessionId}`);
        if (session.turn || session.settingsBusy) throw new RpcError(ERR_BUSY, 'Crew session is busy');
        const message = promptMessage(params.prompt);

        let resolve!: (result: unknown) => void;
        let reject!: (err: RpcError) => void;
        const settled = new Promise<unknown>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const turn: Turn = { controller: new AbortController(), cancelled: false, resolve, reject };
        session.turn = turn;

        this.runTurn(sessionId, session, message, turn)
            .finally(() => turn.releaseMcp?.().catch(() => this.log('Could not clean Crew MCP binding'))).then(
            () => {
                if (!turn.cancelled) turn.resolve({ stopReason: 'end_turn' });
            },
            (err: unknown) => {
                if (turn.cancelled) return;
                const rpc = err instanceof RpcError ? err : new RpcError(ERR_INTERNAL, `Crew: ${errorMessage(err)}`);
                this.log(`prompt on ${sessionId} failed: ${errorMessage(err)}`);
                turn.reject(rpc);
            },
        );
        turn.completion = settled.finally(() => {
            if (session.turn === turn) session.turn = undefined;
        });
        return turn.completion;
    }

    private async runTurn(sessionId: string, session: CrewSession, message: string, turn: Turn): Promise<void> {
        await this.ensureSlot(sessionId, session);
        if (turn.cancelled) return;
        // A previous adapter may have died while the durable Gateway turn
        // survived. Do not reset its Trust, borrow its MCP identity or silently
        // enqueue a new prompt that Michi cannot observe.
        if (await this.gateway.getSlot?.(sessionId, 1).then(slot => slot.running === true)) {
            throw new RpcError(ERR_BUSY, 'This Crew session still has a running task. Finish or stop it in Kiro Crew before retrying.');
        }
        if (turn.cancelled) return;
        turn.releaseMcp = await (turn.controlWork = this.mcpBindings.bind(sessionId, session.mcpServers ?? []));
        if (turn.cancelled) return;
        const prepareIntegration = async () => {
            const available = await this.gateway.approvalsAvailable?.() === true;
            if (!available) throw new RpcError(ERR_INTERNAL, 'Crew setup incomplete: complete sessionApproval consent for the Michi App in Crew Apps and confirm Enabled. Approvals must be handled in Michi.');
            if (await this.gateway.mcpAvailable?.() !== true) throw new RpcError(ERR_INTERNAL, 'Crew setup incomplete: update the prepared Michi App, enable and approve Michi MCP Stub / Routed in Crew Developer > MCP Management, then restart the Gateway.');
            if (!turn.cancelled) await this.gateway.prepareApprovals?.(sessionId);
        };
        await (turn.controlWork = prepareIntegration());
        if (turn.cancelled) return;
        const projection = new CrewTurn(sessionId, this.gateway, (update) => this.notifyUpdate(sessionId, update), () => `${++this.toolSeq}`);
        turn.projection = projection;
        turn.unsubscribe = await this.gateway.watchSlot?.(sessionId, (event) => projection.event(event));
        if (turn.cancelled) { turn.unsubscribe?.(); return; }
        const approvalController = new AbortController();
        const abortApprovals = () => approvalController.abort();
        turn.controller.signal.addEventListener('abort', abortApprovals, { once: true });
        const approvals = watchCrewApprovals({ gateway: this.gateway, sessionId,
            signal: approvalController.signal,
            request: (approval, signal) => this.requestPermission(sessionId, approval, signal),
            report: (error) => {
                this.log(`Crew approval bridge: ${errorMessage(error)}`);
                this.notifyUpdate(sessionId, messageNotice(`\nCrew approval could not be completed: ${sanitizeErrorMessage(errorMessage(error))}\n`));
            },
        });
        turn.controlWork = approvals;
        let failed = true;
        let streamError = false;
        try {
            turn.nativeStarted = true;
            const events = this.gateway.streamChat(sessionId, message, turn.controller.signal);
            for await (const event of events) {
                if (turn.cancelled) break;
                if (event.kind === 'frame' && event.frame.type === 'permission') continue;
                if (event.kind === 'frame' && event.frame.type === 'error') streamError = true;
                if (event.kind === 'frame' && event.frame.type === 'tool') {
                    await projection.tool(event.frame);
                    continue;
                }
                const update = event.kind === 'receipt' ? messageNotice(RECEIPT_NOTICE)
                    : translateFrame(event.frame,
                        this.dashboardBaseUrl ? `${this.dashboardBaseUrl}/chat/${encodeURIComponent(sessionId)}?sid=${encodeURIComponent(sessionId)}` : undefined);
                if (update) this.notifyUpdate(sessionId, update);
            }
            failed = streamError;
        } finally {
            approvalController.abort();
            turn.controller.signal.removeEventListener('abort', abortApprovals);
            await approvals;
            turn.unsubscribe?.();
            await projection.finish(failed || turn.cancelled);
        }
    }

    private cancel(params: Params, graceMs = this.cancelGraceMs): void {
        const sessionId = asString(params.sessionId);
        const turn = sessionId ? this.sessions.get(sessionId)?.turn : undefined;
        if (!sessionId || !turn || turn.cancelled) return;
        turn.cancelled = true;
        void turn.releaseMcp?.().catch(() => this.log('Could not clean Crew MCP binding'));
        turn.controller.abort();
        turn.unsubscribe?.();
        void turn.projection?.finish(true);

        const drainController = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise<void>((res) => {
            timer = setTimeout(res, graceMs);
        });
        const stopped = Promise.resolve()
            .then(async () => {
                if (!turn.nativeStarted) return;
                await this.gateway.stop(sessionId);
                await this.gateway.waitUntilIdle(sessionId, drainController.signal);
            })
            .catch((err: unknown) => this.log(`could not stop Crew session ${sessionId}: ${errorMessage(err)}`));
        void Promise.race([stopped, grace]).then(async () => {
            drainController.abort();
            if (timer) clearTimeout(timer);
            // Stop/grace bounds stream draining, but a successor must never
            // overlap an approval mutation still being sent for this turn.
            await turn.controlWork?.catch(() => {});
            await turn.releaseMcp?.().catch(() => this.log('Could not clean Crew MCP binding'));
            turn.resolve({ stopReason: 'cancelled' });
        });
    }

    // ---- settings --------------------------------------------------------

    private async setModel(params: Params): Promise<unknown> {
        const sessionId = asString(params.sessionId);
        const modelId = asString(params.modelId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!sessionId || !session || !modelId) {
            throw new RpcError(ERR_INVALID_PARAMS, 'Unknown session or missing model');
        }
        if (session.turn || session.settingsBusy || session.setup) throw new RpcError(ERR_BUSY, 'Crew session is busy');
        session.settingsBusy = true;
        try {
            if (session.slotReady || session.slotCreated) await this.gateway.setModel(sessionId, modelId === DEFAULT_MODEL_ID ? '' : modelId);
            session.model = modelId;
            return {};
        } finally { session.settingsBusy = false; }
    }

    private async executeCommand(params: Params): Promise<unknown> {
        const command = (params.command ?? {}) as Params;
        const name = asString(command.command) ?? 'unknown';
        if (name === 'rewind' && this.gateway.forkSlot) {
            const sessionId = requireSessionId(params);
            const points = await this.forkRows(sessionId);
            const value = asString(((command.args ?? {}) as Params).value);
            if (value === undefined) return { success: true, data: { turns: points } };
            const point = points.find((row) => String(row.logIndex) === value);
            if (!point) return { success: false, message: 'Crew fork point is unavailable' };
            return { success: true, data: await this.fork({ sessionId, _meta: { kiro: { messageId: point.messageId } } }) };
        }
        if (name !== 'effort') return { success: false, message: `${name} is not supported by Kiro Crew` };

        const sessionId = asString(params.sessionId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const value = asString(((command.args ?? {}) as Params).value);
        if (!sessionId || !session) return { success: false, message: 'Unknown Kiro Crew session' };
        if (!value) return { success: false, message: 'effort needs a value' };
        if (session.turn || session.settingsBusy || session.setup) throw new RpcError(ERR_BUSY, 'Crew session is busy');
        session.settingsBusy = true;
        try {
            if (session.slotReady || session.slotCreated) {
                await this.gateway.setReasoningEffort(sessionId, value);
            }
            session.effort = value;
            return { success: true };
        } finally { session.settingsBusy = false; }
    }
}

export function runCrewAcpServer(opts: CrewAcpServerOptions): CrewAcpServer {
    const server = new CrewAcpServerImpl(opts);
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    const drain = (): void => {
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            server.handleLine(line);
        }
    };

    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
        let done = false;
        finish = (): void => {
            if (done) return;
            done = true;
            buffer += decoder.end();
            drain();
            if (buffer.trim()) server.handleLine(buffer);
            buffer = '';
            void server.shutdown().finally(resolve);
        };
        opts.input.on('data', (chunk: Buffer | string) => {
            buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
            drain();
        });
        opts.input.on('end', finish);
        opts.input.on('close', finish);
        opts.input.on('error', (err: Error) => {
            (opts.log ?? defaultLog)(`input error: ${errorMessage(err)}`);
            finish();
        });
    });

    return { closed, shutdown: () => { finish(); return closed; } };
}
