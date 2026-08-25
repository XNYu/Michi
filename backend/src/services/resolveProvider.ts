/**
 * Dynamic provider resolution for the Pi runtime.
 *
 * Instead of a hardcoded default, the provider is resolved at runtime:
 *   1. Per-runtime last-used provider (providerByRuntime[runtime]) if it is a
 *      known Pi provider — even without a key, so Settings can land on a
 *      provider the user is about to configure
 *   2. Global persisted provider (config.provider) → use if key exists for it
 *   3. First provider in PI_PROVIDERS that has a configured key
 *   4. openrouter-free as final fallback (no key required)
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
  // 1. Honor an explicit per-runtime choice even without a key. Requiring a
  // key here snaps Settings back to DeepSeek (or whichever key is saved)
  // and the provider picker looks dead.
  const lastUsed = providerByRuntime?.pi;
  if (lastUsed && isKnownPiProvider(lastUsed)) {
    return lastUsed;
  }

  // 2. Check global persisted provider (if it's a Pi provider and has a key)
  if (
    globalProvider &&
    globalProvider !== OPENROUTER_FREE_PROVIDER_ID &&
    isKnownPiProvider(globalProvider) &&
    hasValidKey(globalProvider, userId)
  ) {
    return globalProvider;
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

function isKnownPiProvider(id: string): boolean {
  return PI_PROVIDERS.some((p) => p.id === id);
}

function hasValidKey(provider: string, userId?: string): boolean {
  return !!getProviderApiKey(provider, userId);
}
