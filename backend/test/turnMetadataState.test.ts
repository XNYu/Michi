import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnMetadataState } from '../src/agents/turnMetadataState';

test('metadata repairs once, normalizes values, and completes one visible boundary', () => {
  const state = new TurnMetadataState('hook-tool');
  assert.equal(state.validate(true).status, 'inactive');
  state.begin();
  const first = state.validate(true);
  assert.equal(first.status, 'repair');
  assert.deepEqual(first.missingTools, ['set_branch_overview', 'set_follow_ups']);
  assert.equal(first.response.decision, 'block');
  assert.match(String(first.response.reason), /Do not repeat the user-facing answer/);
  assert.equal(state.suppressOutput('chunk'), true);
  assert.equal(state.suppressOutput('thought'), true);
  assert.equal(state.suppressOutput('tool_call'), false);
  assert.equal(state.validate(true).status, 'fail_open');
  assert.equal(state.setFollowUps([' ', ' one? ', 'two?', 'three?', 'four?'], true)?.join(','), 'one?,two?,three?');
  assert.deepEqual(state.setOverview(' Current state. '), { overview: 'Current state.', beforeSentinelsComplete: false });
  assert.equal(state.validate(true).status, 'complete');
  assert.equal(state.completeOutputBoundary(), true);
  assert.equal(state.completeOutputBoundary(), false);
  assert.deepEqual(state.finish(), { chunks: 1, thoughts: 1 });
  assert.equal(state.validationActive, false);
  assert.equal(state.suppressOutput('chunk'), false);
  state.begin();
  assert.equal(state.validate(true).status, 'repair');
});

test('disabled follow-ups skip both output and repair requirements, retaining overview', () => {
  const state = new TurnMetadataState('hook-tool');
  state.begin();
  assert.equal(state.acceptsFollowUps(false), false);
  assert.equal(state.setFollowUps(['one?', 'two?', 'three?'], false), null);
  assert.equal(state.completeOutputBoundary(), false);
  assert.deepEqual(state.validate(false).missingTools, ['set_branch_overview']);
  state.setOverview('Overview only.');
  assert.deepEqual(state.validate(false).response, {});
});

test('sentinel mode recognizes split final markers before suppressing overview tail', () => {
  const state = new TurnMetadataState('sentinel');
  state.begin();
  assert.equal(state.setFollowUps(['one?'], true), null);
  assert.equal(state.setOverview('Earlier overview.')?.beforeSentinelsComplete, true);
  assert.equal(state.suppressOutput('chunk'), false);
  state.observeChunk('answer\n[FOLLOW-UP 3/', true);
  state.observeChunk('3: last?]', true);
  assert.equal(state.setOverview('Final overview.')?.beforeSentinelsComplete, false);
  assert.equal(state.suppressOutput('chunk'), true);
  assert.equal(state.suppressOutput('thought'), true);
  assert.equal(state.validate(true).status, 'complete');
  assert.deepEqual(state.finish(), { chunks: 1, thoughts: 1 });
});

test('sentinel detection is bounded and disabled follow-ups do not hide the answer tail', () => {
  const state = new TurnMetadataState('sentinel');
  state.begin();
  state.observeChunk('[FOLLOW-UP 3/3:', true);
  state.observeChunk('x'.repeat(12_000) + ' last?]', true);
  assert.equal(state.setOverview('No complete marker in the bounded tail.')?.beforeSentinelsComplete, true);
  assert.equal(state.suppressOutput('chunk'), false);
  state.finish();
  state.begin();
  state.observeChunk('[FOLLOW-UP 3/3: last?]', false);
  state.setOverview('No follow-ups requested.');
  assert.equal(state.suppressOutput('chunk'), false);
});
