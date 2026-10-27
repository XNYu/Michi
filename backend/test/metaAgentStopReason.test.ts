import { KiroSignedOutError } from '../src/agents/kiro/kiroAuth';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyMetaAgentRunError, errorFirstLine } from '../src/services/metaAgent/stopReason';

const classify = (error: string, runtimeId = 'claude') => {
  const { reason, message } = classifyMetaAgentRunError(error, { runtimeId, workspaceName: 'rabbitholes' });
  return { reason, message };
};

describe('Meta agent stop reasons', () => {
  test('a CLI that is not installed names the runtime the error names', () => {
    assert.deepEqual(classify('codex binary not found. Tried: /usr/local/bin/codex, /home/u/.local/bin/codex. Install with: npm install -g @openai/codex, or set CODEX_CLI_BIN.'),
      { reason: 'runtime-missing', message: 'Codex is not installed on this computer' });
    assert.deepEqual(classify('claude binary not found. Tried: /usr/local/bin/claude. Install with: npm install -g @anthropic-ai/claude-code', 'codex'),
      { reason: 'runtime-missing', message: 'Claude is not installed on this computer' });
    assert.deepEqual(classify('kiro-cli not found (looked for /home/u/.local/bin/kiro-cli)', 'codex'),
      { reason: 'runtime-missing', message: 'Kiro is not installed on this computer' });
    assert.deepEqual(classify('spawn /home/u/.local/bin/kiro-cli ENOENT', 'kiro'),
      { reason: 'runtime-missing', message: 'Kiro is not installed on this computer' });
  });

  test('missing sign-in or API key, from each runtime\'s own message', () => {
    assert.deepEqual(classify('No claude auth found. Set ANTHROPIC_API_KEY, or run `claude /login`, or set CLAUDE_CODE_USE_BEDROCK=1 with AWS creds.'),
      { reason: 'signed-out', message: 'Claude is not signed in' });
    assert.deepEqual(classify('No Codex auth found. Expected /home/u/.codex/auth.json. Run `codex login` to authenticate.', 'claude'),
      { reason: 'signed-out', message: 'Codex is not signed in' });
    assert.deepEqual(classify('ExpiredTokenException: The security token included in the request is expired', 'kiro'),
      { reason: 'signed-out', message: 'Kiro is not signed in' });
    assert.deepEqual(classify('Invalid API key · Please run /login'), { reason: 'signed-out', message: 'Claude is not signed in' });
    assert.deepEqual(classify('Anthropic API key not configured', 'pi'), { reason: 'signed-out', message: 'Pi has no API key set up' });
  });

  test('Kiro startup and Crew readiness failures surface as signed out', () => {
    assert.equal(classify(new KiroSignedOutError().message, 'kiro').reason, 'signed-out');
    assert.equal(classify('Kiro CLI setup or sign-in is required', 'crew').reason, 'signed-out');
  });

  test('usage and rate limits', () => {
    assert.deepEqual(classify('Claude AI usage limit reached|1761234567'), { reason: 'quota', message: 'Claude reached its usage or rate limit' });
    assert.equal(classify('You\'ve hit your usage limit. Upgrade to Pro or try again later.', 'codex').message, 'Codex reached its usage or rate limit');
    assert.equal(classify('MonthlyRequestCount limit reached', 'kiro').reason, 'quota');
    assert.equal(classify('429 Too Many Requests', 'pi').reason, 'quota');
  });

  test('a batch the reader cannot read needs attention', () => {
    assert.deepEqual(classify('A pending maintenance source is no longer readable; progress retained'),
      { reason: 'needs-attention', message: 'A conversation in rabbitholes could not be read' });
  });

  test('anything else is reported by its first line, without the auto-pause suffix', () => {
    assert.deepEqual(classify('Maintenance plan has unfinished source decisions; progress retained. Paused after 5 failed runs in a row.'),
      { reason: 'other', message: 'Maintenance plan has unfinished source decisions; progress retained' });
    assert.deepEqual(classify('\n  The model refused\n    at stack (x.ts:1)'), { reason: 'other', message: 'The model refused' });
    assert.equal(classify('').message, 'The run stopped without an error message');
    assert.equal(errorFirstLine('x'.repeat(300)).length, 200);
  });
});
