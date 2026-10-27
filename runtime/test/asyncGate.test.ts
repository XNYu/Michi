import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncGate } from '../src/core/asyncGate';

describe('AsyncGate', () => {
  it('close() is idempotent', () => {
    const gate = new AsyncGate();
    gate.close();
    gate.close();
    assert.equal(gate.isOpen, false);
  });
});
