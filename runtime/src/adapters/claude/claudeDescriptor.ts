import { invisibleSlot, slot, type CapabilityDescriptor } from 'michi-shared';
import type { RuntimeDescriptor, RuntimeRunFacet } from '../../contract/descriptor';

export const CLAUDE_HARNESS: CapabilityDescriptor = {
  steer: slot('native', 'native', 'SDK user message during a turn: folded in at the next tool round, else run as the next CLI turn within the same Michi turn (command_lifecycle); Stop withdraws an unstarted steer. Chats only'),
  followUp: invisibleSlot('Michi pendingQueued is next-turn flush, not Claude steer'),
  interruptAck: slot('native', 'native', 'SDK interrupt plus terminal result; process retirement fallback is inferred'),
  compact: slot('native', 'native', '/compact through SDK input; compact_boundary reports the context before and after. Auto-compaction is reported too'),
  retry: invisibleSlot(),
  sessionFork: slot('native', 'native', 'SDK forkSession for compatible, idle conversation parents; saved message anchors select historical boundaries'),
  nativeResume: slot('native', 'native', '--resume'),
  permissions: slot('native', 'native', 'claude_prompt_tool'),
  sandbox: invisibleSlot('Not enabled: Options.sandbox needs bubblewrap and socat on Linux; without them the CLI refuses to start or runs unsandboxed'),
  subagents: slot('native', 'native', 'Agent/Task: task_* lifecycle, forwarded child messages (parent_tool_use_id) and the structured hand-back'),
  usage: slot('native', 'native', 'Per-turn tokens of the main loop from result.usage; the CLI cost is a list-price estimate and is not shown'),
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
