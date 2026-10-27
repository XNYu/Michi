import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor, RuntimeRunFacet } from '../../contract/descriptor';

export const CLAUDE_HARNESS: CapabilityDescriptor = {
  steer: invisibleSlot('SDK accepts input, but Michi does not yet multiplex active-turn steering results'),
  followUp: invisibleSlot('Michi pendingQueued is next-turn flush, not Claude steer'),
  interruptAck: slot('native', 'native', 'SDK interrupt plus terminal result; process retirement fallback is inferred'),
  compact: invisibleSlot(),
  retry: invisibleSlot(),
  sessionFork: slot('native', 'native', 'SDK forkSession for compatible, idle conversation parents; saved message anchors select historical boundaries'),
  nativeResume: slot('native', 'native', '--resume'),
  permissions: slot('native', 'native', 'claude_prompt_tool'),
  sandbox: invisibleSlot('CLI isolation is unverifiable from Michi'),
  subagents: slot('inferred', 'projected', 'Task tool roster only'),
  usage: invisibleSlot('Do not fabricate token/cost'),
};

export const CLAUDE_RUN: RuntimeRunFacet = {
  toolMode: 'allowlist',
  // ClaudeSession has no same-turn steer primitive. The executor owns the
  // queued/immediate next-turn loop and preserves SDK cancellation evidence.
  steering: 'next_turn',
  supportsNativeResume: true,
};

export const CLAUDE_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  spec: 1,
  harness: CLAUDE_HARNESS,
  topology: {
    // The session id arrives with system/init, which leads the first turn's output.
    identityTiming: 'on-first-turn',
    // An SDK interrupt confirmed by the terminal result keeps the process.
    // Only when the SDK cannot confirm that boundary is the process retired.
    cancel: 'native-ack',
    // The SDK's mcpServers entry points at the session's /api/mcp/<slot>.
    toolDelivery: ['mcp-http'],
    historyReplay: 'preamble',
    // Background task completions start turns of their own (onSelfTurn).
    backgroundTurns: true,
    titles: 'none',
  },
  run: CLAUDE_RUN,
};
