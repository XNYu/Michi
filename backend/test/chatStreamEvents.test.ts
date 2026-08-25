import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_STREAM_EVENTS } from 'michi-shared';
import { createChatStreamError, finalTerminalEvent, toChatStreamEvent } from '../src/routes/chatStreamEvents';
import type { NormalizedEvent } from '../src/services/chatEvents';

describe('chatStreamEvents route mapping', () => {
  test('maps representative NormalizedEvents to wire events', () => {
    const cases: Array<{ input: NormalizedEvent; expected: ReturnType<typeof toChatStreamEvent> }> = [
      {
        input: { kind: 'chunk', text: 'hello' },
        expected: { event: CHAT_STREAM_EVENTS.chunk, data: { text: 'hello' } },
      },
      {
        input: { kind: 'branch_overview', overview: 'Current branch state.' },
        expected: {
          event: CHAT_STREAM_EVENTS.branchOverview,
          data: { overview: 'Current branch state.' },
        },
      },
      {
        input: {
          kind: 'tool_call',
          toolCallId: 'tc_1',
          title: 'Read file',
          status: 'in_progress',
          kindType: 'read',
          detail: 'src/index.ts',
        },
        expected: {
          event: CHAT_STREAM_EVENTS.toolCall,
          data: {
            toolCallId: 'tc_1',
            title: 'Read file',
            status: 'in_progress',
            kind: 'read',
            detail: 'src/index.ts',
            inputJson: undefined,
          },
        },
      },
      {
        input: {
          kind: 'permission_request',
          requestId: 9,
          toolCallId: 'tc_1',
          title: 'Allow command?',
          detail: 'Command: npm test',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }],
        },
        expected: {
          event: CHAT_STREAM_EVENTS.permissionRequest,
          data: {
            requestId: 9,
            toolCallId: 'tc_1',
            title: 'Allow command?',
            detail: 'Command: npm test',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }],
          },
        },
      },
    ];

    for (const { input, expected } of cases) {
      assert.deepEqual(toChatStreamEvent(input), expected);
    }
  });

  test('maps HEP v2 events without replacing old names', () => {
    assert.deepEqual(toChatStreamEvent({ kind: 'cancel_phase', phase: 'requested' }), {
      event: CHAT_STREAM_EVENTS.cancelPhase,
      data: { phase: 'requested' },
    });
    assert.deepEqual(toChatStreamEvent({ kind: 'steer_accepted', text: 'inject', pending: true }), {
      event: CHAT_STREAM_EVENTS.steerAccepted,
      data: { text: 'inject', pending: true },
    });
  });

  test('maps turn_end to done', () => {
    assert.deepEqual(toChatStreamEvent({ kind: 'turn_end', stopReason: 'end_turn' }), {
      event: CHAT_STREAM_EVENTS.done,
      data: { stopReason: 'end_turn' },
    });
  });

  test('creates error wire events', () => {
    assert.deepEqual(createChatStreamError('boom'), {
      event: CHAT_STREAM_EVENTS.error,
      data: { message: 'boom' },
    });
  });
});

describe('finalTerminalEvent — guaranteed terminal frame', () => {
  // The message route MUST write exactly one terminal frame before res.end().
  // Without this guarantee, a turn that ends without a turn_end (e.g. the
  // event queue closes, or the loop breaks on client abort) leaves the
  // client's assistant node pinned in "streaming" forever.

  test('returns null when a terminal frame was already written', () => {
    assert.equal(finalTerminalEvent({ wroteTerminal: true, aborted: false }), null);
    assert.equal(finalTerminalEvent({ wroteTerminal: true, aborted: true }), null);
  });

  test('returns a done(cancel) frame when aborted without a terminal frame', () => {
    assert.deepEqual(finalTerminalEvent({ wroteTerminal: false, aborted: true }), {
      event: CHAT_STREAM_EVENTS.done,
      data: { stopReason: 'cancel' },
    });
  });

  test('returns an error frame when the turn ends without a terminal frame', () => {
    const ev = finalTerminalEvent({ wroteTerminal: false, aborted: false });
    assert.equal(ev?.event, CHAT_STREAM_EVENTS.error);
  });
});
