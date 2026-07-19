import { describe, expect, it } from 'vitest';
import {
  providerRequiresUserKey,
  providerModelLocked,
  providerOptionSuffix,
} from './providerCapabilities';

describe('provider capability helpers', () => {
  it('treats built-in providers as keyless and model-locked', () => {
    const provider = {
      id: 'openrouter-free',
      label: 'OpenRouter Free Trial',
      keyLabel: 'Built-in OpenRouter trial',
      envVars: ['OPENROUTER_FREE_API_KEY'],
      defaultModel: 'openrouter/owl-alpha',
      supportsReasoning: false,
      requiresUserKey: false,
      modelLocked: true,
      hasKey: true,
    };

    expect(providerRequiresUserKey(provider)).toBe(false);
    expect(providerModelLocked(provider)).toBe(true);
    expect(providerOptionSuffix(provider)).toBe(' - built-in');
  });

  it('keeps legacy providers editable by default', () => {
    const provider = {
      id: 'openrouter',
      label: 'OpenRouter',
      keyLabel: 'OpenRouter API key',
      envVars: ['OPENROUTER_API_KEY'],
      defaultModel: 'openrouter/auto',
      supportsReasoning: true,
      hasKey: true,
    };

    expect(providerRequiresUserKey(provider)).toBe(true);
    expect(providerModelLocked(provider)).toBe(false);
    expect(providerOptionSuffix(provider)).toBe(' - key saved');
  });
});
