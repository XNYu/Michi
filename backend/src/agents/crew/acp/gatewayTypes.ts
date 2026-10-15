/**
 * Contract between the Crew ACP adapter's two halves:
 * - `gatewayClient.ts` implements {@link CrewGateway} over the Kiro Crew
 *   Gateway's HTTP/SSE API, authenticated as an installed Crew app.
 * - `acpServer.ts` speaks ACP to Michi and drives a {@link CrewGateway}.
 *
 * Error messages produced on either side must never contain "timed out",
 * "response stream", "connection reset" or "ECONNRESET": Michi classifies
 * those as process death and respawns the shared adapter process.
 */

export interface CrewGatewayConfig {
    /** Loopback base URL, e.g. http://127.0.0.1:5476. */
    baseUrl: string;
    /** Installed Crew app whose secret authenticates the adapter. */
    appName: string;
    /** Kiro Crew home; the secret lives at `<home>/apps/<appName>/.app_secret`. */
    kirocrewHome: string;
    /** Optional agent name for new slots; Gateway default when absent. */
    agent?: string;
    /** Per-request timeout for non-streaming calls. */
    requestTimeoutMs?: number;
}

export interface CrewModel {
    modelId: string;
    name: string;
    description?: string;
}

export type { CrewMemoryMode } from 'michi-shared';
import type { CrewMemoryMode } from 'michi-shared';

export interface CreateSlotInput {
    /** Slot name; also the ACP session id. */
    name: string;
    agent?: string;
    agent_kind?: 'template';
    model?: string;
    /** Controls learned memory, not transcript persistence. Set only at birth. */
    memory_mode?: CrewMemoryMode;
}

export interface CrewAgent { id: string; name: string; description?: string }
export interface CrewHistoryRow extends CrewChatFrame { role: string }
export interface CrewSlotDetail extends CrewSlotInfo {
    messages: CrewHistoryRow[];
    running?: boolean;
    total?: number;
    has_more?: boolean;
    next_before?: number;
}
export interface CrewEvent { type: string; data: Record<string, unknown> }
export interface CrewPendingApproval {
    request_id: string;
    request_mid: string;
    tool: string;
    /** Stable provider identity, distinct from the human-readable tool title. */
    tool_name?: string;
    input?: string;
    tool_call_id?: string;
}

export interface CrewSlotInfo {
    /** Gateway slot key used in every slot-scoped path. */
    key: string;
    [field: string]: unknown;
}

/** One `data:` frame of `POST /api/chat`. `type` is the transcript row role. */
export interface CrewChatFrame {
    type: string;
    content?: unknown;
    ts?: string;
    cls?: unknown;
    meta?: Record<string, unknown>;
}

export type CrewChatEvent =
    | { kind: 'frame'; frame: CrewChatFrame }
    /** The Gateway answered JSON instead of SSE, e.g. `{ok, queued, queue_id}` for a busy slot. */
    | { kind: 'receipt'; receipt: Record<string, unknown> };

export interface CrewGateway {
    approvalsAvailable?(): Promise<boolean>;
    prepareApprovals?(slot: string): Promise<void>;
    pendingApprovals?(slot: string): Promise<CrewPendingApproval[]>;
    approve?(slot: string, request: CrewPendingApproval, allow: boolean, signal?: AbortSignal): Promise<void>;
    /** Optional only for older adapters/test doubles. Production implements these. */
    getSlot?(slot: string, limit?: number, before?: number): Promise<CrewSlotDetail>;
    listSlots?(): Promise<CrewSlotInfo[]>;
    listAgents?(slot?: string): Promise<CrewAgent[]>;
    setAgent?(slot: string, agent: string): Promise<void>;
    forkSlot?(slot: string, messageId: string): Promise<CrewSlotInfo>;
    watchSlot?(slot: string, receive: (event: CrewEvent) => void): Promise<() => void>;
    close?(): void;
    createSlot(input: CreateSlotInput): Promise<CrewSlotInfo>;
    /** False on 404 (missing or owned by someone else). */
    slotExists(slot: string): Promise<boolean>;
    setProject(slot: string, project: string): Promise<void>;
    setModel(slot: string, model: string): Promise<void>;
    setReasoningEffort(slot: string, effort: string): Promise<void>;
    stop(slot: string): Promise<void>;
    /** Poll until the slot is no longer running; return quietly when `signal` aborts. */
    waitUntilIdle(slot: string, signal: AbortSignal): Promise<void>;
    /** Delete a slot this app owns (404 for anyone else's). Michi never abandons explicitly, so only tools call this. */
    deleteSlot(slot: string): Promise<void>;
    listModels(): Promise<CrewModel[]>;
    /**
     * Send one turn. Yields frames until `[DONE]`, then completes. Yields a
     * single receipt and completes when the Gateway answers JSON. Throws
     * {@link CrewGatewayError} on a non-2xx answer or when the stream closes
     * before `[DONE]`. Aborting `signal` ends iteration without throwing.
     */
    streamChat(slot: string, message: string, signal: AbortSignal): AsyncIterable<CrewChatEvent>;
}

export class CrewGatewayError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly code?: string,
    ) {
        super(message);
        this.name = 'CrewGatewayError';
    }
}
