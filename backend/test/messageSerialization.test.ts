import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBranchOverview, stripSentinelsStreamingSafe } from '../src/services/messageSerialization';

describe('branch overview message metadata', () => {
  test('uses the final completed overview sentinel and removes it from persisted text', () => {
    const raw = [
      'Body.',
      '[BRANCH-OVERVIEW: quoted example]',
      '[BRANCH-OVERVIEW: final durable state]',
    ].join('\n');

    assert.equal(extractBranchOverview(raw), 'final durable state');
    assert.equal(stripSentinelsStreamingSafe(raw), 'Body.\n');
  });

  test('ignores missing, empty, and incomplete overview sentinels', () => {
    assert.equal(extractBranchOverview('No metadata'), null);
    assert.equal(extractBranchOverview('[BRANCH-OVERVIEW: ]'), null);
    assert.equal(extractBranchOverview('[BRANCH-OVERVIEW: unfinished'), null);
  });
});
