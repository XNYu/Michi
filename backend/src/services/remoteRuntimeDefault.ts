import { hasProviders, type AgentRuntime } from '../agents/types';
import { evaluateProviderReadiness } from './providerReadiness';
import { getProviderApiKey, listProviderKeyPresence } from './secrets';
import { hasBedrockCredentials } from './bedrockCredentials';

/** Keep a usable current choice; otherwise use the first configured runtime.
 * Missing CLIs and unconfigured API providers must not make remote boot depend
 * on Kiro, or mistake Pi's built-in adapter for configured credentials. */
export async function findRemoteRuntimeDefault(
  runtimes: readonly AgentRuntime[], currentId: string,
): Promise<AgentRuntime | undefined> {
  const candidates = [...runtimes.filter(runtime => runtime.id === currentId), ...runtimes.filter(runtime => runtime.id !== currentId)];
  for (const runtime of candidates) {
    try {
      if (runtime.checkAvailability?.().available === false) continue;
      if (runtime.capabilities.apiKeys) {
        if (!hasProviders(runtime)) continue;
        const providers = await runtime.listProviders();
        const readiness = evaluateProviderReadiness(providers, {
          keyPresence: listProviderKeyPresence(providers.map(provider => provider.id)),
          resolveOperatorKey: id => getProviderApiKey(id),
          hasAwsCredentials: hasBedrockCredentials(),
        });
        if (!readiness.hasRequiredKey) continue;
      }
      return runtime;
    } catch { /* One failed probe must not hide other installed runtimes. */ }
  }
  return undefined;
}
