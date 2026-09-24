import {
  invisibleSlot,
  slot,
  type CapabilityDescriptor,
} from "michi-shared";
import { isPiSessionSdkEnabled } from "./pi/piSdkFlag";

export function describeRuntimeCapabilities(runtimeId: string): CapabilityDescriptor {
  switch (runtimeId) {
    case "pi":
      return piDescriptor();
    case "codex":
      return CODEX_DESCRIPTOR;
    case "claude":
      return CLAUDE_DESCRIPTOR;
    case "kiro":
      return KIRO_DESCRIPTOR;
    case "cursor":
      return CURSOR_DESCRIPTOR;
    case "grok":
      return GROK_DESCRIPTOR;
    case "antigravity":
      return ANTIGRAVITY_DESCRIPTOR;
    default:
      return UNKNOWN_DESCRIPTOR;
  }
}

function piDescriptor(): CapabilityDescriptor {
  // NOTE: these slots deliberately no longer branch on MICHI_PI_SESSION_SDK.
  // That flag only selects PiSdkSession, which additionally requires
  // @earendil-works/pi-coding-agent — a package that is not a dependency and is
  // not installed, so createPiSession always returns a plain PiSession. Keying
  // the descriptor off the flag alone therefore advertised native steer/
  // followUp/compact that no code path could deliver, and the composer switched
  // to a Steer affordance that could only ever 409.
  const sdk = isPiSessionSdkEnabled();
  return {
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
    retry: sdk
      ? slot("native", "native", "auto_retry_* events")
      : invisibleSlot("Retry events exist on the SDK session layer only"),
    sessionFork: slot("michi_simulated", "projected", "Michi node tree is authoritative; Pi JSONL is resume detail"),
    nativeResume: slot("inferred", "projected", "SQLite text replay, not native session file"),
    permissions: slot("michi_simulated", "projected", "michi_policy via beforeToolCall"),
    sandbox: slot("michi_simulated", "projected", "cwd path sandbox only"),
    subagents: invisibleSlot(),
    usage: slot("native", "native", "pi-agent-core usage fields"),
  };
}

export const CODEX_DESCRIPTOR: CapabilityDescriptor = {
  steer: slot("native", "native", "turn/steer"),
  followUp: invisibleSlot("Codex exposes steer, not a separate followUp queue"),
  interruptAck: slot("native", "native", "turn/interrupt → interrupted"),
  compact: slot("native", "native", "thread/compact/start"),
  retry: invisibleSlot(),
  sessionFork: slot("native", "native", "thread/fork for compatible, idle conversation parents"),
  nativeResume: slot("native", "native", "thread/resume"),
  permissions: slot("native", "native", "codex_approval"),
  sandbox: slot("native", "native", "OS sandbox + approval policy"),
  subagents: slot("native", "projected", "thread/started child discovery + per-thread item/* forwarding"),
  usage: slot("native", "native", "thread/tokenUsage/updated"),
};

export const CLAUDE_DESCRIPTOR: CapabilityDescriptor = {
  steer: invisibleSlot("stream-json CLI has no same-turn steer"),
  followUp: invisibleSlot("Michi pendingQueued is next-turn flush, not Claude steer"),
  interruptAck: slot("inferred", "unknown", "process cancel; no structured ack"),
  compact: invisibleSlot(),
  retry: invisibleSlot(),
  sessionFork: slot("native", "native", "--resume --fork-session for compatible, idle conversation parents"),
  nativeResume: slot("native", "native", "--resume"),
  permissions: slot("native", "native", "claude_prompt_tool"),
  sandbox: invisibleSlot("CLI isolation is unverifiable from Michi"),
  subagents: slot("inferred", "projected", "Task tool roster only"),
  usage: invisibleSlot("Do not fabricate token/cost"),
};

export const KIRO_DESCRIPTOR: CapabilityDescriptor = {
  steer: slot("native", "native", "_session/steer; queued for the next agent boundary"),
  followUp: invisibleSlot(),
  interruptAck: slot("inferred", "unknown", "session/cancel notify — dispatch, not an agent ack"),
  // KiroSession.compact() now drives the ACP compact command, so this is a
  // real, invocable capability rather than "you can watch compaction happen".
  compact: slot("native", "native", "_kiro.dev/commands/execute compact"),
  retry: invisibleSlot(),
  sessionFork: slot("native", "native", "Kiro rewind for compatible idle conversation parents"),
  nativeResume: slot("native", "native", "loadSession"),
  permissions: slot("native", "native", "acp_permission"),
  sandbox: invisibleSlot(),
  subagents: slot("experimental", "unknown", "_session/terminate / subagent list"),
  usage: invisibleSlot(),
};

export const CURSOR_DESCRIPTOR: CapabilityDescriptor = {
  ...KIRO_DESCRIPTOR,
  steer: invisibleSlot("Kiro private steering extensions are not generic ACP"),
  sessionFork: slot("michi_simulated", "projected"),
  compact: invisibleSlot("Cursor ACP does not advertise Kiro compaction extensions"),
  subagents: invisibleSlot(),
};

export const GROK_DESCRIPTOR: CapabilityDescriptor = {
  ...CURSOR_DESCRIPTOR,
};

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

export const UNKNOWN_DESCRIPTOR: CapabilityDescriptor = {
  steer: invisibleSlot(),
  followUp: invisibleSlot(),
  interruptAck: invisibleSlot(),
  compact: invisibleSlot(),
  retry: invisibleSlot(),
  sessionFork: slot("michi_simulated", "projected"),
  nativeResume: invisibleSlot(),
  permissions: invisibleSlot(),
  sandbox: invisibleSlot(),
  subagents: invisibleSlot(),
  usage: invisibleSlot(),
};

export function absorbAcpCapabilities(
  base: CapabilityDescriptor,
  init: {
    loadSession?: boolean;
    image?: boolean;
    kiroCompaction?: boolean;
    kiroTerminate?: boolean;
  },
): CapabilityDescriptor {
  return {
    ...base,
    nativeResume: init.loadSession
      ? slot("native", "native", "ACP loadSession")
      : base.nativeResume,
    compact: init.kiroCompaction
      ? slot("experimental", "unknown", "_kiro.dev/compaction/status")
      : base.compact,
    subagents: init.kiroTerminate
      ? slot("experimental", "unknown", "_session/terminate")
      : base.subagents,
  };
}
