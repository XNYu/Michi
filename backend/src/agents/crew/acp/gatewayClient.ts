/**
 * {@link CrewGateway} over the Kiro Crew Gateway's HTTP/SSE API.
 *
 * Wire contract mirrors the official kirocrew-client-py: an installed Crew app
 * exchanges its on-disk `.app_secret` for an app-scoped token, which the
 * Gateway reads only from the `mc_token_<port>` cookie (never `?token=`). The
 * token is valid for an hour; it is re-exchanged at 50 minutes and once when a
 * request is refused as unauthenticated.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CrewEventStream } from './gatewayEvents';
import {
    CrewGatewayError,
    type CreateSlotInput,
    type CrewChatEvent,
    type CrewChatFrame,
    type CrewGateway,
    type CrewGatewayConfig,
    type CrewModel,
    type CrewSlotInfo,
    type CrewSlotDetail,
    type CrewAgent,
    type CrewEvent,
    type CrewPendingApproval,
} from './gatewayTypes';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const IDLE_POLL_INTERVAL_MS = 100;
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Michi treats these phrases as process death and respawns the adapter, so no
 * error this client raises may carry them, even when the Gateway's own text
 * does (e.g. `/api/models` answers 503 "model list timed out").
 */
const BANNED_PHRASES: ReadonlyArray<[RegExp, string]> = [
    [/timed\s*out/gi, 'took too long'],
    [/response stream/gi, 'reply stream'],
    [/connection reset/gi, 'connection dropped'],
    [/ECONNRESET/gi, 'connection dropped'],
];

