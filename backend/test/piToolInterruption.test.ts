import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interruptedToolResult, PI_CLOSED_TOOL_NOTE, PI_STOPPED_TOOL_NOTE, PI_UNFINISHED_TOOL_NOTE, unfinishedToolResults,
} from '../src/agents/pi/piToolInterruption';

const aborted = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };
const failed = { content: [{ type: 'text', text: 'This operation was aborted' }] };

test('a tool that failed after Stop is reported with an unknown outcome and its own output kept', () => {
  const result = interruptedToolResult({ result: failed, isError: true }, aborted());
  assert.equal(result?.isError, true);
  assert.equal(result?.content[0].text, `${PI_STOPPED_TOOL_NOTE}\n\nOutput before the stop:\nThis operation was aborted`);
  // Michi tools report expected failures in the result itself.
  assert.ok(interruptedToolResult({ result: { ...failed, isError: true }, isError: false }, aborted()));
  assert.equal(interruptedToolResult({ result: { content: [] }, isError: true }, aborted())?.content[0].text, PI_STOPPED_TOOL_NOTE);
});

test('a tool cut off because Michi closed the session is not reported as the user stopping it', () => {
  const result = interruptedToolResult({ result: failed, isError: true }, aborted(), 'session');
  assert.equal(result?.content[0].text, `${PI_CLOSED_TOOL_NOTE}\n\nOutput before the stop:\nThis operation was aborted`);
  assert.doesNotMatch(PI_CLOSED_TOOL_NOTE, /The user stopped/);
  assert.match(PI_CLOSED_TOOL_NOTE, /outcome is unknown/);
});

test('a tool keeps its own result when it finished before Stop, or when nothing was stopped', () => {
  assert.equal(interruptedToolResult({ result: { content: [{ type: 'text', text: 'wrote 3 lines' }] }, isError: false }, aborted()), undefined);
  assert.equal(interruptedToolResult({ result: failed, isError: true }, new AbortController().signal), undefined);
  assert.equal(interruptedToolResult({ result: failed, isError: true }), undefined);
});

test('only the calls the last reply left unanswered get an unknown-outcome result', () => {
  const reply = (calls: string[], stopReason = 'toolUse') => ({ role: 'assistant', stopReason,
    content: [{ type: 'text', text: 'working' }, ...calls.map((id) => ({ type: 'toolCall', id, name: `tool-${id}`, arguments: {} }))] });
  const answered = (id: string) => ({ role: 'toolResult', toolCallId: id, toolName: `tool-${id}`, content: [] });

  const results = unfinishedToolResults([
    { role: 'user', content: 'go' }, reply(['old']), // an older orphan is not this restore's to answer
    { role: 'user', content: 'again' }, reply(['a', 'b', 'c']), answered('a'),
  ]);
  assert.deepEqual(results.map((result) => [result.toolCallId, result.toolName, result.isError, result.content[0].text]), [
    ['b', 'tool-b', true, PI_UNFINISHED_TOOL_NOTE],
    ['c', 'tool-c', true, PI_UNFINISHED_TOOL_NOTE],
  ]);
  assert.deepEqual(unfinishedToolResults([reply(['a']), answered('a')]), []);
  assert.deepEqual(unfinishedToolResults([{ role: 'user', content: 'only a prompt' }]), []);
  // A reply that ended aborted or in error is dropped before the model; results for it would be orphans.
  assert.deepEqual(unfinishedToolResults([reply(['x'], 'aborted')]), []);
  assert.deepEqual(unfinishedToolResults([reply(['x'], 'error')]), []);
});
