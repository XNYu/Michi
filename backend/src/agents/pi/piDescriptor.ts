import { invisibleSlot, slot, type CapabilityDescriptor } from "michi-shared";
import type { RuntimeDescriptor, RuntimeRunFacet } from "michi-runtime/internal/contract/descriptor";

// Default SDK capabilities. Operational rollback is described separately below.
export const PI_HARNESS: CapabilityDescriptor = {
  // Wired directly on PiSession against the pi-agent-core Agent instance
  // Michi already owns; injected at the next assistant-turn boundary.
  steer: slot("native", "native", "Agent.steer — injected after the current assistant turn"),
  // Agent.followUp exists on the same instance but has no Michi caller and no
  // HTTP route, so it stays unwired rather than claiming native.
  followUp: slot("native_unwired", "unknown", "Agent.followUp exists; no Michi caller or route"),
  interruptAck: slot("native", "native", "Agent.abort()"),
  // SDK auto-compaction stays active; manual compact runs between turns and
  // resolves on completion (CompactResult.completed).
  compact: slot("native", "native", "AgentSession.compact() between turns via POST /chats/:chatId/compact"),
  retry: invisibleSlot("SDK automatic retries disabled; Michi owns retry policy"),
  sessionFork: slot("michi_simulated", "projected", "Michi node tree is authoritative; Pi JSONL is resume detail"),
  nativeResume: slot("native", "native", "Scoped SDK JSONL restored only when its checkpoint matches authoritative SQLite history"),
  permissions: slot("michi_simulated", "projected", "michi_policy through the SDK tool_call lifecycle"),
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

/** Rollback has the same host tools and policy, but no SDK session features. */
export const PI_CORE_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  ...PI_RUNTIME_DESCRIPTOR,
  harness: { ...PI_HARNESS,
    compact: invisibleSlot('Agent-core rollback has no SDK compaction'),
    nativeResume: slot('inferred', 'projected', 'SQLite text replay in agent-core rollback'),
  },
};
