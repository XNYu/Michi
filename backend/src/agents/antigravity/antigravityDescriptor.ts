import { invisibleSlot, slot, type CapabilityDescriptor } from "michi-shared";
import type { RuntimeDescriptor } from "michi-runtime/internal/contract/descriptor";

export const ANTIGRAVITY_DESCRIPTOR: CapabilityDescriptor = {
  steer: invisibleSlot("print CLI"),
  followUp: invisibleSlot(),
  interruptAck: slot("inferred", "unknown"),
  compact: invisibleSlot(),
  retry: invisibleSlot(),
  sessionFork: slot("michi_simulated", "projected"),
  nativeResume: slot("native", "native"),
  permissions: invisibleSlot(),
  sandbox: invisibleSlot(),
  subagents: invisibleSlot(),
  usage: invisibleSlot(),
};
export const ANTIGRAVITY_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  spec: 1,
  harness: ANTIGRAVITY_DESCRIPTOR,
  topology: { identityTiming: 'on-first-turn', cancel: 'process-restart', toolDelivery: [], historyReplay: 'preamble', backgroundTurns: false, titles: 'none' },
  run: null,
};
