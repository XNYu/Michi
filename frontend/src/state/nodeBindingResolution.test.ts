import { describe, expect, it } from 'vitest';
import { resolveNodeBinding } from './nodeBindingResolution';
import type { ChatNodeState } from './chatTypes';
import type { AgentProviderInfo, AgentStatus } from '../services/api';

const status = {
  runtime: 'kiro',
  provider: undefined,
  model: 'kiro-model-a',
  reasoning: 'medium',
} as unknown as AgentStatus;

const piStatus = {
  runtime: 'pi',
  provider: 'openai',
  model: 'gpt-x',
  reasoning: 'high',
} as unknown as AgentStatus;

function node(partial: Partial<ChatNodeState>): ChatNodeState {
  return partial as ChatNodeState;
}

describe('resolveNodeBinding', () => {
  const freeProvider: AgentProviderInfo = {
    id: 'openrouter-free', label: 'OpenRouter Free Trial', keyLabel: '', envVars: [],
    defaultModel: 'free-model', supportsReasoning: false, modelLocked: true,
  };

  it('shows the locked execution model instead of a stale model bound to the free provider', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'pi', providerId: 'openrouter-free', modelId: 'deepseek-v4-flash' }),
      { ...piStatus, providers: [freeProvider] },
    );
    expect(r.provider).toBe('openrouter-free');
    expect(r.model).toBe('free-model');
  });

  it('does NOT leak the previous runtime model when a runtime override is pending', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'kiro', modelId: 'kiro-model-a', reasoning: 'low' }),
      status,
      { runtime: 'codex' },
    );
    expect(r.runtime).toBe('codex');
    expect(r.model).toBeUndefined();
    expect(r.provider).toBeUndefined();
    expect(r.reasoning).toBeUndefined();
    expect(r.source).toBe('pending');
  });

  describe('per-runtime memory', () => {
    const statusWithMemory = {
      ...status,
      providerByRuntime: { pi: 'deepseek' },
      modelByRuntime: { pi: 'deepseek-chat', kiro: 'kiro-model-a', claude: 'sonnet' },
      reasoningByRuntime: { pi: 'low' },
    } as unknown as AgentStatus;

    it('drops the remembered model when the pending provider differs from the remembered one', () => {
      const r = resolveNodeBinding(node({}), statusWithMemory, { runtime: 'pi', provider: 'openai' });
      expect(r.provider).toBe('openai');
      expect(r.model).toBeUndefined();
    });
  });
});
