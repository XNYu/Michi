import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpsMetadataOutputMode } from '../src/agents/followUpsExperiment';

test('stable metadata output selects hybrid body follow-ups for sentinel Hook mode', () => {
  assert.equal(followUpsMetadataOutputMode(true, 'hook-tool'), 'structured-tool');
  assert.equal(
    followUpsMetadataOutputMode(true, 'sentinel'),
    'sentinel-followups-tool-overview',
  );
  assert.equal(followUpsMetadataOutputMode(false, 'hook-tool'), 'sentinel');
});