export function neutralizeErrorText(text: string): string {
    return BANNED_PHRASES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function gatewayError(message: string, status?: number, code?: string): CrewGatewayError {
    return new CrewGatewayError(neutralizeErrorText(message), status, code);
}

export interface CrewGatewayClientDeps {
    /** Clock for token age; injectable for tests. */
    now?: () => number;
}

interface CachedToken {
    value: string;
    issuedAt: number;
}

type SignalFactory = () => AbortSignal;

export class CrewGatewayClient implements CrewGateway {
    readonly baseUrl: string;
    private readonly cookieName: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly events: CrewEventStream;
    private token: CachedToken | undefined;
    private exchanging: Promise<string> | undefined;
    private readonly timeoutSignal: SignalFactory = () => AbortSignal.timeout(this.timeoutMs);

    constructor(private readonly config: CrewGatewayConfig, deps: CrewGatewayClientDeps = {}) {
        const url = parseLoopbackUrl(config.baseUrl);
        if (!APP_NAME_RE.test(config.appName)) {
            throw gatewayError(`invalid Crew app name: ${JSON.stringify(config.appName)}`);
        }
        this.baseUrl = url.origin;
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        this.cookieName = `mc_token_${port}`;
        this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.now = deps.now ?? Date.now;
        this.events = new CrewEventStream({
            url: `${this.baseUrl.replace(/^http/, 'ws')}/api/ws`,
            cookie: async () => `${this.cookieName}=${await this.currentToken()}`,
            invalidate: () => { this.token = undefined; },
        });
    }

    watchSlot(slot: string, receive: (event: CrewEvent) => void): Promise<() => void> {
        return this.events.subscribe(slot, receive);
    }

    close(): void { this.events.close(); }

    async approvalsAvailable(): Promise<boolean> {
        // Live installed state, not a cached token's former authority.
        try {
            const dir = path.join(this.config.kirocrewHome, 'apps', this.config.appName);
            const manifest = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8'));
            const installed = JSON.parse(await fs.readFile(path.join(dir, 'installed.json'), 'utf8'));
            return manifest.permissions?.sessionApproval === true && installed.enabled === true
                && installed.sessionApprovalConsentPending !== true;
        } catch { return false; }
    }

    private async requireOwnSlot(slot: string): Promise<void> {
        if (!(await this.listSlots()).some((row) => row.key === slot)) {
            throw gatewayError('Crew session is not owned by the Michi App', 404);
        }
    }

    async prepareApprovals(slot: string): Promise<void> {
        await this.requireOwnSlot(slot);
        // Both Ask and Trust are resolved by Michi's ordinary permission broker.
        // Clear per-slot Crew Trust first; global Crew YOLO/agent allowlists remain
        // authoritative and are explicitly described in the UI.
        await this.json('POST', '/api/chat/mode', { slot, mode: 'normal' });
    }

    async pendingApprovals(slot: string): Promise<CrewPendingApproval[]> {
        const own = (await this.listSlots()).find((row) => row.key === slot);
        if (!own || own.pending_approval !== true) return [];
        const detail = await this.getSlot(slot, 500);
        if (!detail.running) return [];
        const pendingId = (own.pending_approval_info as { request_id?: string } | undefined)?.request_id;
        const cards = [...detail.messages].reverse().flatMap((row) => {
            if (row.role !== 'permission' || typeof row.cls !== 'string') return [];
            let data;
            try { data = JSON.parse(row.cls); } catch { return []; }
            if (!isRecord(data) || data.resolved || typeof data.request_id !== 'string'
                || data.request_id !== pendingId) return [];
            // Official permission rows carry ts + approval/tool IDs but, unlike
            // assistant rows, do not always receive meta.mid.
            const cardKey = typeof row.meta?.mid === 'string' ? row.meta.mid
                : typeof row.ts === 'string' && row.ts ? JSON.stringify([row.ts, data.request_id, data.tool_call_id ?? null]) : undefined;
            if (!cardKey) return [];
            return [{ request_id: data.request_id, request_mid: cardKey,
                tool: typeof data.tool_title === 'string' ? data.tool_title : String(row.content ?? 'Tool'),
                tool_name: nonEmpty(data.tool_name) ?? nonEmpty(row.meta?.tool_name),
                input: typeof data.tool_input === 'string' ? data.tool_input : '',
                tool_call_id: typeof data.tool_call_id === 'string' ? data.tool_call_id : undefined }];
        });
        const matchingIds = detail.messages.filter(row => {
            if (row.role !== 'permission' || typeof row.cls !== 'string') return false;
            try { return JSON.parse(row.cls).request_id === pendingId; } catch { return false; }
        });
        if (matchingIds.length > 1) throw gatewayError('Crew recycled an approval ID; complete this request in the Crew dashboard.');
        return cards.slice(0, 1);
    }

    async approve(slot: string, request: CrewPendingApproval, allow: boolean, signal?: AbortSignal): Promise<void> {
        // Official API accepts a native request ID, not an atomic turn token.
        // Recheck the exact transcript card. The official GET/POST pair is not
        // atomic; simultaneous dashboard control of this chat is unsupported.
        const current = await this.pendingApprovals(slot);
        if (signal?.aborted || !current.some((row) => row.request_id === request.request_id && row.request_mid === request.request_mid)) return;
        await this.json('POST', `${slotRoute(slot)}/approve`, {
            request_id: request.request_id, action: allow ? 'approved' : 'rejected',
        }, {}, () => signal ? AbortSignal.any([signal, this.timeoutSignal()]) : this.timeoutSignal());
    }

    async getSlot(slot: string, limit = 500, before?: number): Promise<CrewSlotDetail> {
        const result = await this.json('GET', `${slotRoute(slot)}?limit=${limit}${before === undefined ? '' : `&before=${before}`}`, undefined,
            {}, () => AbortSignal.timeout(Math.min(this.timeoutMs, 3000)));
        if (!isRecord(result) || !Array.isArray(result.messages)) throw gatewayError('Crew returned invalid session history');
        return result as unknown as CrewSlotDetail;
    }

    async listSlots(): Promise<CrewSlotInfo[]> {
        const result = await this.json('GET', '/api/chat/slots');
        if (!Array.isArray(result)) throw gatewayError('Crew returned invalid session settings');
        // Some Gateway versions return every slot's metadata here. Keep only
        // this App's records, even after the detail endpoint checked ownership.
        return result.filter((row) => isRecord(row) && typeof row.key === 'string' && row.app === this.config.appName
            && (!row.linked_session_key || row.linked_session_key === `dashboard:${row.key}`)
            && !row.instance_id && (!row.executor || row.executor === 'local'));
    }

    async listAgents(slot?: string): Promise<CrewAgent[]> {
        const result = await this.json('GET', '/api/agents/catalog', undefined, slot ? { 'X-Session-Key': `dashboard:${slot}` } : {});
        if (!isRecord(result) || !Array.isArray(result.agents)) throw gatewayError('Crew returned an invalid agent catalog');
        // A member is a pinned memory identity, not a switchable template.
        return result.agents.flatMap((row) => isRecord(row) && row.selection_kind === 'template' && typeof row.name === 'string'
            ? [{ id: row.name, name: row.name, ...(typeof row.description === 'string' ? { description: row.description } : {}) }] : []);
    }

    async setAgent(slot: string, agent: string): Promise<void> {
        await this.json('POST', `${slotRoute(slot)}/agent`, { agent, agent_kind: 'template' });
    }

    async forkSlot(slot: string, messageId: string): Promise<CrewSlotInfo> {
        const result = await this.json('POST', `${slotRoute(slot)}/fork`, { at_message_id: messageId, direction: 'head' });
        if (!isRecord(result) || typeof result.key !== 'string' || !result.key || result.key === slot) {
            throw gatewayError('Crew fork did not return an independent session');
        }
        return result as CrewSlotInfo;
    }

    async createSlot(input: CreateSlotInput): Promise<CrewSlotInfo> {
        const body: Record<string, string> = { name: input.name };
        const agent = input.agent ?? this.config.agent;
        if (agent !== undefined) body.agent = agent;
        if (input.agent_kind) body.agent_kind = input.agent_kind;
        if (input.model !== undefined) body.model = input.model;
        if (input.memory_mode) body.memory_mode = input.memory_mode;
        const result = await this.json('POST', '/api/chat/slots', body);
        if (!isRecord(result) || typeof result.key !== 'string' || !result.key) {
            throw gatewayError('Crew gateway created a slot without a key');
        }
        return result as CrewSlotInfo;
    }

    async slotExists(slot: string): Promise<boolean> {
        const route = `${slotRoute(slot)}?limit=1`;
        const res = await this.send('GET', route, undefined, this.timeoutSignal);
        const text = await readText(res, 'GET', route);
        if (res.ok) return true;
        if (res.status === 404) return false;
        throw httpError(res.status, text, 'GET', route);
    }

    async setProject(slot: string, project: string): Promise<void> {
        await this.json('POST', `${slotRoute(slot)}/project`, { project });
    }

    async setModel(slot: string, model: string): Promise<void> {
        await this.json('POST', `${slotRoute(slot)}/model`, { model });
    }

    async setReasoningEffort(slot: string, effort: string): Promise<void> {
        await this.json('POST', `${slotRoute(slot)}/reasoning-effort`, { reasoning_effort: effort });
    }

    async stop(slot: string): Promise<void> {
        await this.json('POST', `${slotRoute(slot)}/stop`);
    }

    async waitUntilIdle(slot: string, signal: AbortSignal): Promise<void> {
        const route = `${slotRoute(slot)}?limit=1`;
        while (!signal.aborted) {
            try {
                const res = await this.send('GET', route, undefined, () => signal);
                const text = await readText(res, 'GET', route);
                if (res.status === 404) return;
                if (!res.ok) throw httpError(res.status, text, 'GET', route);
                let detail: unknown;
                try {
                    detail = text.trim() ? JSON.parse(text) : {};
                } catch {
                    throw gatewayError(`Crew gateway answered GET ${slotRoute(slot)} with invalid JSON`, res.status);
                }
                if (!isRecord(detail) || detail.running !== true) return;
                await abortableDelay(IDLE_POLL_INTERVAL_MS, signal);
            } catch (error) {
                if (signal.aborted) return;
                throw error;
            }
        }
    }

    async deleteSlot(slot: string): Promise<void> {
        await this.json('DELETE', slotRoute(slot));
    }

    async listModels(): Promise<CrewModel[]> {
        const result = await this.json('GET', '/api/models');
        const items = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.models) ? result.models : [];
        return items.flatMap((item) => {
            const model = toCrewModel(item);
            return model ? [model] : [];
        });
    }

    async *streamChat(slot: string, message: string, signal: AbortSignal): AsyncGenerator<CrewChatEvent> {
        if (signal.aborted) return;
        let res: Response;
        try {
            res = await this.send('POST', '/api/chat', { message, slot }, () => signal);
        } catch (error) {
            if (signal.aborted) return;
            throw error;
        }
        if (!res.ok) {
            const text = await readText(res, 'POST', '/api/chat').catch(() => '');
            throw httpError(res.status, text, 'POST', '/api/chat');
        }
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (contentType === 'application/json') {
            const receipt = await readReceipt(res, signal);
            if (receipt) yield { kind: 'receipt', receipt };
            return;
        }
        if (contentType !== 'text/event-stream' || !res.body) {
            await res.body?.cancel().catch(() => undefined);
            throw gatewayError(`Crew chat answered an unexpected content type: ${contentType || 'missing'}`, res.status);
        }
        yield* readChatStream(res, signal);
    }

    /** A non-streaming call: one auth retry, timeout, JSON (or empty) body. */
    private async json(method: string, route: string, body?: unknown, headers: Record<string, string> = {}, signal = this.timeoutSignal): Promise<unknown> {
        const res = await this.send(method, route, body, signal, headers);
        const text = await readText(res, method, route);
        if (!res.ok) throw httpError(res.status, text, method, route);
        if (!text.trim()) return {};
        try {
            return JSON.parse(text);
        } catch {
            throw gatewayError(`Crew gateway answered ${method} ${route.split('?')[0]} with invalid JSON`, res.status);
        }
    }

    /**
     * One request with the cookie. A refusal as unauthenticated re-exchanges
     * the secret and replays exactly once; nothing has started on the Gateway
     * at that point, so the replay is safe even for `POST /api/chat`.
     */
    private async send(method: string, route: string, body: unknown, signal: SignalFactory, headers: Record<string, string> = {}): Promise<Response> {
        let token = await this.currentToken();
        for (let attempt = 0; ; attempt += 1) {
            const res = await this.fetchOnce(method, route, body, token, signal(), headers);
            if (attempt > 0 || !(await isAuthRefusal(res))) return res;
            await res.body?.cancel().catch(() => undefined);
            token = await this.refreshToken(token);
        }
    }

    private async fetchOnce(
        method: string,
        route: string,
        body: unknown,
        token: string,
        signal: AbortSignal,
        extraHeaders: Record<string, string> = {},
    ): Promise<Response> {
        const headers: Record<string, string> = { ...extraHeaders, Cookie: `${this.cookieName}=${token}` };
        if (method !== 'GET') headers['Content-Type'] = 'application/json';
        try {
            return await fetch(`${this.baseUrl}${route}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
            });
        } catch (error) {
            throw networkError(error, method, route, this.timeoutMs);
        }
    }

    private async currentToken(): Promise<string> {
        if (this.token && this.now() - this.token.issuedAt < TOKEN_MAX_AGE_MS) return this.token.value;
        return this.exchangeOnce();
    }

    /** Re-exchange unless another request already replaced the stale token. */
    private async refreshToken(stale: string): Promise<string> {
        if (this.token && this.token.value !== stale) return this.token.value;
        this.token = undefined;
        return this.exchangeOnce();
    }

    private exchangeOnce(): Promise<string> {
        if (!this.exchanging) {
            this.exchanging = this.exchange().finally(() => {
                this.exchanging = undefined;
            });
        }
        return this.exchanging;
    }

    private async exchange(): Promise<string> {
        const issuedAt = this.now();
        const secret = await this.readSecret();
        const route = `/api/apps/${encodeURIComponent(this.config.appName)}/token`;
        let res: Response;
        try {
            res = await fetch(`${this.baseUrl}${route}`, {
                method: 'POST',
                headers: { 'X-App-Secret': secret, 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (error) {
            throw networkError(error, 'POST', route, this.timeoutMs);
        }
        const text = await readText(res, 'POST', route);
        if (!res.ok) {
            const { message, code } = parseErrorBody(text);
            const detail = message ? `: ${message}` : '';
            throw gatewayError(
                `Crew app "${this.config.appName}" token exchange failed (HTTP ${res.status})${detail}; is the app enabled?`,
                res.status,
                code,
            );
        }
        const token = parseToken(text);
        if (!token) throw gatewayError('Crew app token exchange returned no token', res.status);
        this.token = { value: token, issuedAt };
        return token;
    }

    /** Read on every exchange so a reinstalled app's new secret is picked up. */
    private async readSecret(): Promise<string> {
        const { appName, kirocrewHome } = this.config;
        let secret = '';
        try {
            secret = (await fs.readFile(path.join(kirocrewHome, 'apps', appName, '.app_secret'), 'utf8')).trim();
        } catch {
            // Missing or unreadable: reported below without the path's contents.
        }
        if (!secret) {
            throw gatewayError(
                `Crew app "${appName}" is not installed: no app secret under ${path.join(kirocrewHome, 'apps', appName)}. `
                    + 'Install and enable the app in Kiro Crew first.',
            );
        }
        return secret;
    }
}

export function createCrewGateway(config: CrewGatewayConfig): CrewGateway {
    return new CrewGatewayClient(config);
}

function parseLoopbackUrl(baseUrl: string): URL {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw gatewayError(`invalid Crew gateway URL: ${JSON.stringify(baseUrl)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw gatewayError(`Crew gateway URL must be http or https: ${url.protocol}`);
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw gatewayError(`Crew gateway must be on loopback (127.0.0.1, localhost or ::1), got ${url.hostname}`);
    }
    return url;
}

function slotRoute(slot: string): string {
    return `/api/chat/slots/${encodeURIComponent(slot)}`;
}

/** 401, or a 403 the Gateway's auth layer marks as a credential problem. */
async function isAuthRefusal(res: Response): Promise<boolean> {
    if (res.status === 401) return true;
    if (res.status !== 403) return false;
    if ((res.headers.get('x-auth-required') ?? '').toLowerCase() === 'true') return true;
    const text = await res.clone().text().catch(() => '');
    return /token expired/i.test(parseErrorBody(text).message ?? '');
}

async function readText(res: Response, method: string, route: string): Promise<string> {
    try {
        return await res.text();
    } catch {
        throw gatewayError(`Crew gateway request failed while reading the ${method} ${route.split('?')[0]} answer`, res.status);
    }
}

/** The busy-slot JSON answer; undefined when the caller aborted while reading it. */
async function readReceipt(res: Response, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
        text = await readText(res, 'POST', '/api/chat');
    } catch (error) {
        if (signal.aborted) return undefined;
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw gatewayError('Crew chat answered invalid JSON', res.status);
    }
    return isRecord(value) ? value : { value };
}

async function* readChatStream(res: Response, signal: AbortSignal): AsyncGenerator<CrewChatEvent> {
    const body = res.body as unknown as AsyncIterable<Uint8Array> & { cancel(): Promise<void> };
    try {
        for await (const data of readSseData(body)) {
            if (data === '[DONE]') return;
            const frame = parseFrame(data);
            if (frame) yield { kind: 'frame', frame };
        }
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CrewGatewayError) throw error;
        throw gatewayError('Crew chat stream broke before [DONE]', res.status);
    } finally {
        // The Gateway may keep the connection open after [DONE].
        await body.cancel().catch(() => undefined);
    }
    if (signal.aborted) return;
    throw gatewayError('Crew chat stream closed before [DONE]', res.status);
}

/**
 * Yield each SSE event's data payload. Comment lines (`: keepalive`) and other
 * fields are skipped; multi-line data is joined with "\n"; lines may be split
 * across chunks.
 */
export async function* readSseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line === '') {
                if (data.length) yield data.join('\n');
                data = [];
            } else if (line.startsWith('data:')) {
                data.push(line.slice(5).replace(/^ /, ''));
            }
            newline = buffer.indexOf('\n');
        }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
    if (data.length) yield data.join('\n');
}

