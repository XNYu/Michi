import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseResumeStrategy, type ResumeSignature } from '../src/services/resumeStrategy';

const target: ResumeSignature = {
  runtimeId: 'kiro',
  providerId: null,
  modelId: 'sonnet',
  reasoning: null,
};

describe('resume strategy', () => {
  test('attempts native restore when a legacy binding has no signature', () => {
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: false,
      nativeResumeAvailable: true,
      existingSignature: null,
      targetSignature: target,
    });
    assert.equal(decision.strategy, 'exact');
    assert.equal(decision.reason, 'native_resume_available');
  });
});
