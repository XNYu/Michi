import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/api', () => ({
  __esModule: true,
  streamMessage: vi.fn(() => () => {}),
}));

import * as api from '../services/api';
import { runChatStream } from './chatStreamRunner';
import { reduceNodes } from './chatReducers';
import { assistantAnswerRawText } from './assistantBlocks';
import type { ChatAction, ChatNodeState } from './chatTypes';

const mockStream = api.streamMessage as ReturnType<typeof vi.fn>;

function makeNode(): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: 'n1',
    projectId: 'p1',
    parentNodeId: undefined,
    mergeSources: [],
    messages: [
      { id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true },
    ],
    followUps: [],
    status: 'streaming',
  };
}

describe('chatStreamRunner — chunk/tool-call ordering', () => {
  beforeEach(() => {
    mockStream.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes pending chunks before tool-call dispatch so textOffset includes buffered text', () => {
    const dispatched: ChatAction[] = [];
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: (a) => dispatched.push(a),
      assistantTextBufs: bufs,
      cancelFns: cancels,
    });

    const handlers = mockStream.mock.calls[0][2];

    // Simulate kiro emitting two chunks then a tool_call before RAF flush.
    handlers.onChunk('elsewh');
    handlers.onChunk('ere.');
    handlers.onToolCall({
      toolCallId: 't1',
      title: 'Running: python3',
      status: 'running',
    });
    handlers.onChunk(' Let me inspect.');

    // Drive RAF.
    vi.runAllTimers();

    // Replay actions through reducer to inspect final textOffset.
    let nodes: Record<string, ChatNodeState> = { n1: makeNode() };
    for (const a of dispatched) {
      nodes = reduceNodes(nodes, a);
    }

    const msg = nodes.n1.messages[0];
    expect(assistantAnswerRawText(msg)).toBe('elsewhere. Let me inspect.');
    expect(msg.toolCalls).toHaveLength(1);
    // textOffset is in raw m.text coordinates and recorded at tool-call
    // dispatch time — i.e. after the two chunks landed in m.text.
    expect(msg.toolCalls[0].textOffset).toBe(10);
  });

  it('flushes pending chunks before tool-call-update dispatch', () => {
    const dispatched: ChatAction[] = [];
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: (a) => dispatched.push(a),
      assistantTextBufs: bufs,
      cancelFns: cancels,
    });

    const handlers = mockStream.mock.calls[0][2];

    handlers.onChunk('first ');
    handlers.onToolCall({ toolCallId: 't1', title: 'A', status: 'running' });
    handlers.onChunk('second ');
    handlers.onToolCallUpdate({ toolCallId: 't2', title: 'B', status: 'running' });
    vi.runAllTimers();

    let nodes: Record<string, ChatNodeState> = { n1: makeNode() };
    for (const a of dispatched) nodes = reduceNodes(nodes, a);

    const tcs = nodes.n1.messages[0].toolCalls;
    expect(tcs).toHaveLength(2);
    expect(tcs[0].textOffset).toBe(6); // after 'first '
    expect(tcs[1].textOffset).toBe(13); // after 'first second ' (raw, no \n\n)
  });

  it('an older hidden tail cannot clear the cancel handle for a newer turn', () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    mockStream
      .mockImplementationOnce(() => firstCancel)
      .mockImplementationOnce(() => secondCancel);
    const cancels = { current: {} as Record<string, () => void> };
    const common = {
      chatId: 'c1',
      prompt: 'hi',
      nodeId: 'n1',
      dispatch: vi.fn(),
      assistantTextBufs: { current: {} as Record<string, string> },
      cancelFns: cancels,
    };

    const returnedFirst = runChatStream({ ...common, assistantId: 'a1' });
    cancels.current.n1 = returnedFirst;
    const firstHandlers = mockStream.mock.calls[0][2];

    const returnedSecond = runChatStream({ ...common, assistantId: 'a2' });
    cancels.current.n1 = returnedSecond;

    firstHandlers.onDone('end_turn');
    expect(cancels.current.n1).toBe(secondCancel);
  });
});

