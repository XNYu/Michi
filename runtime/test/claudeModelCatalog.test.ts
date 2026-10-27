import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getClaudeModelEntry } from '../src/adapters/claude/claudeModelCatalog';

describe('claudeModelCatalog', () => {
  test('provider-prefixed ids and explicit extended windows retain the context budget', () => {
    assert.equal(getClaudeModelEntry('global.anthropic.claude-opus-5-5[1m]').entry.contextWindow, 1_000_000);
    assert.equal(getClaudeModelEntry('claude-new-model[1m]').entry.contextWindow, 1_000_000);
    assert.equal(getClaudeModelEntry('claude-haiku-4-5[1m]').entry.contextWindow, 1_000_000);
  });
});
