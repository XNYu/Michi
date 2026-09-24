import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KiroSteeringParser, MAX_STEERING_REPORT_LENGTH, extractKiroSteering,
  applyTurnEvent, createDurableTurn, parseChatStreamEvent, encodeChatStreamEvent,
  type SteeringSegment,
} from 'michi-shared';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { toChatStreamEvent } from '../src/routes/chatStreamEvents';
import { contentFromIncomingMessage } from '../src/services/messageSerialization';

const id = 'steer-c3999cf6ce9f462cb72019fcc3fb5368';
const idV3 = 'steer-3fc25d3d-a0d5-469e-a60e-e063001188d2';
const marker = (text = 'Changed the recommendation to cobalt.', messageId = id) => `[STEERING ${messageId}: ${text}]`;
function collect(segments: SteeringSegment[]) {
  return {
    text: segments.flatMap((segment) => segment.kind === 'text' ? [segment.text] : []).join(''),
    reports: segments.flatMap((segment) => segment.kind === 'report' ? [segment.report] : []),
  };
}

test('both native ID formats parse identically at every chunk boundary without leaking prefixes', () => {
  for (const messageId of [id, idV3]) {
    const raw = `Answer.\n\n${marker('Changed [blue] to cobalt.', messageId)}\n\nNext paragraph.`;
    const expected = { text: 'Answer.\n\n\n\nNext paragraph.', reports: [{ messageId, text: 'Changed [blue] to cobalt.', complete: true }] };
    for (let split = 0; split <= raw.length; split++) {
      const parser = new KiroSteeringParser();
      const first = parser.push(raw.slice(0, split));
      assert.ok(!collect(first).text.includes('[STEER'));
      assert.deepEqual(collect([...first, ...parser.push(raw.slice(split)), ...parser.finish()]), expected);
    }
    const parser = new KiroSteeringParser();
    assert.deepEqual(collect([...Array.from(raw).flatMap((ch) => parser.push(ch)), ...parser.finish()]), expected);
  }
});

test('multiple reports, CRLF, multiline descriptions, and escaped brackets', () => {
  const result = extractKiroSteering(`${marker('Line one\r\nLine two with \\].')}\r\n${marker('Second note.', idV3)}`);
  assert.equal(result.text, '\r\n');
  assert.deepEqual(result.reports.map((r) => r.text), ['Line one\r\nLine two with \\].', 'Second note.']);
});

test('code fences, indented code, blockquotes, inline examples, and non-native IDs stay intact', () => {
  const raw = [
    '```text', marker(), '```',
    '~~~~', '```', marker(), '~~~~',
    `    ${marker()}`, `\t${marker()}`, `> ${marker()}`, `Example: ${marker()}`,
    `\`${marker()}\``, `\\${marker()}`, '[STEERING <id>: example]', '[STEERING steer-example: example]',
  ].join('\n');
  const parser = new KiroSteeringParser();
  assert.deepEqual(collect([...Array.from(raw).flatMap((ch) => parser.push(ch)), ...parser.finish()]), { text: raw, reports: [] });
  assert.equal(extractKiroSteering(`${raw}\n${marker()}`).reports.length, 1);
});

test('ordinary bracket prefixes are released; incomplete native reports are separate and unverified', () => {
  for (const raw of ['[', '[STEER', '[STEERING rules]', '[STEERING steer-bad: prose]']) {
    assert.deepEqual(extractKiroSteering(raw), { text: raw, reports: [] });
  }
  const result = extractKiroSteering(`Answer\n[STEERING ${id}: Interrupted`);
  assert.equal(result.text, 'Answer\n');
  assert.deepEqual(result.reports, [{ messageId: id, text: 'Interrupted', complete: false }]);
});

test('malformed markers cannot swallow later paragraphs or retain unbounded text', () => {
  const result = extractKiroSteering(`[STEERING ${id}: unfinished\n\nVisible answer.`);
  assert.equal(result.reports[0].complete, false);
  assert.equal(result.text, '\nVisible answer.');
  const overflow = extractKiroSteering(`[STEERING ${id}: ${'x'.repeat(MAX_STEERING_REPORT_LENGTH * 2)}\nNext.`);
  assert.equal(overflow.reports[0].complete, false);
  assert.ok(overflow.reports[0].text.length <= MAX_STEERING_REPORT_LENGTH);
  assert.ok(overflow.text.endsWith('\nNext.'));
  assert.ok(overflow.text.length > MAX_STEERING_REPORT_LENGTH);
});

for (const ending of ['done', 'cancel', 'error', 'eof'] as const) {
  test(`Kiro translates ACP text into separate reports before ${ending}, including codec and durable replay`, async () => {
    const client = {
      async *prompt() {
        const raw = `Answer.\n${ending === 'done' ? marker() : `[STEERING ${id}: Partial explanation`}`;
        for (const ch of raw) yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ch } };
        if (ending === 'error') throw new Error('Test connection closed');
        if (ending !== 'eof') yield { sessionUpdate: 'turn_end', stopReason: ending === 'cancel' ? 'cancelled' : 'end_turn' };
      },
    };
    const runtime = { ensureClient: async () => client, getCurrentMode: () => null, getCurrentModel: () => null } as unknown as KiroRuntime;
    const session = new KiroSession('n', 's', runtime, '/tmp');
    const events = [];
    try { for await (const ev of session.send('question')) events.push(ev); }
    catch { assert.equal(ending, 'error'); }
    assert.equal(events.filter((ev) => ev.kind === 'chunk').map((ev) => ev.text).join(''), 'Answer.\n');
    const report = events.find((ev) => ev.kind === 'steering_report');
    assert.ok(report && report.kind === 'steering_report');
    assert.equal(report.reports[0].complete, ending === 'done');
    const frame = toChatStreamEvent(report);
    assert.ok(frame);
    assert.equal(frame.data.source, 'model');
    assert.equal(frame.data.confidence, 'unverified');
    const encoded = encodeChatStreamEvent(frame);
    assert.ok(encoded.includes('event: steering_report'));
    assert.deepEqual(parseChatStreamEvent(frame.event, JSON.stringify(frame.data)), frame);
    let turn = createDurableTurn({ turnId: 't', assistantId: 'a', nodeId: 'n', workspaceId: 'w', displayUserText: 'q', startedAt: 1 });
    turn = applyTurnEvent(turn, { event: 'chunk', data: { text: 'Answer.', seq: 1 } });
    turn = applyTurnEvent(turn, { ...frame, data: { ...frame.data, seq: 2 } } as typeof frame);
    const replayed = applyTurnEvent(turn, { ...frame, data: { ...frame.data, seq: 2 } } as typeof frame);
    assert.equal(turn, replayed);
    turn = applyTurnEvent(turn, { event: 'done', data: { stopReason: 'end_turn', seq: 3 } });
    assert.equal(turn.assistantMessage.content, 'Answer.');
    assert.deepEqual(turn.assistantMessage.metadata?.steeringReports, report.reports);
    assert.ok(!JSON.stringify(session.getHistory()).includes('[STEERING'));
  });
}

test('legacy serialization removes metadata from answers but not user examples', () => {
  assert.equal(contentFromIncomingMessage({ role: 'assistant', blocks: [{ kind: 'answer', rawText: `Answer\n${marker()}` }] }).trim(), 'Answer');
  assert.equal(contentFromIncomingMessage({ role: 'user', content: marker() }), marker());
});