function parseFrame(data: string): CrewChatFrame | null {
    try {
        const parsed: unknown = JSON.parse(data);
        if (isRecord(parsed) && typeof parsed.type === 'string') return parsed as unknown as CrewChatFrame;
    } catch {
        // A garbled record is dropped, as the Gateway's own relay reader does.
    }
    return null;
}

/**
 * `GET /api/models` answers an array. Field names (kiro_crew
 * dashboard/handlers/agents.py `api_models`, `_cc_models`, `_codex_models`):
 * - `model_name`: the id `POST /api/chat/slots/{slot}/model` accepts (kiro-cli
 *   rows also carry `model_id`; the picker wire format is `model_name`).
 * - `display_name`: claude/codex rows only; kiro-cli rows have none.
 * - `description`: may be an empty string.
 */
function toCrewModel(item: unknown): CrewModel | null {
    if (!isRecord(item)) return null;
    const modelId = nonEmpty(item.model_name) ?? nonEmpty(item.model_id) ?? nonEmpty(item.modelId);
    if (!modelId) return null;
    const name = nonEmpty(item.display_name) ?? nonEmpty(item.name) ?? modelId;
    const description = nonEmpty(item.description);
    return description ? { modelId, name, description } : { modelId, name };
}

function parseToken(text: string): string | undefined {
    try {
        const body: unknown = JSON.parse(text);
        return isRecord(body) ? nonEmpty(body.token) : undefined;
    } catch {
        return undefined;
    }
}

