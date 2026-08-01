import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClaudeModelEntry,
  CLAUDE_MODEL_CATALOG,
  UNKNOWN_CLAUDE_MODEL_FALLBACK,
} from '../src/agents/claude/claudeModelCatalog';

describe('claudeModelCatalog', () => {
  // ── Case 1: known sonnet model returns entry without fallback ─────────────

  test('getClaudeModelEntry returns entry and isFallback=false for sonnet alias', () => {
    const { entry, isFallback } = getClaudeModelEntry('sonnet');
    assert.equal(isFallback, false);
    assert.ok(entry, 'entry must be defined');
    assert.equal(entry.contextWindow, 1_000_000);
    // Cost tracking disabled — all rates are zero
    assert.equal(entry.rates.input, 0);
    assert.equal(entry.rates.output, 0);
    assert.equal(entry.rates.cacheCreation, 0);
    assert.equal(entry.rates.cacheRead, 0);
  });

  // ── Case 2: unknown model returns fallback ────────────────────────────────

  test('getClaudeModelEntry returns UNKNOWN_CLAUDE_MODEL_FALLBACK and isFallback=true for an unknown model', () => {
    const { entry, isFallback } = getClaudeModelEntry('claude-unknown-model');
    assert.equal(isFallback, true);
    assert.deepEqual(entry, UNKNOWN_CLAUDE_MODEL_FALLBACK);
  });

  // ── Case 3: concrete Claude CLI model ids map back to known aliases ───────

  test('getClaudeModelEntry maps concrete Claude CLI model ids without fallback', () => {
    const opus = getClaudeModelEntry('claude-opus-4-7-20250514');
    assert.equal(opus.isFallback, false);
    assert.equal(opus.entry, CLAUDE_MODEL_CATALOG.opus);
    assert.equal(opus.entry.contextWindow, 1_000_000);

    // Newer minor versions within the 4.x line map to the same tier entry
    // (regression: claude-opus-4-8 used to drop to the fallback rates).
    const opusNext = getClaudeModelEntry('claude-opus-4-8[1m]');
    assert.equal(opusNext.isFallback, false);
    assert.equal(opusNext.entry, CLAUDE_MODEL_CATALOG.opus);

    const sonnet = getClaudeModelEntry('claude-sonnet-4-6-extended-thinking');
    assert.equal(sonnet.isFallback, false);
    assert.equal(sonnet.entry, CLAUDE_MODEL_CATALOG.sonnet);
    assert.equal(sonnet.entry.contextWindow, 1_000_000);

    const haiku = getClaudeModelEntry('claude-haiku-4-5-20251001');
    assert.equal(haiku.isFallback, false);
    assert.equal(haiku.entry, CLAUDE_MODEL_CATALOG.haiku);
    assert.equal(haiku.entry.contextWindow, 200_000);
  });

  // ── Case 4: catalog entries have expected context windows ─────────────────

  test('catalog entries have expected context windows', () => {
    assert.equal(CLAUDE_MODEL_CATALOG.opus.contextWindow, 1_000_000);
    assert.equal(CLAUDE_MODEL_CATALOG.sonnet.contextWindow, 1_000_000);
    assert.equal(CLAUDE_MODEL_CATALOG.haiku.contextWindow, 200_000);
    assert.equal(UNKNOWN_CLAUDE_MODEL_FALLBACK.contextWindow, 200_000);
  });

  // ── Case 5: all rate fields are finite non-negative numbers ────────────────
  // Cost tracking is disabled for Claude runtime; rates are zero.

  test('all catalog entries have finite non-negative rate fields', () => {
    const allEntries = [
      ...Object.entries(CLAUDE_MODEL_CATALOG).map(([name, entry]) => ({ name, entry })),
      { name: 'UNKNOWN_FALLBACK', entry: UNKNOWN_CLAUDE_MODEL_FALLBACK },
    ];

    for (const { name, entry } of allEntries) {
      const { input, output, cacheCreation, cacheRead } = entry.rates;
      assert.ok(Number.isFinite(input) && input >= 0, `${name}.rates.input must be finite non-negative, got ${input}`);
      assert.ok(Number.isFinite(output) && output >= 0, `${name}.rates.output must be finite non-negative, got ${output}`);
      assert.ok(
        Number.isFinite(cacheCreation) && cacheCreation >= 0,
        `${name}.rates.cacheCreation must be finite non-negative, got ${cacheCreation}`,
      );
      assert.ok(
        Number.isFinite(cacheRead) && cacheRead >= 0,
        `${name}.rates.cacheRead must be finite non-negative, got ${cacheRead}`,
      );
    }
  });
});