describe('chatStreamRunner — incremental follow-up sentinels', () => {
  beforeEach(() => {
    mockStream.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches follow-ups incrementally and completes visible output only after the third sentinel', () => {
    const dispatched: ChatAction[] = [];
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: (a) => dispatched.push(a),
      assistantTextBufs: bufs,
      cancelFns: cancels,
    });

    const handlers = mockStream.mock.calls[0][2];
    handlers.onChunk('Answer.\n\n[FOLLOW-UP 1');
    handlers.onChunk('/3: Why this path?]\n[FOLLOW-UP 2/3: What could go wrong?]');
    expect(dispatched.some((a) => a.type === 'visible-response-complete')).toBe(false);
    handlers.onChunk('\n[FOLLOW-UP 3/3: What is the contrarian view?]');
    vi.runAllTimers();

    const followUpActions = dispatched.filter((a) => a.type === 'set-follow-ups');
    expect(followUpActions).toEqual([
      { type: 'set-follow-ups', nodeId: 'n1', followUps: ['Why this path?'] },
      {
        type: 'set-follow-ups',
        nodeId: 'n1',
        followUps: ['Why this path?', 'What could go wrong?'],
      },
      {
        type: 'set-follow-ups',
        nodeId: 'n1',
        followUps: ['Why this path?', 'What could go wrong?', 'What is the contrarian view?'],
      },
    ]);
    expect(dispatched.filter((a) => a.type === 'visible-response-complete')).toEqual([
      { type: 'visible-response-complete', nodeId: 'n1', assistantId: 'a1' },
    ]);

    let nodes: Record<string, ChatNodeState> = { n1: makeNode() };
    for (const a of dispatched) nodes = reduceNodes(nodes, a);
    expect(nodes.n1.followUps).toEqual([
      'Why this path?',
      'What could go wrong?',
      'What is the contrarian view?',
    ]);
    expect(nodes.n1.visibleResponseComplete).toBe(true);
    expect(nodes.n1.status).toBe('idle');
    expect(nodes.n1.backgroundTurnAssistantId).toBe('a1');
    expect(nodes.n1.messages[0].streaming).toBe(false);
    expect(assistantAnswerRawText(nodes.n1.messages[0])).toBe(
      'Answer.\n\n[FOLLOW-UP 1/3: Why this path?]\n[FOLLOW-UP 2/3: What could go wrong?]\n[FOLLOW-UP 3/3: What is the contrarian view?]',
    );
  });

  it('still dispatches legacy compact follow-ups when the bracket closes', () => {
    const dispatched: ChatAction[] = [];
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: (a) => dispatched.push(a),
      assistantTextBufs: bufs,
      cancelFns: cancels,
    });

    const handlers = mockStream.mock.calls[0][2];
    handlers.onChunk('Answer.\n\n[FOLLOW-UPS: a? | b? | c?]');

    expect(dispatched).toContainEqual({
      type: 'set-follow-ups',
      nodeId: 'n1',
      followUps: ['a?', 'b?', 'c?'],
    });
    expect(dispatched).toContainEqual({
      type: 'visible-response-complete',
      nodeId: 'n1',
      assistantId: 'a1',
    });
  });
});

describe("reduceNodes 'done' — finalize stuck tool call statuses", () => {
  function nodeWithToolCalls(statuses: string[]): Record<string, ChatNodeState> {
    return {
      n1: {
        nodeId: 'n1',
        kind: 'chat',
        chatId: 'n1',
        projectId: 'p1',
        parentNodeId: undefined,
        mergeSources: [],
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            text: 'hello',
            toolCalls: statuses.map((s, i) => ({
              id: `t${i}`,
              title: `tool ${i}`,
              status: s,
            })),
            streaming: true,
          },
        ],
        followUps: [],
        status: 'streaming',
      },
    };
  }

  it("normalizes 'running' tool calls to 'completed' on done", () => {
    const next = reduceNodes(nodeWithToolCalls(['running']), {
      type: 'done',
      nodeId: 'n1',
      assistantId: 'a1',
    });
    expect(next.n1.messages[0].toolCalls[0].status).toBe('completed');
  });

  it('normalizes empty/in_progress/pending to completed', () => {
    const next = reduceNodes(nodeWithToolCalls(['', 'in_progress', 'pending']), {
      type: 'done',
      nodeId: 'n1',
      assistantId: 'a1',
    });
    expect(next.n1.messages[0].toolCalls.map((t) => t.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
  });

  it("preserves terminal statuses ('completed', 'failed')", () => {
    const next = reduceNodes(nodeWithToolCalls(['completed', 'failed']), {
      type: 'done',
      nodeId: 'n1',
      assistantId: 'a1',
    });
    expect(next.n1.messages[0].toolCalls.map((t) => t.status)).toEqual([
      'completed',
      'failed',
    ]);
  });
});


