import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type {
    RuntimeDescriptor,
    RuntimeRunFacet,
    RuntimeTitleSource,
    RuntimeToolDelivery,
} from '../../contract/descriptor';
import type { KiroEngine } from './kiroProtocol';

/** Kiro v2. On v3, compaction, fork and steering depend on what the clients negotiated. */
export const KIRO_HARNESS: CapabilityDescriptor = {
    steer: slot('native', 'native', '_session/steer; queued for the next agent boundary'),
    followUp: invisibleSlot(),
    interruptAck: slot('inferred', 'unknown', 'session/cancel notify — dispatch, not an agent ack'),
    // KiroSession.compact() now drives the ACP compact command, so this is a
    // real, invocable capability rather than "you can watch compaction happen".
    compact: slot('native', 'native', '_kiro.dev/commands/execute compact'),
    retry: invisibleSlot(),
    sessionFork: slot('native', 'native', 'Kiro rewind for compatible idle conversation parents'),
    nativeResume: slot('native', 'native', 'loadSession'),
    permissions: slot('native', 'native', 'acp_permission'),
    sandbox: invisibleSlot(),
    subagents: slot('experimental', 'unknown', '_session/terminate / subagent list'),
    usage: invisibleSlot(),
};

/**
 * Agent Runs use Kiro's own tools plus the session's MCP slot tools,
 * `_session/steer` queues input at the next agent boundary without
 * cancelling the prompt, and a persisted ACP session id resumes the session.
 */
export const KIRO_RUN: RuntimeRunFacet = {
    toolMode: 'runtime_default',
    steering: 'native',
    immediateSteering: 'next_turn',
    supportsNativeResume: true,
};

/** What a live ACP client negotiated, as far as the descriptor reads it. */
export interface KiroNegotiatedClient {
    supportsExtension(method: string): boolean;
    readonly capabilities?: { readonly sessionCapabilities?: { readonly fork?: object } };
}

/** Another ACP agent that speaks Kiro's protocol (Kiro Crew) adjusts the Kiro description. */
export interface KiroDescriptorOverride {
    /** Merged last over the computed harness. */
    harness?: Partial<CapabilityDescriptor>;
    /**
     * How Michi's per-session MCP definition reaches the agent. Default
     * `mcp-http`. Applies only to `mcpSlots: 'per-session'`: with no slots
     * there is nothing to deliver, and chat groups are Kiro's own v3 path.
     */
    toolDelivery?: Extract<RuntimeToolDelivery, 'mcp-http' | 'mcp-relay'>;
    /**
     * Replaces Kiro's title source (its sidecar, or none), and with it the
     * user opt-in Kiro's host-side titles need (hostTitleRequiresOptIn).
     */
    titles?: RuntimeTitleSource;
    /** `null`: no Agent Runs. Default {@link KIRO_RUN}. */
    run?: RuntimeRunFacet | null;
}

export interface KiroDescriptorInput {
    engine: KiroEngine;
    /** Every live client, including session workers'. Only v3 reads what they negotiated. */
    clients: readonly KiroNegotiatedClient[];
    /**
     * Michi's MCP slots: none without a slot registry; otherwise one per
     * session, or for local v3 chats one group per cwd (Agent Runs still get
     * their own slot on an isolated worker).
     */
    mcpSlots: 'none' | 'per-session' | 'chat-groups';
    /** A sidecar title generator exists. */
    sidecarTitles: boolean;
    override?: KiroDescriptorOverride;
}

export function kiroDescriptor(input: KiroDescriptorInput): RuntimeDescriptor {
    const { engine, clients, override } = input;
    const harness: CapabilityDescriptor = engine === 'v2' ? { ...KIRO_HARNESS, ...override?.harness } : {
        ...KIRO_HARNESS,
        compact: clients.length && clients.every((client) => client.supportsExtension('_kiro/session/compact'))
            ? slot('native', 'native', '_kiro/session/compact') : invisibleSlot('Kiro has not negotiated compaction'),
        sessionFork: clients.length && clients.every((client) => client.capabilities?.sessionCapabilities?.fork)
            ? slot('native', 'native', 'session/fork') : invisibleSlot('Kiro has not negotiated session/fork'),
        steer: clients.some((client) => !client.supportsExtension('_session/steer'))
            ? invisibleSlot('Kiro steering is unavailable') : KIRO_HARNESS.steer,
        ...override?.harness,
    };
    const toolDelivery: readonly RuntimeToolDelivery[] = input.mcpSlots === 'none' ? []
        : input.mcpSlots === 'chat-groups' ? ['mcp-http-grouped', 'mcp-http']
        : [override?.toolDelivery ?? 'mcp-http'];
    return {
        spec: 1,
        harness,
        topology: {
            // session/new returns the ACP session id.
            identityTiming: 'on-open',
            // session/cancel is a notification; a watchdog fences only the stuck session.
            cancel: 'inferred-keep-session',
            toolDelivery,
            historyReplay: 'preamble',
            // v3 wakes a chat's session when a workflow it launched finishes.
            backgroundTurns: engine === 'v3',
            titles: override?.titles ?? (input.sidecarTitles ? 'sidecar' : 'none'),
            // Kiro's host-side titles run on its sidecar session, which users turn on.
            ...(override?.titles === undefined ? { hostTitleRequiresOptIn: true as const } : {}),
            // v3 sessions open with Kiro workflows on for users who turned them on.
            ...(engine === 'v3' ? { workflowsRequireOptIn: true as const } : {}),
            // v2 clears in place; on v3 Michi answers /clear with a new native session (resetKiroContext).
            clearCreatesNewNativeSession: engine === 'v3',
        },
        run: override?.run === undefined ? KIRO_RUN : override.run,
    };
}

/** Without an instance (no engine, no clients): the v2 shape with Michi's tools and sidecar titles. */
export const KIRO_STATIC_DESCRIPTOR: RuntimeDescriptor = kiroDescriptor({
    engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: true,
});
