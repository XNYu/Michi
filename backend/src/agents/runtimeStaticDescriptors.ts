import { CURSOR_RUNTIME_DESCRIPTOR, GROK_RUNTIME_DESCRIPTOR } from "./acp/acpDescriptor";
import { ANTIGRAVITY_RUNTIME_DESCRIPTOR } from "./antigravity/antigravityDescriptor";
import type { RuntimeDescriptor } from "michi-runtime/internal/contract/descriptor";
import { UNKNOWN_RUNTIME_DESCRIPTOR } from "michi-runtime/internal/core/descriptors";
import { KIRO_STATIC_DESCRIPTOR } from "michi-runtime/internal/adapters/kiro/kiroDescriptor";
import { CREW_STATIC_DESCRIPTOR } from "michi-runtime/internal/adapters/crew/crewDescriptor";
import { PI_RUNTIME_DESCRIPTOR } from "./pi/piDescriptor";
import { CLAUDE_RUNTIME_DESCRIPTOR } from "michi-runtime/internal/adapters/claude/claudeDescriptor";
import { CODEX_RUNTIME_DESCRIPTOR } from "michi-runtime/internal/adapters/codex/codexDescriptor";

/**
 * Each runtime's description without an instance: the shape under default
 * configuration, independent of availability. RUNTIME_FACTORIES takes its
 * `staticDescriptor` from here. This module imports only the descriptor
 * modules, so a route can read it without loading every runtime.
 */
export const STATIC_RUNTIME_DESCRIPTORS = {
    kiro: KIRO_STATIC_DESCRIPTOR,
    crew: CREW_STATIC_DESCRIPTOR,
    pi: PI_RUNTIME_DESCRIPTOR,
    claude: CLAUDE_RUNTIME_DESCRIPTOR,
    codex: CODEX_RUNTIME_DESCRIPTOR,
    cursor: CURSOR_RUNTIME_DESCRIPTOR,
    grok: GROK_RUNTIME_DESCRIPTOR,
    antigravity: ANTIGRAVITY_RUNTIME_DESCRIPTOR,
} as const satisfies Record<string, RuntimeDescriptor>;

/** The static descriptor of a runtime id, or the unknown descriptor for an id no factory builds. */
export function staticRuntimeDescriptor(runtimeId: string): RuntimeDescriptor {
    return Object.hasOwn(STATIC_RUNTIME_DESCRIPTORS, runtimeId)
        ? STATIC_RUNTIME_DESCRIPTORS[runtimeId as keyof typeof STATIC_RUNTIME_DESCRIPTORS]
        : UNKNOWN_RUNTIME_DESCRIPTOR;
}
