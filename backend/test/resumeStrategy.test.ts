import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompatibleResumeContext,
  chooseResumeStrategy,
  type ResumeSignature,
} from '../src/services/resumeStrategy';

const target: ResumeSignature = {
  runtimeId: 'kiro',
  providerId: null,
  modelId: 'sonnet',
  reasoning: null,
};

describe('resume strategy', () => {
  test('uses exact resume when signature matches', () => {
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: false,
      nativeResumeAvailable: true,
      existingSignature: target,
      targetSignature: target,
    });
    assert.deepEqual(decision, { strategy: 'exact', reason: 'native_resume_available' });
  });

  test('uses compatible resume when runtime/provider/model signature changes', () => {
    const decision = chooseResumeStrategy({
      existingChatId: 'sid-1',
      liveSessionMatches: false,
      nativeResumeAvailable: true,
      existingSignature: { ...target, modelId: 'opus' },
      targetSignature: target,
    });
    assert.equal(decision.strategy, 'compatible');
    assert.equal(decision.reason, 'signature_changed');
  });

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

  test('native-capable model and reasoning transitions preserve history', () => {
    for (const existingSignature of [{ ...target, modelId: 'opus' }, { ...target, reasoning: 'high' as const }]) {
      assert.equal(chooseResumeStrategy({
        existingChatId: 'sid-1', liveSessionMatches: false, nativeResumeAvailable: true,
        nativeResumeSettings: ['model', 'reasoning'], existingSignature, targetSignature: target,
      }).strategy, 'exact');
    }
  });

  test('native settings support never bridges runtime or provider identities', () => {
    for (const existingSignature of [{ ...target, runtimeId: 'claude' }, { ...target, providerId: 'other' }]) {
      assert.equal(chooseResumeStrategy({
        existingChatId: 'sid-1', liveSessionMatches: true, nativeResumeAvailable: true,
        nativeResumeSettings: ['model', 'reasoning'], existingSignature, targetSignature: target,
      }).strategy, 'compatible');
    }
  });

  test('pi can reuse a matching live session but otherwise falls back to compatible', () => {
    const piTarget: ResumeSignature = {
      runtimeId: 'pi',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      reasoning: 'high',
    };
    assert.equal(
      chooseResumeStrategy({
        existingChatId: 'n-1',
        liveSessionMatches: true,
        nativeResumeAvailable: false,
        existingSignature: piTarget,
        targetSignature: piTarget,
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