describe('onTurnEnd', () => {
  beforeEach(() => {
    mockStream.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires with reason "done" after onDone', () => {
    const onTurnEnd = vi.fn();
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: () => {},
      assistantTextBufs: bufs,
      cancelFns: cancels,
      onTurnEnd,
    });

    const handlers = mockStream.mock.calls[0][2];
    handlers.onDone();

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith('done', 'n1');
  });

  it('treats done(stopReason=error) as an error terminal path', () => {
    const onTurnEnd = vi.fn();
    const dispatched: ChatAction[] = [];
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: (action) => dispatched.push(action),
      assistantTextBufs: bufs,
      cancelFns: cancels,
      onTurnEnd,
    });

    const handlers = mockStream.mock.calls[0][2];
    handlers.onDone('error');

    expect(dispatched).toEqual([
      {
        type: 'error',
        nodeId: 'n1',
        assistantId: 'a1',
        message: 'Agent process exited before completing the turn.',
      },
    ]);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith('error', 'n1');
  });

  it('fires with reason "cancel" after onAborted', () => {
    const onTurnEnd = vi.fn();
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: () => {},
      assistantTextBufs: bufs,
      cancelFns: cancels,
      onTurnEnd,
    });

    const handlers = mockStream.mock.calls[0][2];
    handlers.onAborted();

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith('cancel', 'n1');
  });

  it('fires with reason "error" after onError', () => {
    const onTurnEnd = vi.fn();
    const bufs = { current: {} as Record<string, string> };
    const cancels = { current: {} as Record<string, () => void> };

    runChatStream({
      prompt: 'hi',
      nodeId: 'n1',
      assistantId: 'a1',
      dispatch: () => {},
      assistantTextBufs: bufs,
      cancelFns: cancels,
      onTurnEnd,
    });

    const handlers = mockStream.mock.calls[0][2];
    handlers.onError('boom');

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith('error', 'n1');
  });
});

describe('chatStreamRunner — onImage targets the retargeted assistant id', () => {
  beforeEach(() => mockStream.mockClear());

  // Regression: onImage used to live in chatStore's extraHandlers and dispatched
  // with the outer (stale) assistantId. onTurnStart can retarget the assistant
  // message id mid-stream, so the image-block landed on a non-existent id and
  // never rendered. It now lives here and must use currentAssistantId.
  it('dispatches image-block with the post-retarget id, not the stale one', () => {
    const dispatched: ChatAction[] = [];
    runChatStream({
      prompt: 'show the image',
      nodeId: 'n1',
      assistantId: 'STALE',
      dispatch: (a) => dispatched.push(a),
      assistantTextBufs: { current: {} },
      cancelFns: { current: {} },
    });

    const handlers = mockStream.mock.calls[0][2];
    // Backend reports the real assistant id for this turn.
    handlers.onTurnStart({ assistantId: 'FRESH', turnId: 't1', nodeId: 'n1', userText: '' });
    handlers.onImage({ path: '.contexts/x.png', mimeType: 'image/png', size: 10 });

    const img = dispatched.find((a) => a.type === 'image-block') as
      | Extract<ChatAction, { type: 'image-block' }>
      | undefined;
    expect(img).toBeTruthy();
    expect(img!.assistantId).toBe('FRESH'); // NOT 'STALE'
    expect(img!.path).toBe('.contexts/x.png');
    expect(img!.size).toBe(10);
  });
});
