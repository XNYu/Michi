import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeEnvelopeParser, ClaudeEnvelope } from '../src/agents/claude/claudeEnvelopeParser';

describe('claudeEnvelopeParser', () => {
  // ── Case 1: emits one envelope per complete line ──────────────────────────

  test('emits one envelope per complete newline-terminated line', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    parser.push('{"a":1}\n{"b":2}\n');

    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0], { a: 1 });
    assert.deepEqual(emitted[1], { b: 2 });
  });

  // ── Case 2: buffers partial last line until newline arrives ───────────────

  test('buffers partial last line and does not emit until newline arrives', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    parser.push('{"x":42}');
    assert.equal(emitted.length, 0, 'should not emit before newline');

    parser.push('\n');
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { x: 42 });
  });

  // ── Case 3: handles \n boundary mid-chunk ────────────────────────────────

  test('emits 2 envelopes when newline boundary splits two JSON objects across two pushes', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    parser.push('{"a":1}\n{"a":');
    assert.equal(emitted.length, 1, 'first complete line should emit immediately');

    parser.push('2}\n');
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0], { a: 1 });
    assert.deepEqual(emitted[1], { a: 2 });
  });

  // ── Case 4: skips blank lines ─────────────────────────────────────────────

  test('skips blank lines between valid JSON objects', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    parser.push('{"ok":true}\n\n\n{"ok":false}\n');

    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0], { ok: true });
    assert.deepEqual(emitted[1], { ok: false });
  });

  // ── Case 5: calls onError for malformed JSON without throwing ─────────────

  test('calls onError with the raw line for malformed JSON and does not throw', () => {
    const errors: Array<{ err: Error; raw: string }> = [];
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser(
      (e) => emitted.push(e),
      (err, raw) => errors.push({ err, raw }),
    );

    assert.doesNotThrow(() => parser.push('not-valid-json\n'));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].raw, 'not-valid-json');
    assert.ok(errors[0].err instanceof SyntaxError);
    assert.equal(emitted.length, 0);
  });

  // ── Case 6a: flush() emits trailing line if present ──────────────────────

  test('flush emits trailing buffered line that has no trailing newline', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    parser.push('{"flushed":true}');
    assert.equal(emitted.length, 0, 'nothing emitted before flush');

    parser.flush();
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { flushed: true });
  });

  // ── Case 6b: flush() is no-op if buffer is empty ─────────────────────────

  test('flush is a no-op when buffer is empty', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    assert.doesNotThrow(() => parser.flush());
    assert.equal(emitted.length, 0);
  });
});
