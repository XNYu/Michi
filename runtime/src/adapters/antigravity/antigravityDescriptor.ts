import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor } from '../../contract/descriptor';
import { kiroDescriptor, type KiroDescriptorOverride } from '../kiro/kiroDescriptor';
import { ANTIGRAVITY_KIRO_FLAVOR } from './antigravityFlavor';

/**
 * Antigravity's `agy acp` (standard ACP, none of Kiro's extensions) as a
 * preset of the Kiro v2 description. Probed against agy 1.4.12.
 */
export const ANTIGRAVITY_DESCRIPTOR_OVERRIDE: KiroDescriptorOverride = {
    harness: {
        steer: invisibleSlot('agy has no steer; busy sends wait for the next turn'),
        // `/compact` sent as a prompt reaches the model as text; agy compacts on its own.
        compact: invisibleSlot('agy has no compact command'),
        sessionFork: invisibleSlot('agy has no session/fork; Michi replays history'),
        subagents: invisibleSlot('agy subagents run as tool calls; their reports arrive at the next turn'),
        usage: slot('native', 'native', 'session/prompt usage: tokens; no cost or context %'),
        permissions: slot('native', 'native', 'session/request_permission for edits and commands; agy does not gate reads in the workspace or MCP tools'),
        // agy "loads" an unknown session id as an empty session.
        nativeResume: slot('native', 'native', 'session/load after a session/list check'),
    },
    toolDelivery: 'mcp-http',
    titles: 'native-update',
    run: null,
};

/** Antigravity is pinned to one agy process per cwd (engine v2). */
export const ANTIGRAVITY_STATIC_DESCRIPTOR: RuntimeDescriptor = kiroDescriptor({
    engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: false, flavor: ANTIGRAVITY_KIRO_FLAVOR,
    override: ANTIGRAVITY_DESCRIPTOR_OVERRIDE,
});

export const ANTIGRAVITY_HARNESS: CapabilityDescriptor = ANTIGRAVITY_STATIC_DESCRIPTOR.harness;
