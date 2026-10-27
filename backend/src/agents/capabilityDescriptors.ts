import { CURSOR_DESCRIPTOR, GROK_DESCRIPTOR } from "./acp/acpDescriptor";
import { ANTIGRAVITY_DESCRIPTOR } from "./antigravity/antigravityDescriptor";
export { CURSOR_DESCRIPTOR, GROK_DESCRIPTOR, ANTIGRAVITY_DESCRIPTOR };
import type { CapabilityDescriptor } from "michi-shared";
import { UNKNOWN_HARNESS } from "michi-runtime/internal/core/descriptors";
import { CLAUDE_HARNESS } from "michi-runtime/internal/adapters/claude/claudeDescriptor";
import { CODEX_HARNESS } from "michi-runtime/internal/adapters/codex/codexDescriptor";
import { CREW_HARNESS } from "michi-runtime/internal/adapters/crew/crewDescriptor";
import { KIRO_HARNESS } from "michi-runtime/internal/adapters/kiro/kiroDescriptor";
import { PI_HARNESS } from "./pi/piDescriptor";

// Compatibility module. Each runtime describes itself in its own directory
// (`descriptor` on the instance, `staticDescriptor` on its factory); these
// names keep pointing at the same capability slots.

export const CODEX_DESCRIPTOR: CapabilityDescriptor = CODEX_HARNESS;
export const CLAUDE_DESCRIPTOR: CapabilityDescriptor = CLAUDE_HARNESS;
export const KIRO_DESCRIPTOR: CapabilityDescriptor = KIRO_HARNESS;
export const CREW_DESCRIPTOR: CapabilityDescriptor = CREW_HARNESS;
export const UNKNOWN_DESCRIPTOR: CapabilityDescriptor = UNKNOWN_HARNESS;

const HARNESS_BY_RUNTIME_ID: ReadonlyMap<string, CapabilityDescriptor> = new Map([
  ["pi", PI_HARNESS],
  ["cursor", CURSOR_DESCRIPTOR],
  ["grok", GROK_DESCRIPTOR],
  ["antigravity", ANTIGRAVITY_DESCRIPTOR],
  ["codex", CODEX_HARNESS],
  ["claude", CLAUDE_HARNESS],
  ["kiro", KIRO_HARNESS],
  ["crew", CREW_HARNESS],
]);

export function describeRuntimeCapabilities(runtimeId: string): CapabilityDescriptor {
  return HARNESS_BY_RUNTIME_ID.get(runtimeId) ?? UNKNOWN_DESCRIPTOR;
}
