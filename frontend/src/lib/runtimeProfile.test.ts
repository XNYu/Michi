import { describe, expect, it } from 'vitest';
import { changeRuntimeProfile, profileReasoningLevels, resolveProfileReasoning } from './runtimeProfile';
import type { AgentCapabilities } from '../services/api/agentRuntime';

const value = { runtimeId: 'pi', providerId: 'a', modelId: 'm1', reasoning: 'max', modeId: 'plan', name: 'preserved' };
const caps: AgentCapabilities = { nativeResume: false, reasoning: true, supportedReasoningLevels: ['low', 'high'], modes: true, models: true, permissions: false, providerModels: true, apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false };
describe('runtime profile dependency rules', () => {
  it('clears runtime-specific choices for both select and manual input changes', () => {
    expect(changeRuntimeProfile(value, 'runtimeId', 'codex')).toEqual({ ...value, runtimeId: 'codex', providerId: '', modelId: '', reasoning: '', modeId: '' });
    expect(changeRuntimeProfile(value, 'providerId', 'b')).toEqual({ ...value, providerId: 'b', modelId: '', reasoning: '' });
    expect(changeRuntimeProfile(value, 'modelId', 'm2')).toEqual({ ...value, modelId: 'm2', reasoning: '' });
    expect(changeRuntimeProfile(value, 'runtimeId', 'pi')).toBe(value);
  });
  it('uses the shared model/provider/runtime resolver and keeps unknown catalogs editable', () => {
    expect(profileReasoningLevels(caps)).toEqual(['low', 'high']);
    expect(profileReasoningLevels(caps, { id: 'm', supportedReasoningLevels: ['high'] })).toEqual(['high']);
    expect(profileReasoningLevels(caps, undefined, { id: 'p', label: 'P', keyLabel: '', envVars: [], defaultModel: '', supportsReasoning: false })).toEqual([]);
    expect(profileReasoningLevels(null)).toContain('max');
  });
  it('resolves default models and waits for a known model before rejecting a saved level', () => {
    const models = [{ id: 'first', supportedReasoningLevels: ['low' as const] }, { id: 'default', isDefault: true, supportedReasoningLevels: ['high' as const] }];
    expect(resolveProfileReasoning(caps, models, '')).toEqual({ known: true, levels: ['high'] });
    expect(resolveProfileReasoning(caps, models, 'missing').known).toBe(false);
    expect(resolveProfileReasoning(caps, undefined, 'default').known).toBe(false);
    expect(resolveProfileReasoning({ ...caps, reasoning: false }, undefined, 'missing')).toEqual({ known: true, levels: [] });
  });
});
