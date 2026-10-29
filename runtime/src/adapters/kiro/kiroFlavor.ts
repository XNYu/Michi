import type { KiroForkAnchor, PreambleInput, RuntimeHost, RuntimePortName, TurnSuffixInput } from '../../contract/host';
import type { AcpClient, AcpUpdate } from './acpClient';
import type { NormalizedEvent } from '../../contract/events';
import type { CancelAck, NewAgentSessionOptions } from '../../contract/types';

// How an ACP agent that speaks Kiro's protocol differs from kiro-cli.
// KiroRuntime and KiroSession read these differences, never the runtime id,
// so the Kiro adapter and a preset built on it (Kiro Crew, adapters/crew/) can
// move separately. KIRO_FLAVOR is kiro-cli itself.

export interface KiroFlavor {
    /** Host ports the flavor reads besides Kiro's own, asserted when the runtime is built. */
    readonly hostPorts: readonly RuntimePortName[];
    /** How the host's text reaches the agent. */
    readonly prompt: {
        /** The text before a new chat's first message. */
        firstMessage(host: RuntimeHost, input: PreambleInput): string;
        /** How the agent reports turn metadata. */
        readonly metadataChannel: TurnSuffixInput['metadataChannel'];
    };
    /** The events a `session_info_update` from the agent becomes. */
    sessionInfoEvents(update: AcpUpdate): NormalizedEvent[];
    /** What the agent's native sessions hold, and where a chat forks from one. */
    readonly nativeSessions: {
        /**
         * A native session that is gone can be replaced by a fresh one fed the
         * host's history: session/load and fork then report
         * NativeResumeUnavailableError. When false the agent's own error
         * stands, because the session held what the host cannot rebuild.
         */
        readonly replaceable: boolean;
        /**
         * The fork point a completed chat turn leaves. Absent: kiro-cli's,
         * the last user message on v3 and the newest rewind log index on v2.
         */
        forkAnchor?(client: AcpClient, sid: string): Promise<KiroForkAnchor>;
    };
    /**
     * Local v3 chats may share one MCP catalog whose calls name their session
     * (session anchors). Otherwise every session has its own MCP slot.
     */
    readonly sessionAnchors: boolean;
    /** Memory the agent keeps per chat. Absent: none. */
    readonly memory?: KiroSessionMemory;
    /**
     * How the agent acknowledges a prompt cancel; the session reports a
     * native ack only from this. Absent: a cancel is only dispatched
     * (inferred). See KiroCancelAck.
     */
    readonly cancelAck?: KiroCancelAck;
    /**
     * The agent reports native metering at turn end (credits and context
     * usage), forwarded as usage_summary. Absent: usage is not described.
     */
    readonly metersUsage?: boolean;
    /**
     * session/new metadata besides memory's, read once the session's agent
     * process is ready. Absent or undefined: none.
     */
    sessionMetadata?(host: RuntimeHost, opts: NewAgentSessionOptions): Record<string, unknown> | undefined;
}

/**
 * Where an agent's acknowledgement of a prompt cancel comes from.
 *
 * - `prompt-settlement`: the pending `session/prompt` settles with stopReason
 *   "cancelled" within the cancel deadline (kiro-cli 2.35.1, 0-30 ms on both
 *   engines).
 * - `agent-record`: a record the agent keeps of the stop, read after the
 *   cancel is dispatched (Kiro Crew's Gateway `stop_event`). `confirm`
 *   returns undefined when no record came; the dispatch then stands as an
 *   inferred ack.
 *
 * Either way the session holds the cancelled turn's end until the ack
 * settles, so the host hears the ack first.
 */
export type KiroCancelAck =
    | { readonly kind: 'prompt-settlement' }
    | { readonly kind: 'agent-record'; confirm(client: AcpClient, sid: string): Promise<CancelAck | undefined> };

/**
 * Two session/new metadata objects as one. A namespace both name, such as
 * `crew`, keeps the fields of both; on a clash `b` wins.
 */
export function joinSessionMetadata(
    a: Record<string, unknown> | undefined,
    b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (!a || !b) return a ?? b;
    const joined: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) {
        const prior = joined[key];
        joined[key] = isPlainObject(prior) && isPlainObject(value) ? { ...prior, ...value } : value;
    }
    return joined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Memory an agent keeps per chat, chosen when the chat's session opens. */
export interface KiroSessionMemory {
    /**
     * The memory a new session opens with, read once its agent process is
     * ready. Undefined: the session opens without any.
     */
    forNewSession(host: RuntimeHost, opts: NewAgentSessionOptions): KiroNewSessionMemory | undefined;
    /** Keeps for the chat the memory its loaded session reports (session/load `_meta`). */
    keepLoaded(host: RuntimeHost, nodeId: string, meta: Record<string, unknown> | undefined): void;
}

/** The memory a new session opens with. */
export interface KiroNewSessionMemory {
    /** session/new metadata naming it. */
    readonly metadata: Record<string, unknown>;
    /** Keeps it for the chat once the session is bound. */
    keep(nodeId: string): void;
}

/**
 * kiro-cli: the host's whole preamble, metadata through the host's tools, no
 * session info events; a lost native session is rebuilt from the host's
 * history, local v3 chats share an MCP catalog, and the agent keeps no
 * per-chat memory. Both engines settle a cancelled prompt with stopReason
 * "cancelled" and report credits and context usage (kiro-cli 2.35.1,
 * docs/kiro-acp-validation.md).
 */
export const KIRO_FLAVOR: KiroFlavor = {
    hostPorts: [],
    prompt: {
        firstMessage: (host, input) => host.prompt.preamble(input),
        metadataChannel: 'tools',
    },
    sessionInfoEvents: () => [],
    nativeSessions: { replaceable: true },
    sessionAnchors: true,
    cancelAck: { kind: 'prompt-settlement' },
    metersUsage: true,
};
