import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';
import { getSavedTurn, subscribeChat, type SavedTurn } from '../services/api';
import { assistantAnswerVisibleText } from './assistantBlocks';
import { inspectOriginalTurn, savedTurnResult, turnErrorAction } from './turnErrorRecovery';

vi.mock('../services/api', () => ({ getSavedTurn: vi.fn(), subscribeChat: vi.fn(() => vi.fn()) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function savedTurn(overrides: Partial<SavedTurn> = {}): SavedTurn {
  return {
    turnId: 'original', assistantId: 'assistant', status: 'completed', stopReason: 'end_turn', completedAt: 100, lastSeq: 8,
    message: { id: 'assistant', node_id: 'node', role: 'assistant', content: 'Recovered result', seq: 1, created_at: 5 },
    ...overrides,
  };
}

describe('turn error action policy', () => {
  it('requires inspection for uncertain durability, without broadening ordinary retries', () => {
    expect(turnErrorAction('turn_persistence_failed')).toBe('inspect-existing-turn');
    expect(turnErrorAction('turn_outcome_unknown')).toBe('inspect-existing-turn');
    expect(turnErrorAction('turn_replay_unavailable')).toBe('inspect-existing-turn');
    for (const kind of [undefined, 'connection', 'auth', 'turn_active', 'invalid_request', 'something_new']) {
      expect(turnErrorAction(kind)).toBe('rerun-prompt');
    }
  });

  it('resumes a turn a restart cut short instead of checking or re-sending it', () => {
    // The backend wrote the receipt itself and the partial output is checkpointed,
    // so the known outcome is carried on, never re-executed from the original prompt.
    expect(turnErrorAction('backend_restarted')).toBe('resume-turn');
  });

  it('maps only a completed or cancelled saved turn with a completion time, as hydration maps the row', () => {
    const completed = savedTurnResult(savedTurn())!;
    expect(assistantAnswerVisibleText(completed.assistant)).toBe('Recovered result');
    expect(completed).toMatchObject({ completedAt: 100, lastSeq: 8, stopReason: 'end_turn' });
    expect(completed.assistant).toMatchObject({ id: 'assistant', role: 'assistant', streaming: false, createdAt: 5 });
    expect(savedTurnResult(savedTurn({ status: 'cancelled', stopReason: null }))?.stopReason).toBe('cancelled');
    for (const unfinished of [
      { status: 'active', completedAt: null }, { status: 'error' }, { completedAt: null }, { stopReason: 'error' },
      { message: null }, { message: { ...savedTurn().message!, id: 'other' } }, { message: { ...savedTurn().message!, role: 'user' } },
    ] as Array<Partial<SavedTurn>>) {
      expect(savedTurnResult(savedTurn(unfinished))).toBeNull();
    }
  });

  it('checks exactly the original identity with a read of the saved turn, not a replay', async () => {
    vi.mocked(getSavedTurn).mockResolvedValueOnce(savedTurn());
    const onResult = vi.fn();
    inspectOriginalTurn({ chatId: 'owner-chat', turnId: 'original', onResult });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(vi.mocked(getSavedTurn).mock.calls[0].slice(0, 2)).toEqual(['owner-chat', 'original']);
    expect(subscribeChat).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ persisted: true, completedAt: 100, lastSeq: 8 }));
    expect(assistantAnswerVisibleText(onResult.mock.calls[0][0].assistant)).toBe('Recovered result');
  });

  it.each(['still running', 'failed', 'missing', 'deadline'])('leaves a %s turn unknown and reports once', async (failure) => {
    if (failure === 'deadline') vi.useFakeTimers();
    let abortSignal: AbortSignal | undefined;
    vi.mocked(getSavedTurn).mockImplementationOnce(async (_chatId, _turnId, signal) => {
      abortSignal = signal;
      if (failure === 'still running') return savedTurn({ status: 'active', completedAt: null });
      if (failure === 'failed') return savedTurn({ status: 'error' });
      if (failure === 'missing') return null;
      return new Promise<never>(() => {});
    });
    const onResult = vi.fn();
    inspectOriginalTurn({ chatId: 'owner-chat', turnId: 'original', onResult });
    if (failure === 'deadline') await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledWith({ persisted: false });
    expect(abortSignal?.aborted).toBe(true);
  });

  it('a detached check never reports', async () => {
    let resolve!: (saved: SavedTurn) => void;
    vi.mocked(getSavedTurn).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const onResult = vi.fn();
    const detach = inspectOriginalTurn({ chatId: 'owner-chat', turnId: 'original', onResult });
    detach();
    resolve(savedTurn());
    await new Promise((done) => setTimeout(done, 0));
    expect(onResult).not.toHaveBeenCalled();
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
    const newer = { ...node, status: 'streaming' as const, errorTurnId: undefined, activeTurnId: 'newer' };
    expect(reduceNodes({ n1: newer }, {
      type: 'recover-original-result', nodeId: 'n1', turnId: 'original', assistantId: 'a1',
      assistant: { ...assistant, text: 'Recovered' }, lastSeq: 8, cursor,
    }).n1).toBe(newer);
  });

  it('lets the streaming foreground turn apply its own saved result, never an older assistant', () => {
    const older = { id: 'a0', role: 'assistant' as const, text: 'old', toolCalls: [] };
    const live = { id: 'a1', role: 'assistant' as const, text: 'partial', toolCalls: [], streaming: true };
    const node: ChatNodeState = {
      nodeId: 'n1', projectId: 'w1', kind: 'chat', chatId: 'n1', messages: [older, live], followUps: [],
      status: 'streaming', activeTurnId: 'original',
    };
    const apply = (assistantId: string, turnId = 'original') => reduceNodes({ n1: node }, {
      type: 'recover-original-result', nodeId: 'n1', turnId, assistantId,
      assistant: { id: assistantId, role: 'assistant', text: 'Saved', toolCalls: [] }, lastSeq: 8, cursor: 'foreground',
    }).n1;
    expect(apply('a1').messages.map((message) => message.text)).toEqual(['old', 'Saved']);
    expect(apply('a1').lastAppliedSeq).toBe(8);
    expect(apply('a0')).toBe(node);
    expect(apply('a1', 'other-turn')).toBe(node);
  });
});
