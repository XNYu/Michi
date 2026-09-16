import type { AgentProviderInfo } from '../agents/types';
import { providerUsesAwsCredentials } from '../agents/pi/piProviders';

interface ProviderReadinessOptions {
  keyPresence: Readonly<Record<string, boolean>>;
  resolveOperatorKey: (providerId: string) => string | null;
  hasAwsCredentials: boolean;
}

export interface ProviderReadiness {
  providers: Array<AgentProviderInfo & { hasKey: boolean }>;
  hasRequiredKey: boolean;
}

export function evaluateProviderReadiness(
  providers: readonly AgentProviderInfo[],
  options: ProviderReadinessOptions,
): ProviderReadiness {
  const hasUsableCredentials = (provider: AgentProviderInfo): boolean => {
    if (providerUsesAwsCredentials(provider.id)) {
      return options.hasAwsCredentials;
    }
    if (provider.requiresUserKey === false) {
      return !!options.resolveOperatorKey(provider.id);
    }
    return !!options.keyPresence[provider.id];
  };

  const providersWithStatus = providers.map((provider) => ({
    ...provider,
    hasKey: hasUsableCredentials(provider),
  }));

  return {
    providers: providersWithStatus,
    hasRequiredKey: providersWithStatus.some((provider) => provider.hasKey),
  };
}
