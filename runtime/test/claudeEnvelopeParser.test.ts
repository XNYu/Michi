import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeEnvelopeParser, ClaudeEnvelope } from '../src/adapters/claude/claudeEnvelopeParser';

describe('claudeEnvelopeParser', () => {

  // ── Case 4: skips blank lines ─────────────────────────────────────────────

  test('skips blank lines between valid JSON objects', () => {
    const emitted: ClaudeEnvelope[] = [];
    const parser = createClaudeEnvelopeParser((e) => emitted.push(e));

    parser.push('{"ok":true}\n\n\n{"ok":false}\n');

    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0], { ok: true });
    assert.deepEqual(emitted[1], { ok: false });
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
