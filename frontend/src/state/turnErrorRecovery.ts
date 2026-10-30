import { projectAssistantStreamEvent } from './assistantBlocks';
import type { ChatMessage } from './chatTypes';
import { subscribeChat } from '../services/api';

/** Missing replay, unknown execution and persistence failure never authorize execution again. */
export function turnErrorAction(errorKind?: string): 'inspect-existing-turn' | 'rerun-prompt' {
  return errorKind === 'turn_persistence_failed' || errorKind === 'turn_outcome_unknown' || errorKind === 'backend_restarted' || errorKind === 'turn_replay_unavailable'
    ? 'inspect-existing-turn'
    : 'rerun-prompt';
}

/** A bounded, read-only check. Missing replay is not evidence that the prompt never ran. */
export function inspectOriginalTurn(options: {
  chatId: string;
  turnId: string;
  assistant: ChatMessage;
  workspaceId: string;
  onResult: (result: { persisted: boolean; completedAt?: number; assistant?: ChatMessage; lastSeq?: number }) => void;
}): () => void {
  let reconstructed: ChatMessage = { id: options.assistant.id, role: 'assistant', text: '', toolCalls: [], blocks: [], createdAt: options.assistant.createdAt };
  let nextSeq = 0;
  let completeReplay = true;
  let started = false;
  let finished = false;
  // eslint-disable-next-line prefer-const -- finish() reads detach and may run inside subscribeChat() before it returns; const would throw there.
  let detach: (() => void) | undefined;
  const finish = (persisted: boolean, completedAt?: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    detach?.();
    const confirmed = persisted && started && completeReplay;
    options.onResult({ persisted: confirmed, completedAt, ...(confirmed ? { assistant: reconstructed, lastSeq: nextSeq - 1 } : {}) });
  };
  const deadline = setTimeout(() => finish(false), 10_000);
  detach = subscribeChat(options.chatId, {
    // A feed may continue into newer turns. Never accept another execution's result.
    onEnvelope: (envelope) => !finished && envelope.turnId === options.turnId,
    onDone: (reason, _assistantId, _turnId, persisted, completedAt) => {
      finish(persisted === true && reason !== 'error', completedAt);
    },
    onErrorPayload: () => finish(false),
    onError: () => finish(false),
  }, { turnId: options.turnId, seq: 0 }, {
    onEvent: (event) => {
      if (finished || event.data.turnId !== options.turnId) return;
      if (typeof event.data.seq !== 'number' || event.data.seq !== nextSeq) completeReplay = false;
      nextSeq = (event.data.seq ?? nextSeq) + 1;
      if (event.event === 'turn_start') {
        started = true;
        if (event.data.assistantId) reconstructed = { ...reconstructed, id: event.data.assistantId };
      }
      reconstructed = projectAssistantStreamEvent(reconstructed, options.workspaceId, event);
    },
    onDisconnect: () => finish(false),
  });
  if (finished) detach();
  return () => {
    finished = true;
    clearTimeout(deadline);
    detach?.();
  };
}
