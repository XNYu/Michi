import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_KEYS } from 'michi-shared';
import {
  CREW_DESCRIPTOR,
  describeRuntimeCapabilities,
  KIRO_DESCRIPTOR,
  UNKNOWN_DESCRIPTOR,
} from '../src/agents/capabilityDescriptors';

const RUNTIMES = ['pi', 'codex', 'claude', 'kiro', 'crew'] as const;

describe('capabilityDescriptor', () => {
  test('every registered runtime has all capability slots', () => {
    for (const id of RUNTIMES) {
      const descriptor = describeRuntimeCapabilities(id);
      for (const key of CAPABILITY_KEYS) {
        assert.equal(typeof descriptor[key].availability, 'string', `${id}.${key}`);
        assert.equal(typeof descriptor[key].confidence, 'string', `${id}.${key}`);
      }
    }
  });

  test('crew keeps Kiro basics; compaction goes through its Gateway, and App callers cannot steer', () => {
    assert.equal(describeRuntimeCapabilities('kiro'), KIRO_DESCRIPTOR);
    assert.equal(describeRuntimeCapabilities('crew'), CREW_DESCRIPTOR);
    assert.equal(KIRO_DESCRIPTOR.compact.availability, 'native');
    // Gateway /compact on the App's own idle slot, not Kiro's private extension.
    assert.equal(CREW_DESCRIPTOR.compact.availability, 'native');
    assert.equal(CREW_DESCRIPTOR.compact.confidence, 'projected');
    assert.equal(CREW_DESCRIPTOR.steer.availability, 'invisible');
  });

  test('unregistered runtime ids fall back to the unknown descriptor', () => {
    for (const id of ['nope', 'constructor', '__proto__']) {
      assert.equal(describeRuntimeCapabilities(id), UNKNOWN_DESCRIPTOR, id);
    }
  });
});
