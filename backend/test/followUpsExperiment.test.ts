import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_UPS_SENTINEL_TURN_REMINDER,
  resolveFollowUpsExperimentMode,
} from '../src/agents/followUpsExperiment';

test('follow-ups experiment defaults to sentinel and accepts control aliases', () => {
  assert.equal(resolveFollowUpsExperimentMode({}), 'sentinel');
  assert.equal(resolveFollowUpsExperimentMode({ MICHI_FOLLOW_UPS_EXPERIMENT_MODE: 'sentinel' }), 'sentinel');
  assert.equal(resolveFollowUpsExperimentMode({ MICHI_FOLLOW_UPS_EXPERIMENT_MODE: 'hook-tool' }), 'hook-tool');
  assert.equal(resolveFollowUpsExperimentMode({ MICHI_FOLLOW_UPS_EXPERIMENT_MODE: 'TOOL' }), 'hook-tool');
});

test('sentinel reminder is strict and explicitly disables set_follow_ups', () => {
  assert.match(FOLLOW_UPS_SENTINEL_TURN_REMINDER, /do not call set_follow_ups/i);
  assert.match(FOLLOW_UPS_SENTINEL_TURN_REMINDER, /FOLLOW-UP 1\/3/);
  assert.match(FOLLOW_UPS_SENTINEL_TURN_REMINDER, /FOLLOW-UP 2\/3/);
  assert.match(FOLLOW_UPS_SENTINEL_TURN_REMINDER, /FOLLOW-UP 3\/3/);
  assert.match(FOLLOW_UPS_SENTINEL_TURN_REMINDER, /closing brackets/i);
});
