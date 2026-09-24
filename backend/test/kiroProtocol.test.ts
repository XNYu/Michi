import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kiroArgs, resolveKiroEngine, normalizeSessionInfo, rewindPoints, v3InfoUpdates } from '../src/agents/kiro/kiroProtocol';
import { chooseResumeStrategy } from '../src/services/resumeStrategy';

test('Kiro launch pins v2 by default and never sends v2-only flags to v3', () => {
    assert.equal(resolveKiroEngine(''), 'v2');
    assert.throws(() => resolveKiroEngine('v4'), /must be/);
    assert.deepEqual(kiroArgs('v2', 'model'), ['acp', '--agent-engine', 'v2', '-a', '--model', 'model']);
    assert.deepEqual(kiroArgs('v3', 'model'), ['acp', '--agent-engine', 'v3', '--auth-method', 'cli']);
});

test('dynamic config catalogs preserve native values and tolerate absent model/effort options', () => {
    const result = normalizeSessionInfo({ configOptions: [
        { id: 'model', type: 'select', currentValue: 'chosen', options: [{ group: 'Provider', options: [{ value: 'chosen', name: 'Chosen' }] }] },
        { id: 'mode', type: 'select', currentValue: 'vibe', options: [{ value: 'vibe', name: 'Default' }] },
    ] });
    assert.equal(result.models.currentModelId, 'chosen');
    assert.equal(result.models.availableModels[0].modelId, 'chosen');
    assert.equal(result.modes.currentModeId, 'vibe');
    assert.equal(normalizeSessionInfo({ configOptions: [] }).models, undefined);
});

test('rewind never coerces invalid indices or accepts commands/options as a catalog', () => {
    assert.deepEqual(rewindPoints({ data: { turns: [
        { logIndex: 8 }, { logIndex: 0 }, { logIndex: null }, { logIndex: '0' }, { logIndex: -1 }, { logIndex: 1.2 },
    ] } }), [{ logIndex: 8 }, { logIndex: 0 }]);
    assert.throws(() => rewindPoints({ options: [] }), /no turn catalog/);
});

test('v3 usage preserves unknowns, sums credits only, and never settles a turn from notification', () => {
    const info = (kiro: unknown) => v3InfoUpdates({ sessionUpdate: 'session_info_update', _meta: { kiro } });
    assert.deepEqual(info({ contextUsage: { usagePercentage: 2.75 } }), [{ sessionUpdate: 'context_usage', contextUsagePercentage: 2.75 }]);
    assert.deepEqual(info({ kind: 'turn_completion', elapsedTime: 140, promptTurnSummaries: [
        { unit: 'credit', usage: 0.2 }, { unit: 'credit', usage: 0.3 }, { unit: 'USD', usage: 100 },
    ] }), [{ sessionUpdate: 'usage_summary', totalCredits: 0.5, turnDurationMs: 140, source: 'kiro-v3' }]);
    assert.deepEqual(info({ kind: 'turn_completion', promptTurnSummaries: [] }), [{ sessionUpdate: 'usage_summary', source: 'kiro-v3' }]);
    assert.deepEqual(info({ kind: 'turn_end', turnEnd: { stopReason: 'end_turn' } }), []);
});

test('legacy Kiro bindings are v2, and an engine change never claims native resume', () => {
    const signature = { runtimeId: 'kiro', providerId: null, modelId: 'model', reasoning: null };
    const input = { existingChatId: 'node', liveSessionMatches: true, nativeResumeAvailable: true,
        existingSignature: signature, targetSignature: { ...signature, runtimeEngine: 'v3' } };
    assert.deepEqual(chooseResumeStrategy(input), { strategy: 'compatible', reason: 'engine_changed' });
    assert.equal(chooseResumeStrategy({ ...input, targetSignature: { ...signature, runtimeEngine: 'v2' } }).strategy, 'live');
});
