import type { KiroForkAnchor, PreambleInput, RuntimeHost, RuntimePortName, TurnSuffixInput } from '../../contract/host';
import type { AcpClient, AcpUpdate } from './acpClient';
import type { NormalizedEvent } from '../../contract/events';
import type { NewAgentSessionOptions } from '../../contract/types';

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
 * per-chat memory.
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
};
