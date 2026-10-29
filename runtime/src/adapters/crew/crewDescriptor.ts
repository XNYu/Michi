import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import { kiroDescriptor, type KiroDescriptorOverride } from '../kiro/kiroDescriptor';
import { CREW_KIRO_FLAVOR } from './crewFlavor';

/**
 * Kiro Crew through its ACP adapter, as a preset of the Kiro v2 description.
 * Fork copies the Gateway transcript into an independent slot; the provider
 * reconstructs its context. What an official App caller can and cannot do
 * was probed against the official Gateway 0.11.0.1 (VALIDATION.md).
 */
export const CREW_DESCRIPTOR_OVERRIDE: KiroDescriptorOverride = {
    harness: {
        permissions: slot('native', 'projected', 'Official sessionApproval grant required; pending tool requests forwarded to Michi Ask/Trust'),
        // POST /api/chat {steer: true} from an App answers {queued: true}: steer is the session's own human's.
        steer: invisibleSlot('Official Crew Gateway queues App sends for the next turn; same-turn steer is human-only'),
        interruptAck: slot('native', 'native', 'Gateway stop_event record (stopped / stop_failed_reset) after the adapter\'s stop; inferred when none arrives'),
        compact: slot('native', 'projected', '/compact on the App\'s own idle slot; Gateway compaction notice'),
        sessionFork: slot('native', 'projected', 'Gateway transcript fork with inherited memory identity and context replay; not a kiro-cli checkpoint'),
        subagents: slot('native', 'projected', 'Gateway subagent_* events for the App\'s own slots; spawn approvals are answered in the Crew dashboard, not Michi'),
        usage: slot('native', 'projected', 'Per-turn credits from Gateway turn_stats (kiro-cli metering) and context %; no token totals'),
    },
    // The adapter leases the session's /api/mcp/<slot> to the broker's stdio relay.
    toolDelivery: 'mcp-relay',
    // The adapter forwards the Gateway's session_info_update titles; no sidecar runs.
    titles: 'native-update',
    run: null,
};

/** Crew is pinned to one adapter process per cwd (engine v2). */
export const CREW_STATIC_DESCRIPTOR: RuntimeDescriptor = kiroDescriptor({
    engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: false, flavor: CREW_KIRO_FLAVOR,
    override: CREW_DESCRIPTOR_OVERRIDE,
});

export const CREW_HARNESS: CapabilityDescriptor = CREW_STATIC_DESCRIPTOR.harness;
