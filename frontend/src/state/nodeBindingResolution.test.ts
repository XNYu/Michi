import { describe, expect, it } from 'vitest';
import { resolveNodeBinding } from './nodeBindingResolution';
import type { ChatNodeState } from './chatTypes';
import type { AgentStatus } from '../services/api';

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
});
