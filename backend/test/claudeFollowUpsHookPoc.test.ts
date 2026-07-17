import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeFollowUpsHookPocInstruction,
  buildClaudeFollowUpsHookPocSettings,
  CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION,
  isClaudeFollowUpsHookPocEnabled,
} from '../src/agents/claude/claudeFollowUpsHookPoc';

describe('Claude follow-ups Stop-hook POC config', () => {
  test('is opt-in and accepts common truthy environment values', () => {
    assert.equal(isClaudeFollowUpsHookPocEnabled({}), false);
    assert.equal(isClaudeFollowUpsHookPocEnabled({ MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: '1' }), true);
    assert.equal(isClaudeFollowUpsHookPocEnabled({ MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: 'TRUE' }), true);
    assert.equal(isClaudeFollowUpsHookPocEnabled({ MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC: 'off' }), false);
  });

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

  test('defaults to sentinel follow-ups while keeping Overview in the Hook', () => {
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /set_branch_overview/);
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /Do not call set_follow_ups/);
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /Never emit a \[BRANCH-OVERVIEW/);
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /FOLLOW-UP n\/3/);
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /after \[FOLLOW-UP 3\/3/);
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /emit no more visible text/);
    assert.match(CLAUDE_FOLLOW_UPS_HOOK_POC_INSTRUCTION, /validate_turn_metadata/);
  });

  test('hook-tool control mode instructs Claude to call set_follow_ups', () => {
    const instruction = buildClaudeFollowUpsHookPocInstruction('hook-tool');
    assert.match(instruction, /call the MCP tool .*set_follow_ups/);
    assert.doesNotMatch(instruction, /Do not call set_follow_ups/);
    assert.match(instruction, /Do not duplicate the follow-ups/);
    assert.match(instruction, /Do not duplicate the overview/);
    assert.doesNotMatch(instruction, /\[FOLLOW-UP/);
    assert.doesNotMatch(instruction, /\[BRANCH-OVERVIEW:/);
    assert.doesNotMatch(instruction, /Keep emitting the existing/);
  });
});
