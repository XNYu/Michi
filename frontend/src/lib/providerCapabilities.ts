import type { AgentProviderInfo } from '../services/api';

export function providerRequiresUserKey(provider: Partial<AgentProviderInfo>): boolean {
  return provider.requiresUserKey !== false;
}

export function providerModelLocked(provider: Partial<AgentProviderInfo>): boolean {
  return provider.modelLocked === true;
}

export function providerOptionSuffix(provider: Partial<AgentProviderInfo>): string {
  if (!providerRequiresUserKey(provider)) return ' - built-in';
  return provider.hasKey ? ' - key saved' : ' - no key';
}

/** True when switching to this provider should open the API-key window. */
export function shouldPromptForProviderKey(provider: Partial<AgentProviderInfo>): boolean {
  return providerRequiresUserKey(provider) && !provider.hasKey;
}
