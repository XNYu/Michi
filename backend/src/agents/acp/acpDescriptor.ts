import { invisibleSlot, slot, type CapabilityDescriptor } from "michi-shared";
import type { RuntimeDescriptor } from "michi-runtime/internal/contract/descriptor";

const ACP_HARNESS: CapabilityDescriptor = {
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
  ...ACP_HARNESS,
  steer: invisibleSlot("Kiro private steering extensions are not generic ACP"),
  sessionFork: slot("michi_simulated", "projected"),
  compact: invisibleSlot("Cursor ACP does not advertise Kiro compaction extensions"),
  subagents: invisibleSlot(),
};

export const GROK_DESCRIPTOR: CapabilityDescriptor = {
  ...CURSOR_DESCRIPTOR,
  // Live on grok 1.0.62: standard session/fork is absent. `_x.ai/session/fork`
  // copies the latest conversation into a new session id.
  sessionFork: slot("native", "native", "_x.ai/session/fork for the latest conversation; historical anchors fall back"),
};

export const CURSOR_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  spec: 1,
  harness: CURSOR_DESCRIPTOR,
  topology: { identityTiming: 'on-open', cancel: 'inferred-keep-session', toolDelivery: ['mcp-http'], historyReplay: 'preamble', backgroundTurns: false, titles: 'native-update' },
  run: null,
};
export const GROK_RUNTIME_DESCRIPTOR: RuntimeDescriptor = { ...CURSOR_RUNTIME_DESCRIPTOR, harness: GROK_DESCRIPTOR };
