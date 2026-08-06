/**
 * Dynamic provider resolution for the Pi runtime.
 *
 * Instead of a hardcoded default, the provider is resolved at runtime:
 *   1. Per-runtime last-used provider (providerByRuntime[runtime]) → use it if key still valid
 *   2. Global persisted provider (config.provider) → use if key exists for it
 *   3. First provider in PI_PROVIDERS that has a configured key
 *   4. openrouter-free as final fallback (no key required)
 *
 * This ensures a user is never forced onto a provider they haven't configured.
 */

import { PI_PROVIDERS, OPENROUTER_FREE_PROVIDER_ID } from "../agents/pi/piProviders";
import { getProviderApiKey } from "./secrets";

/**
 * Resolve the best provider for the Pi runtime given current key state.
 *
 * @param providerByRuntime - Per-runtime provider map from persisted config
 * @param globalProvider - The global `provider` field from config
 * @param userId - Optional user id for cloud/BYOK mode
 * @returns The provider id to use
 */
export function resolveDefaultPiProvider(
  providerByRuntime: Record<string, string> | undefined,
  globalProvider: string | undefined,
  userId?: string,
): string {
  // 1. Check per-runtime last-used provider
  const lastUsed = providerByRuntime?.pi;
  if (lastUsed && hasValidKey(lastUsed, userId)) {
    return lastUsed;
  }

  // 2. Check global persisted provider (if it's a Pi provider and has a key)
  if (globalProvider && globalProvider !== OPENROUTER_FREE_PROVIDER_ID) {
    const isKnownPiProvider = PI_PROVIDERS.some((p) => p.id === globalProvider);
    if (isKnownPiProvider && hasValidKey(globalProvider, userId)) {
      return globalProvider;
    }
  }

  // 3. First Pi provider that has a configured key
  for (const provider of PI_PROVIDERS) {
    if (provider.id === OPENROUTER_FREE_PROVIDER_ID) continue;
    if (hasValidKey(provider.id, userId)) {
      return provider.id;
    }
  }

  // 4. Final fallback — free provider (no key required from user)
  return OPENROUTER_FREE_PROVIDER_ID;
}

/**
 * Check if a provider has a usable API key. For server-managed providers
 * (openrouter-free), the key lives in env — this function just checks
 * whether getProviderApiKey returns non-null.
 */
function hasValidKey(provider: string, userId?: string): boolean {
  return !!getProviderApiKey(provider, userId);
}
