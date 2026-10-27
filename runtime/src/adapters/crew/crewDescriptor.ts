import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import { kiroDescriptor, type KiroDescriptorOverride } from '../kiro/kiroDescriptor';

/**
 * Kiro Crew through its ACP adapter, as a preset of the Kiro v2 description.
 * Kiro's private steering/compaction extensions remain unavailable. Fork
 * copies the Gateway transcript into an independent slot; the provider
 * reconstructs its context.
 */
export const CREW_DESCRIPTOR_OVERRIDE: KiroDescriptorOverride = {
    harness: {
        permissions: slot('native', 'projected', 'Official sessionApproval grant required; pending tool requests forwarded to Michi Ask/Trust'),
        steer: invisibleSlot('Official Crew Gateway excludes App callers from same-turn steer'),
        compact: invisibleSlot('Kiro Crew adapter does not support Kiro compaction'),
        sessionFork: slot('native', 'projected', 'Gateway transcript fork with inherited memory identity and context replay; not a kiro-cli checkpoint'),
        subagents: invisibleSlot('Kiro Crew adapter does not stream subagent updates'),
    },
    // The adapter leases the session's /api/mcp/<slot> to the broker's stdio relay.
    toolDelivery: 'mcp-relay',
    // The adapter forwards the Gateway's session_info_update titles; no sidecar runs.
    titles: 'native-update',
    run: null,
};

/** Crew is pinned to one adapter process per cwd (engine v2). */
export const CREW_STATIC_DESCRIPTOR: RuntimeDescriptor = kiroDescriptor({
    engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: false, override: CREW_DESCRIPTOR_OVERRIDE,
});

export const CREW_HARNESS: CapabilityDescriptor = CREW_STATIC_DESCRIPTOR.harness;
