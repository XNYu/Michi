import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_KEYS, slot } from 'michi-shared';
import * as root from '../src';
import type { RuntimeDescriptor } from '../src';
import { descriptorOf, UNKNOWN_HARNESS, UNKNOWN_RUNTIME_DESCRIPTOR } from '../src/core/descriptors';

describe('runtime descriptors', () => {
  it('the package root exports the descriptor helpers', () => {
    assert.equal(root.descriptorOf, descriptorOf);
    assert.equal(root.UNKNOWN_HARNESS, UNKNOWN_HARNESS);
    assert.equal(root.UNKNOWN_RUNTIME_DESCRIPTOR, UNKNOWN_RUNTIME_DESCRIPTOR);
  });

  it('the unknown harness fills every capability slot', () => {
    assert.deepEqual(Object.keys(UNKNOWN_HARNESS), [...CAPABILITY_KEYS]);
    assert.equal(UNKNOWN_RUNTIME_DESCRIPTOR.harness, UNKNOWN_HARNESS);
    assert.equal(UNKNOWN_RUNTIME_DESCRIPTOR.run, null);
  });

  it('returns the instance descriptor', () => {
    const descriptor: RuntimeDescriptor = { ...UNKNOWN_RUNTIME_DESCRIPTOR, harness: { ...UNKNOWN_HARNESS, steer: slot('native', 'native') } };
    assert.equal(descriptorOf({ descriptor }), descriptor);
  });

  it('falls back to the unknown descriptor for an untyped runtime without one', () => {
    assert.equal(descriptorOf({}), UNKNOWN_RUNTIME_DESCRIPTOR);
    assert.equal(descriptorOf({ descriptor: null }), UNKNOWN_RUNTIME_DESCRIPTOR);
    // An untyped host may still pass a runtime that only has the removed capabilityDescriptor field.
    assert.equal(descriptorOf({ capabilityDescriptor: UNKNOWN_HARNESS } as {}), UNKNOWN_RUNTIME_DESCRIPTOR);
  });
});
