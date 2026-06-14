import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompatibleResumeContext,
  chooseResumeStrategy,
  computeTranscriptFingerprint,
  type ResumeSignature,
} from '../src/services/resumeStrategy';

const target: ResumeSignature = {
  runtimeId: 'kiro',
  providerId: null,
  modelId: 'sonnet',
  reasoning: null,
};

describe('resume strategy', () => {
  test('uses exact resume when signature and transcript fingerprint match', () => {
    const fp = computeTranscriptFingerprint([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: false,
      nativeResumeAvailable: true,
      existingSignature: target,
      targetSignature: target,
      storedFingerprint: fp,
      currentFingerprint: fp,
    });
    assert.deepEqual(decision, { strategy: 'exact', reason: 'native_resume_available' });
  });

  test('uses compatible resume when runtime/provider/model signature changes', () => {
    const fp = computeTranscriptFingerprint([{ role: 'user', content: 'hello' }]);
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: false,
      nativeResumeAvailable: true,
      existingSignature: { ...target, modelId: 'opus' },
      targetSignature: target,
      storedFingerprint: fp,
      currentFingerprint: fp,
    });
    assert.equal(decision.strategy, 'compatible');
    assert.equal(decision.reason, 'signature_changed');
  });

  test('uses compatible resume when visible transcript diverged from stored fingerprint', () => {
    const oldFp = computeTranscriptFingerprint([{ role: 'user', content: 'old' }]);
    const currentFp = computeTranscriptFingerprint([{ role: 'user', content: 'edited' }]);
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: true,
      nativeResumeAvailable: true,
      existingSignature: target,
      targetSignature: target,
      storedFingerprint: oldFp,
      currentFingerprint: currentFp,
    });
    assert.equal(decision.strategy, 'compatible');
    assert.equal(decision.reason, 'transcript_changed');
  });

  test('pi can reuse a matching live session but otherwise falls back to compatible', () => {
    const piTarget: ResumeSignature = {
      runtimeId: 'pi',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      reasoning: 'high',
    };
    const fp = computeTranscriptFingerprint([]);
    assert.equal(
      chooseResumeStrategy({
        existingChatId: 'n-1',
        liveSessionMatches: true,
        nativeResumeAvailable: false,
        existingSignature: piTarget,
        targetSignature: piTarget,
        storedFingerprint: fp,
        currentFingerprint: fp,
      }).strategy,
      'live',
    );
    assert.equal(
      chooseResumeStrategy({
        existingChatId: 'n-1',
        liveSessionMatches: false,
        nativeResumeAvailable: false,
        existingSignature: piTarget,
        targetSignature: piTarget,
        storedFingerprint: fp,
        currentFingerprint: fp,
      }).strategy,
      'compatible',
    );
  });

  test('compatible transcript context injects visible text without mutating the next user message', () => {
    const context = buildCompatibleResumeContext(
      [
        { role: 'user', content: 'What did we decide?' },
        { role: 'assistant', content: 'Use text-compatible restore.' },
      ],
      { nodeId: 'n-1', title: 'Resume Design' },
    );
    assert.ok(context);
    assert.match(context, /Compatible resume transcript: Resume Design/);
    assert.match(context, /User:\nWhat did we decide\?/);
    assert.match(context, /Assistant:\nUse text-compatible restore\./);
  });
});
