import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';
import type { StreamHandlers } from '../services/chatStreamEvents';
import { subscribeChat } from '../services/api';
import { assistantAnswerVisibleText } from './assistantBlocks';
import { inspectOriginalTurn, turnErrorAction } from './turnErrorRecovery';

vi.mock('../services/api', () => ({ subscribeChat: vi.fn(() => vi.fn()) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('turn error action policy', () => {
  it('requires inspection for uncertain durability, without broadening ordinary retries', () => {
    expect(turnErrorAction('turn_persistence_failed')).toBe('inspect-existing-turn');
    expect(turnErrorAction('turn_outcome_unknown')).toBe('inspect-existing-turn');
    expect(turnErrorAction('backend_restarted')).toBe('inspect-existing-turn');
    expect(turnErrorAction('turn_replay_unavailable')).toBe('inspect-existing-turn');
    for (const kind of [undefined, 'connection', 'auth', 'turn_active', 'invalid_request']) {
      expect(turnErrorAction(kind)).toBe('rerun-prompt');
    }
  });

  it('checks exactly the original identity with a read-only replay and accepts only a durable receipt', () => {
    const onResult = vi.fn();
    inspectOriginalTurn({ chatId: 'owner-chat', turnId: 'original', assistant: { id: 'assistant', role: 'assistant', text: '', toolCalls: [] }, workspaceId: 'workspace', onResult });
    const [chatId, handlers, cursor] = vi.mocked(subscribeChat).mock.calls[0];
    expect(chatId).toBe('owner-chat');
    expect(cursor).toEqual({ turnId: 'original', seq: 0 });
    expect(handlers.onEnvelope?.({ turnId: 'newer', seq: 0 })).toBe(false);
    expect(handlers.onEnvelope?.({ turnId: 'original', seq: 9 })).toBe(true);
    const observe = vi.mocked(subscribeChat).mock.calls[0][3]!.onEvent!;
    observe({ event: 'turn_start', data: { turnId: 'original', assistantId: 'assistant', nodeId: 'node', userText: 'original request', seq: 0 } });
    observe({ event: 'chunk', data: { turnId: 'original', seq: 1, text: 'Recovered result' } });
    observe({ event: 'done', data: { turnId: 'original', seq: 2, persisted: true, stopReason: 'end_turn' } });
    handlers.onDone?.('end_turn', 'assistant', 'original', true, 100);
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ persisted: true, completedAt: 100 }));
    expect(assistantAnswerVisibleText(onResult.mock.calls[0][0].assistant)).toBe('Recovered result');
    expect(vi.mocked(subscribeChat).mock.results[0].value).toHaveBeenCalledOnce();
  });

  it.each(['foreground', 'background'] as const)('commits recovered output and only its %s replay watermark together', (cursor) => {
    const assistant = { id: 'a1', role: 'assistant' as const, text: '', toolCalls: [] };
    const node: ChatNodeState = {
      nodeId: 'n1', projectId: 'w1', kind: 'chat', chatId: 'n1', messages: [assistant], followUps: [],
      status: 'error', errorKind: 'turn_outcome_unknown', errorTurnId: 'original',
      lastAppliedTurnId: 'foreground-before', lastAppliedSeq: 1,
      lastAppliedBackgroundTurnId: 'background-before', lastAppliedBackgroundSeq: 3,
    };
    const recovered = reduceNodes({ n1: node }, {
      type: 'recover-original-result', nodeId: 'n1', turnId: 'original', assistantId: 'a1',
      assistant: { ...assistant, text: 'Recovered' }, lastSeq: 8, cursor,
    }).n1;
    if (cursor === 'foreground') {
      expect(recovered.lastAppliedTurnId).toBe('original');
      expect(recovered.lastAppliedSeq).toBe(8);
      expect(recovered.lastAppliedBackgroundTurnId).toBe('background-before');
      expect(recovered.lastAppliedBackgroundSeq).toBe(3);
    } else {
      expect(recovered.lastAppliedBackgroundTurnId).toBe('original');
      expect(recovered.lastAppliedBackgroundSeq).toBe(8);
      expect(recovered.lastAppliedTurnId).toBe('foreground-before');
      expect(recovered.lastAppliedSeq).toBe(1);
    }
    expect(recovered.messages[0].text).toBe('Recovered');
    const newer = { ...node, status: 'streaming' as const, errorTurnId: undefined };
    expect(reduceNodes({ n1: newer }, {
      type: 'recover-original-result', nodeId: 'n1', turnId: 'original', assistantId: 'a1',
      assistant: { ...assistant, text: 'Recovered' }, lastSeq: 8, cursor,
    }).n1).toBe(newer);
  });

  it('does not promote a durable receipt when the result replay is incomplete', () => {
    const onResult = vi.fn();
    inspectOriginalTurn({ chatId: 'owner-chat', turnId: 'original', assistant: { id: 'assistant', role: 'assistant', text: '', toolCalls: [] }, workspaceId: 'workspace', onResult });
    const [, handlers, , opts] = vi.mocked(subscribeChat).mock.calls[0];
    opts?.onEvent?.({ event: 'turn_start', data: { turnId: 'original', assistantId: 'assistant', nodeId: 'node', userText: 'request', seq: 0 } });
    opts?.onEvent?.({ event: 'done', data: { turnId: 'original', seq: 2, persisted: true } });
    handlers.onDone?.('end_turn', 'assistant', 'original', true);
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ persisted: false, completedAt: undefined });
  });

  it.each(['persistence failure', 'missing receipt', 'replay unavailable', 'deadline'])('leaves %s unknown and finishes its subscription', (failure) => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    inspectOriginalTurn({ chatId: 'owner-chat', turnId: 'original', assistant: { id: 'assistant', role: 'assistant', text: '', toolCalls: [] }, workspaceId: 'workspace', onResult });
    const handlers = vi.mocked(subscribeChat).mock.calls[0][1] as StreamHandlers;
    if (failure === 'persistence failure') handlers.onErrorPayload?.({ message: 'commit failed', code: 'turn_persistence_failed' });
    if (failure === 'missing receipt') handlers.onDone?.('end_turn', 'assistant', 'original');
    if (failure === 'replay unavailable') vi.mocked(subscribeChat).mock.calls[0][3]?.onDisconnect?.({ retryable: false, error: new Error('410') });
    if (failure === 'deadline') vi.advanceTimersByTime(10_000);
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ persisted: false, completedAt: undefined });
    expect(vi.mocked(subscribeChat).mock.results[0].value).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20_000);
    expect(onResult).toHaveBeenCalledOnce();
  });
});
