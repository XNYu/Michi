import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type {
    RuntimeDescriptor,
    RuntimeRunFacet,
    RuntimeTitleSource,
    RuntimeToolDelivery,
} from '../../contract/descriptor';
import { KIRO_FLAVOR, type KiroFlavor } from './kiroFlavor';
import type { KiroEngine } from './kiroProtocol';

/**
 * kiro-cli v2. On v3, compaction, fork and steering depend on what the
 * clients negotiated. The cancel ack and usage slots follow the flavor
 * (KiroFlavor.cancelAck, metersUsage): an agent that confirms or meters
 * neither keeps them unconfirmed.
 */
export const KIRO_HARNESS: CapabilityDescriptor = {
    steer: slot('native', 'native', '_session/steer; queued for the next agent boundary'),
    followUp: invisibleSlot(),
    // kiro-cli 2.35.1 settles the pending session/prompt with stopReason
    // "cancelled" within ~30 ms of session/cancel on both engines.
    interruptAck: slot('native', 'native', 'session/cancel; the pending session/prompt settles with stopReason cancelled'),
    // KiroSession.compact() now drives the ACP compact command, so this is a
    // real, invocable capability rather than "you can watch compaction happen".
    compact: slot('native', 'native', '_kiro.dev/commands/execute compact'),
    retry: invisibleSlot(),
    sessionFork: slot('native', 'native', 'Kiro rewind for compatible idle conversation parents'),
    nativeResume: slot('native', 'native', 'loadSession'),
    permissions: slot('native', 'native', 'acp_permission'),
    // kiro-cli 2.35.1 reports no sandbox over ACP (docs/kiro-acp-validation.md).
    sandbox: invisibleSlot(),
    subagents: slot('experimental', 'unknown', 'Roster: v2 _kiro.dev/subagent/list_update, v3 delegation tool calls. Control (v2 _session/spawn, _kiro.dev/session/terminate): native_unwired'),
    usage: slot('native', 'native', 'Kiro metering: credits and context %, no token counts or cost'),
};

/** A cancel the agent does not confirm: Michi only knows it was dispatched. */
const UNCONFIRMED_CANCEL = slot('inferred', 'unknown', 'session/cancel notify — dispatch, not an agent ack');

/** A cancel confirmed by the agent's own record of the stop (an `agent-record` flavor). */
const RECORDED_CANCEL = slot('native', 'native', "session/cancel, then the agent's record of the stop; inferred when none arrives");

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
    /**
     * What the agent confirms on its own (cancel acknowledgement, metering).
     * Absent: neither, as for an ACP agent that only speaks Kiro's protocol.
     */
    flavor?: Pick<KiroFlavor, 'cancelAck' | 'metersUsage'>;
    override?: KiroDescriptorOverride;
}

export function kiroDescriptor(input: KiroDescriptorInput): RuntimeDescriptor {
    const { engine, clients, override } = input;
    const cancelAck = input.flavor?.cancelAck?.kind;
    // What the agent itself is known to report.
    const agent: Partial<CapabilityDescriptor> = {
        ...(cancelAck === 'prompt-settlement' ? {} : { interruptAck: cancelAck === 'agent-record' ? RECORDED_CANCEL : UNCONFIRMED_CANCEL }),
        ...(input.flavor?.metersUsage === true ? {} : { usage: invisibleSlot() }),
    };
    const harness: CapabilityDescriptor = engine === 'v2' ? { ...KIRO_HARNESS, ...agent, ...override?.harness } : {
        ...KIRO_HARNESS,
        ...agent,
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
            // A flavor's cancel ack (the prompt's settlement for kiro-cli, the
            // Gateway's stop record for Kiro Crew) makes it a native ack.
            // Otherwise session/cancel is only a notification. Either way a
            // watchdog fences only the stuck session.
            cancel: cancelAck ? 'native-ack' : 'inferred-keep-session',
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

/**
 * Without an instance (no engine, no clients): the v2 shape of kiro-cli with
 * Michi's tools and sidecar titles. It stays the compatibility table
 * (describeRuntimeCapabilities) although Michi now starts v3 by default, whose
 * capabilities depend on what a process negotiates; an instance reports those
 * itself.
 */
export const KIRO_STATIC_DESCRIPTOR: RuntimeDescriptor = kiroDescriptor({
    engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: true, flavor: KIRO_FLAVOR,
});
