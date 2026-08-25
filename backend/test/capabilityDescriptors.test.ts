import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_KEYS, shouldSteerInsteadOfQueue, usageIsUnverifiable } from 'michi-shared';
import {
  absorbAcpCapabilities,
  ANTIGRAVITY_DESCRIPTOR,
  CLAUDE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  describeRuntimeCapabilities,
  GROK_DESCRIPTOR,
  KIRO_DESCRIPTOR,
} from '../src/agents/capabilityDescriptors';

const RUNTIMES = ['pi', 'codex', 'claude', 'kiro', 'cursor', 'grok', 'antigravity'] as const;

describe('capabilityDescriptor', () => {
  test('every advertised runtime has all capability slots', () => {
    for (const id of RUNTIMES) {
      const descriptor = describeRuntimeCapabilities(id);
      for (const key of CAPABILITY_KEYS) {
        assert.equal(typeof descriptor[key].availability, 'string', `${id}.${key}`);
        assert.equal(typeof descriptor[key].confidence, 'string', `${id}.${key}`);
      }
    }
  });

  test('Claude and Antigravity do not advertise native steer', () => {
    assert.equal(CLAUDE_DESCRIPTOR.steer.availability, 'invisible');
    assert.equal(ANTIGRAVITY_DESCRIPTOR.steer.availability, 'invisible');
    assert.equal(ANTIGRAVITY_DESCRIPTOR.compact.availability, 'invisible');
    assert.equal(ANTIGRAVITY_DESCRIPTOR.permissions.availability, 'invisible');
    assert.equal(shouldSteerInsteadOfQueue(CLAUDE_DESCRIPTOR), false);
  });

  test('Codex advertises native steer and compact', () => {
    assert.equal(CODEX_DESCRIPTOR.steer.availability, 'native');
    assert.equal(CODEX_DESCRIPTOR.compact.availability, 'native');
    assert.equal(shouldSteerInsteadOfQueue(CODEX_DESCRIPTOR), true);
    assert.equal(CODEX_DESCRIPTOR.subagents.availability, 'invisible');
  });

  test('Pi without SDK flag stays native_unwired for steer', () => {
    const prev = process.env.MICHI_PI_SESSION_SDK;
    delete process.env.MICHI_PI_SESSION_SDK;
    try {
      const pi = describeRuntimeCapabilities('pi');
      assert.equal(pi.steer.availability, 'native_unwired');
      assert.equal(shouldSteerInsteadOfQueue(pi), false);
    } finally {
      if (prev === undefined) delete process.env.MICHI_PI_SESSION_SDK;
      else process.env.MICHI_PI_SESSION_SDK = prev;
    }
  });

  test('ACP absorption upgrades Kiro experimental slots without inventing Tangent', () => {
    const absorbed = absorbAcpCapabilities(KIRO_DESCRIPTOR, {
      loadSession: true,
      image: true,
      kiroCompaction: true,
      kiroTerminate: true,
    });
    assert.equal(absorbed.nativeResume.availability, 'native');
    assert.equal(absorbed.compact.availability, 'experimental');
    assert.equal(absorbed.subagents.availability, 'experimental');
    assert.equal(absorbed.steer.availability, 'invisible');
    assert.equal(CURSOR_DESCRIPTOR.compact.availability, 'invisible');
    assert.equal(GROK_DESCRIPTOR.steer.availability, 'invisible');
  });

  test('usage without native source is unverifiable', () => {
    assert.equal(usageIsUnverifiable('native', 12), false);
    assert.equal(usageIsUnverifiable('unknown', 12), true);
    assert.equal(usageIsUnverifiable(undefined, 0), true);
  });
});
