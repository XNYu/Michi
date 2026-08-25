import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeClaudeSdkSpike, isClaudeAgentSdkEnabled } from '../src/agents/claude/claudeSdkSpike';
import { CLAUDE_DESCRIPTOR } from '../src/agents/capabilityDescriptors';

describe('Claude Agent SDK spike', () => {
  test('default flag is off and does not replace ClaudeRuntime', async () => {
    assert.equal(isClaudeAgentSdkEnabled({}), false);
    const status = await describeClaudeSdkSpike({});
    assert.equal(status.enabled, false);
    assert.equal(status.replacesClaudeRuntime, false);
    assert.equal(status.teamsAvailable, false);
    assert.equal(status.packageLoaded, false);
  });

  test('flag on without package still keeps ClaudeRuntime and no Teams', async () => {
    const status = await describeClaudeSdkSpike({ MICHI_CLAUDE_AGENT_SDK: '1' });
    assert.equal(status.enabled, true);
    assert.equal(status.replacesClaudeRuntime, false);
    assert.equal(status.teamsAvailable, false);
    assert.equal(CLAUDE_DESCRIPTOR.steer.availability, 'invisible');
    assert.equal(CLAUDE_DESCRIPTOR.subagents.availability, 'inferred');
  });
});
