import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeFollowUpsHookPocSettings } from '../src/adapters/claude/claudeFollowUpsHookPoc';

describe('Claude follow-ups Stop-hook POC config', () => {
  test('builds an inline Stop mcp_tool hook for the Michi validator', () => {
    const settings = JSON.parse(buildClaudeFollowUpsHookPocSettings());
    assert.deepEqual(settings, {
      hooks: {
        Stop: [{
          hooks: [{
            type: 'mcp_tool',
            server: '__michi_internal__',
            tool: 'validate_turn_metadata',
            input: {},
          }],
        }],
      },
    });
  });
});
