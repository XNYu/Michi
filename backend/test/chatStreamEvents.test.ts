import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTurnEvent, CHAT_STREAM_EVENTS, createDurableTurn, encodeChatStreamEvent, parseChatStreamEvent } from 'michi-shared';
import { createTranslator } from 'michi-runtime/internal/adapters/claude/claudeEventTranslator';
import { createChatStreamError, finalTerminalEvent, toChatStreamEvent } from '../src/routes/chatStreamEvents';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { log } from '../src/services/logger';
import { __resetHostEventWarnings } from '../src/agents/hostEvents';

describe('chatStreamEvents route mapping', () => {
  test('maps representative NormalizedEvents to wire events', () => {
    const cases: Array<{ input: NormalizedEvent; expected: ReturnType<typeof toChatStreamEvent> }> = [
      {
        input: { kind: 'chunk', text: 'hello' },
        expected: { event: CHAT_STREAM_EVENTS.chunk, data: { text: 'hello' } },
      },
      {
        input: { kind: 'host_event', type: 'branch_overview', payload: { overview: 'Current branch state.' } },
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
          kind: 'tool_call_update',
          toolCallId: 'crew-row-1',
          title: 'michi_call_tool',
          status: 'completed',
          inputJson: '{"tool":"read_page","arguments":{"pageId":"page-1"}}',
          output: '{"id":"page-1"}',
        },
        expected: {
          event: CHAT_STREAM_EVENTS.toolCallUpdate,
          data: {
            toolCallId: 'crew-row-1',
            title: 'michi_call_tool',
            status: 'completed',
            kind: undefined,
            detail: undefined,
            inputJson: '{"tool":"read_page","arguments":{"pageId":"page-1"}}',
            output: '{"id":"page-1"}',
          },
        },
      },
      {
        input: {
          kind: 'usage_summary',
          contextUsagePercentage: 12.5,
          totalCredits: 0,
          turnDurationMs: 9700,
          source: 'native',
          totalTokens: 1534,
          inputTokens: 1234,
          cachedInputTokens: 800,
          outputTokens: 300,
          reasoningOutputTokens: 120,
        },
        expected: {
          event: CHAT_STREAM_EVENTS.usageSummary,
          data: {
            contextUsagePercentage: 12.5,
            totalCredits: 0,
            turnDurationMs: 9700,
            source: 'native',
            totalTokens: 1534,
            inputTokens: 1234,
            cachedInputTokens: 800,
            outputTokens: 300,
            reasoningOutputTokens: 120,
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

  test('maps Michi host events to the wire events their type names, field for field', () => {
    const topics = [{ title: 'Alpha', prompt: 'Explore alpha', chatId: 'chat-a', nodeId: 'node-a' }];
    const cases: Array<{ input: NormalizedEvent; expected: ReturnType<typeof toChatStreamEvent>; frame: string }> = [
      {
        input: { kind: 'host_event', type: 'spawn_branches', payload: { topics } },
        expected: { event: CHAT_STREAM_EVENTS.spawnBranches, data: { topics } },
        frame: 'event: spawn_branches\ndata: {"topics":[{"title":"Alpha","prompt":"Explore alpha","chatId":"chat-a","nodeId":"node-a"}]}\n\n',
      },
      {
        input: { kind: 'host_event', type: 'branch_overview', payload: { overview: 'Current branch state.' } },
        expected: { event: CHAT_STREAM_EVENTS.branchOverview, data: { overview: 'Current branch state.' } },
        frame: 'event: branch_overview\ndata: {"overview":"Current branch state."}\n\n',
      },
      {
        input: { kind: 'host_event', type: 'follow_ups', payload: { followUps: ['First?', 'Second?'] } },
        expected: { event: CHAT_STREAM_EVENTS.followUps, data: { followUps: ['First?', 'Second?'] } },
        frame: 'event: follow_ups\ndata: {"followUps":["First?","Second?"]}\n\n',
      },
      {
        input: { kind: 'host_event', type: 'follow_ups_status', payload: { status: 'completed' } },
        expected: { event: CHAT_STREAM_EVENTS.followUpsStatus, data: { status: 'completed' } },
        frame: 'event: follow_ups_status\ndata: {"status":"completed"}\n\n',
      },
      {
        input: { kind: 'host_event', type: 'artifact_saved', payload: { contextId: 'ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 10 } },
        expected: { event: CHAT_STREAM_EVENTS.artifactSaved, data: { contextId: 'ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 10 } },
        frame: 'event: artifact_saved\ndata: {"contextId":"ctx-1","name":"notes","filePath":".contexts/notes.md","size":10}\n\n',
      },
      {
        input: { kind: 'host_event', type: 'artifact_updated', payload: { name: 'notes', filePath: '.contexts/notes.md' } },
        expected: { event: CHAT_STREAM_EVENTS.artifactUpdated, data: { contextId: undefined, name: 'notes', filePath: '.contexts/notes.md', size: undefined } },
        frame: 'event: artifact_updated\ndata: {"name":"notes","filePath":".contexts/notes.md"}\n\n',
      },
      {
        input: { kind: 'host_event', type: 'image', payload: { path: 'chart.png', mimeType: 'image/png', size: 16 } },
        expected: { event: CHAT_STREAM_EVENTS.image, data: { path: 'chart.png', caption: undefined, mimeType: 'image/png', size: 16 } },
        frame: 'event: image\ndata: {"path":"chart.png","mimeType":"image/png","size":16}\n\n',
      },
    ];

    for (const { input, expected, frame } of cases) {
      const wire = toChatStreamEvent(input);
      assert.deepEqual(wire, expected);
      assert.ok(wire);
      assert.equal(encodeChatStreamEvent(wire), frame);
    }
  });

  test('drops host events Michi cannot decode', (t) => {
    __resetHostEventWarnings();
    const warn = t.mock.method(log, 'warn', () => {});
    assert.equal(toChatStreamEvent({ kind: 'host_event', type: 'unknown_product_event', payload: {} }), null);
    assert.equal(toChatStreamEvent({ kind: 'host_event', type: 'branch_overview', payload: { overview: 7 } }), null);
    assert.equal(warn.mock.callCount(), 2);
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

  test('preserves a complete input snapshot on a tool update through the wire parser', () => {
    const inputJson = JSON.stringify({ file_path: '/tmp/app.ts', content: 'new contents' });
    const wire = toChatStreamEvent({
      kind: 'tool_call_update', toolCallId: 'write-1', title: 'Write', status: 'in_progress',
      kindType: 'tool', detail: 'Update the app', inputJson,
    });
    const parsed = parseChatStreamEvent(wire.event, JSON.stringify(wire.data));

    assert.equal(parsed?.event, CHAT_STREAM_EVENTS.toolCallUpdate);
    assert.equal(parsed?.event === CHAT_STREAM_EVENTS.toolCallUpdate && parsed.data.inputJson, inputJson);
  });

  test('Claude informational warnings survive wire parsing and durable replay without failing a successful answer', () => {
    const emitted: NormalizedEvent[] = [];
    const translator = createTranslator((event) => emitted.push(event));
    const content = 'Model "restricted-configured-model" is restricted by your organization\'s settings. Using claude-opus-5-5[1m] instead.';
    let snapshot = createDurableTurn({
      turnId: 'warning-turn', assistantId: 'warning-assistant', nodeId: 'warning-node',
      workspaceId: 'warning-workspace', displayUserText: 'Continue the answer', startedAt: 1,
    });
    let applied = 0;
    const replayEmitted = () => {
      for (; applied < emitted.length; applied++) {
        const wire = toChatStreamEvent(emitted[applied]);
        assert.ok(wire);
        const parsed = parseChatStreamEvent(wire.event, JSON.stringify({ ...wire.data, seq: applied + 1 }));
        assert.ok(parsed);
        snapshot = applyTurnEvent(snapshot, parsed);
      }
    };

    translator.feed({ type: 'system', subtype: 'informational', level: 'warning', isMeta: false, content });
    replayEmitted();
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.assistantMessage.content, '');
    assert.deepEqual(snapshot.assistantMessage.metadata?.warnings, [{
      source: 'claude-cli', category: 'runtime', code: 'informational', message: content,
      serverName: undefined, seq: 1,
    }]);
    const warningSnapshot = snapshot;

    translator.feed({ type: 'stream_event', event: {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer completed normally.' },
    } });
    translator.feed({ type: 'result', subtype: 'success' });
    replayEmitted();

    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.stopReason, 'end_turn');
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.assistantMessage.content, 'Answer completed normally.');
    assert.equal(snapshot.lastAppliedSeq, emitted.length);
    assert.deepEqual(snapshot.assistantMessage.metadata?.warnings, warningSnapshot.assistantMessage.metadata?.warnings);
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
