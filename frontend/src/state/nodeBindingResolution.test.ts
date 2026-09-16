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

  it('uses runtime-scoped catalog metadata when switching from a different runtime', () => {
    const r = resolveNodeBinding(node({ runtimeId: 'kiro' }), status,
      { runtime: 'pi', provider: 'openrouter-free', model: 'deepseek-v4-flash' }, [freeProvider]);
    expect(r.model).toBe('free-model');
  });

  it('keeps an explicit DeepSeek selection when moving away from a locked provider', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'pi', providerId: 'openrouter-free', modelId: 'free-model' }),
      { ...piStatus, providers: [freeProvider] }, { provider: 'deepseek', model: 'deepseek-v4-flash' },
    );
    expect(r.provider).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
  });

  it('uses the node binding when no override is pending', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'codex', modelId: 'gpt-5-codex', reasoning: 'high' }),
      status,
    );
    expect(r.runtime).toBe('codex');
    expect(r.model).toBe('gpt-5-codex');
    expect(r.reasoning).toBe('high');
    expect(r.source).toBe('node');
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

  it('keeps the node model when the runtime override matches the node runtime', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'kiro', modelId: 'kiro-model-a' }),
      status,
      { runtime: 'kiro' },
    );
    expect(r.model).toBe('kiro-model-a');
  });

  it('inherits global model only when the effective runtime matches the global one', () => {
    const unbound = resolveNodeBinding(node({}), status, { runtime: 'claude' });
    expect(unbound.model).toBeUndefined();

    const matching = resolveNodeBinding(node({}), status);
    expect(matching.model).toBe('kiro-model-a');
    expect(matching.source).toBe('global');
  });

  it('drops the node model when a provider override differs from the node provider', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-x' }),
      piStatus,
      { provider: 'anthropic' },
    );
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBeUndefined();
    expect(r.source).toBe('pending');
  });

  it('keeps the node model when the provider override matches the node provider', () => {
    const r = resolveNodeBinding(
      node({ runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-x' }),
      piStatus,
      { provider: 'openai' },
    );
    expect(r.model).toBe('gpt-x');
  });

  describe('per-runtime memory', () => {
    const statusWithMemory = {
      ...status,
      providerByRuntime: { pi: 'deepseek' },
      modelByRuntime: { pi: 'deepseek-chat', kiro: 'kiro-model-a', claude: 'sonnet' },
      reasoningByRuntime: { pi: 'low' },
    } as unknown as AgentStatus;

    it('lands on the last-used provider/model/reasoning when switching a pane to another runtime', () => {
      const r = resolveNodeBinding(node({ runtimeId: 'kiro', modelId: 'kiro-model-a' }), statusWithMemory, { runtime: 'pi' });
      expect(r.runtime).toBe('pi');
      expect(r.provider).toBe('deepseek');
      expect(r.model).toBe('deepseek-chat');
      expect(r.reasoning).toBe('low');
      expect(r.source).toBe('pending');
    });

    it('uses the remembered model for runtimes without providers', () => {
      const r = resolveNodeBinding(node({}), statusWithMemory, { runtime: 'claude' });
      expect(r.provider).toBeUndefined();
      expect(r.model).toBe('sonnet');
    });

    it('drops the remembered model when the pending provider differs from the remembered one', () => {
      const r = resolveNodeBinding(node({}), statusWithMemory, { runtime: 'pi', provider: 'openai' });
      expect(r.provider).toBe('openai');
      expect(r.model).toBeUndefined();
    });

    it('prefers the node binding over the memory', () => {
      const r = resolveNodeBinding(node({ runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-x' }), statusWithMemory);
      expect(r.provider).toBe('openai');
      expect(r.model).toBe('gpt-x');
    });

    it('prefers the global status over the memory when the runtime matches', () => {
      const r = resolveNodeBinding(node({}), { ...piStatus, providerByRuntime: { pi: 'deepseek' }, modelByRuntime: { pi: 'deepseek-chat' } } as unknown as AgentStatus);
      expect(r.provider).toBe('openai');
      expect(r.model).toBe('gpt-x');
    });
  });
});
