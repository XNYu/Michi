import { invisibleSlot, slot, type CapabilityDescriptor } from "michi-shared";
import type { RuntimeDescriptor, RuntimeRunFacet } from "michi-runtime/internal/contract/descriptor";

// The coding-agent experiment has no SDK transport; the factory always uses
// PiSession. Capability declarations describe that actual implementation.
export const PI_HARNESS: CapabilityDescriptor = {
  // Wired directly on PiSession against the pi-agent-core Agent instance
  // Michi already owns; injected at the next assistant-turn boundary.
  steer: slot("native", "native", "Agent.steer — injected after the current assistant turn"),
  // Agent.followUp exists on the same instance but has no Michi caller and no
  // HTTP route, so it stays unwired rather than claiming native.
  followUp: slot("native_unwired", "unknown", "Agent.followUp exists; no Michi caller or route"),
  interruptAck: slot("native", "native", "Agent.abort()"),
  // pi-agent-core 0.85.1 exposes no compaction API at all — only
  // transformContext/shouldStopAfterTurn hooks you could build one on.
  compact: invisibleSlot("pi-agent-core exposes no compaction API"),
  retry: invisibleSlot("Retry events exist on the unimplemented SDK session layer only"),
  sessionFork: slot("michi_simulated", "projected", "Michi node tree is authoritative; Pi JSONL is resume detail"),
  nativeResume: slot("inferred", "projected", "SQLite text replay, not native session file"),
  permissions: slot("michi_simulated", "projected", "michi_policy via beforeToolCall"),
  sandbox: slot("michi_simulated", "projected", "cwd path sandbox only"),
  subagents: invisibleSlot(),
  usage: slot("native", "native", "pi-agent-core usage fields"),
};

export const PI_RUN: RuntimeRunFacet = {
  toolMode: "allowlist",
  steering: "native",
  // Once interrupted there is no active native turn to steer.
  immediateSteering: "next_turn",
  supportsNativeResume: false,
};

export const PI_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  spec: 1,
  harness: PI_HARNESS,
  topology: {
    // Sessions adopt the Michi node id; there is no native identity.
    identityTiming: "none",
    // Agent.abort() on the agent Michi owns.
    cancel: "native-ack",
    toolDelivery: ["in-process"],
    // A fresh PiSession is seeded with the stored messages.
    historyReplay: "messages",
    backgroundTurns: false,
    titles: "none",
  },
  run: PI_RUN,
};
