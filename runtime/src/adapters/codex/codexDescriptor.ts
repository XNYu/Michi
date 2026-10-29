import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor, RuntimeRunFacet } from '../../contract/descriptor';

export const CODEX_HARNESS: CapabilityDescriptor = {
  steer: slot('native', 'native', 'turn/steer'),
  followUp: invisibleSlot('Codex exposes steer, not a separate followUp queue'),
  interruptAck: slot('native', 'native', 'turn/interrupt → interrupted'),
  compact: slot('native', 'native', 'thread/compact/start'),
  retry: invisibleSlot(),
  sessionFork: slot('native', 'native', 'thread/fork for compatible, idle conversation parents'),
  nativeResume: slot('native', 'native', 'thread/resume'),
  permissions: slot('native', 'native', 'codex_approval'),
  sandbox: slot('native', 'native', 'OS sandbox + approval policy'),
  subagents: slot('native', 'projected', 'thread/started child discovery + per-thread item/* forwarding'),
  usage: slot('native', 'native', 'thread/tokenUsage/updated'),
};

/**
 * Agent Runs use Codex's own tools plus the session's MCP slot tools, steer
 * through turn/steer, and resume from the persisted thread id.
 */
export const CODEX_RUN: RuntimeRunFacet = {
  toolMode: 'runtime_default',
  steering: 'native',
  // Once interrupted there is no active native turn to steer.
  immediateSteering: 'next_turn',
  supportsNativeResume: true,
};

export const CODEX_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  spec: 1,
  harness: CODEX_HARNESS,
  topology: {
    // thread/start returns the thread id; the route commits it with the binding.
    identityTiming: 'on-open',
    // turn/interrupt is a request with a response.
    cancel: 'native-ack',
    // __michi_internal__ points at the session's /api/mcp/<slot>.
    toolDelivery: ['mcp-http'],
    historyReplay: 'preamble',
    // Codex starts turns on its own only to pursue a thread goal; every Michi
    // thread turns goals off (CODEX_THREAD_FEATURES_OFF).
    backgroundTurns: false,
    // A title thread runs beside the first chat turn; its result joins the turn's events.
    titles: 'in-stream',
  },
  run: CODEX_RUN,
};
