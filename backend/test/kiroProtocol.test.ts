import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIRO_APPROVE_FOR_ME_PRESET, kiroEnv, kiroArgs, kiroSessionMeta, resolveKiroEngine, normalizeSessionInfo, rewindPoints, v3InfoUpdates } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';
import { chooseResumeStrategy } from '../src/services/resumeStrategy';

test('Kiro launch pins v3 by default and never sends v2-only flags to v3', () => {
    assert.equal(resolveKiroEngine(''), 'v3');
    assert.equal(resolveKiroEngine(undefined), 'v3');
    assert.equal(resolveKiroEngine('v2'), 'v2');
    assert.throws(() => resolveKiroEngine('v4'), /must be/);
    assert.deepEqual(kiroArgs('v2', 'model'), ['acp', '--agent-engine', 'v2', '--model', 'model']);
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

for (const engine of ['v2', 'v3'] as const) {
    const classifier = engine === 'v3' ? { KIRO_TRUST_CLASSIFIER_MODE: 'enforce' } : {};
    test(`${engine} preserves caller settings and applies its classifier default`, () => {
        const env = { KEEP: 'value' };
        assert.deepEqual(kiroEnv(engine, env), { ...env, ...classifier });
        assert.notEqual(kiroEnv(engine, env), env);
        assert.deepEqual(kiroEnv(engine, env, false), { ...env, ...classifier });
        assert.deepEqual(kiroEnv(engine, {}), classifier);
    });
}

test('v3 keeps a trust classifier mode the user set; v2 never gets one', () => {
    assert.equal(kiroEnv('v3', { KIRO_TRUST_CLASSIFIER_MODE: 'monitor' }).KIRO_TRUST_CLASSIFIER_MODE, 'monitor');
    assert.equal(kiroEnv('v3', { KIRO_TRUST_CLASSIFIER_MODE: ' ' }).KIRO_TRUST_CLASSIFIER_MODE, 'enforce');
    assert.equal(kiroEnv('v2', {}).KIRO_TRUST_CLASSIFIER_MODE, undefined);
});

test('v3 session meta seeds policy presets; v2 sends none', () => {
    assert.deepEqual(kiroSessionMeta('v3', { policyPresets: [KIRO_APPROVE_FOR_ME_PRESET] }),
        { _meta: { kiro: { policyPreset: ['approve-for-me'] } } });
    assert.deepEqual(kiroSessionMeta('v3', { policyPresets: [] }), { _meta: { kiro: {} } });
    assert.deepEqual(kiroSessionMeta('v2', { policyPresets: [KIRO_APPROVE_FOR_ME_PRESET] }), {});
});