function parseErrorBody(text: string): { message?: string; code?: string } {
    try {
        const body: unknown = JSON.parse(text);
        if (!isRecord(body)) return {};
        const error = isRecord(body.error) ? body.error.message : body.error;
        return { message: nonEmpty(error), code: nonEmpty(body.code) };
    } catch {
        return {};
    }
}

function httpError(status: number, text: string, method: string, route: string): CrewGatewayError {
    const { message, code } = parseErrorBody(text);
    const detail = message ? `: ${message}` : '';
    return gatewayError(`Crew gateway ${method} ${route.split('?')[0]} failed (HTTP ${status})${detail}`, status, code);
}

function networkError(error: unknown, method: string, route: string, timeoutMs: number): CrewGatewayError {
    const where = `${method} ${route.split('?')[0]}`;
    if (error instanceof CrewGatewayError) return error;
    if (isRecord(error) && error.name === 'TimeoutError') {
        return gatewayError(`Crew gateway request failed: no answer to ${where} within ${timeoutMs} ms`);
    }
    if (isRecord(error) && error.name === 'AbortError') {
        return gatewayError(`Crew gateway request cancelled: ${where}`);
    }
    const cause = isRecord(error) && isRecord(error.cause) ? error.cause.code : undefined;
    if (cause === 'ECONNREFUSED') {
        return gatewayError(`Crew gateway request failed: nothing is listening for ${where}; is Kiro Crew running?`);
    }
    return gatewayError(`Crew gateway request failed: network error on ${where}`);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}
function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
