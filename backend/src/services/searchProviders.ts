/**
 * Metadata and identifiers for web-search integrations.
 *
 * Keep these separate from Pi model providers: a search credential must never
 * appear in the model selector or be sent to an LLM provider.
 */

export const WEB_SEARCH_PROVIDER_IDS = ["jina", "tavily"] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

export interface WebSearchProviderDefinition {
  id: WebSearchProviderId;
  label: string;
  keyLabel: string;
  keyUrl: string;
  description: string;
  envVar: string;
}

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderDefinition[] = [
  {
    id: "jina",
    label: "Jina Search",
    keyLabel: "Jina API key",
    keyUrl: "https://jina.ai/reader/",
    description: "Searches the web and returns LLM-ready page content.",
    envVar: "JINA_API_KEY",
  },
  {
    id: "tavily",
    label: "Tavily",
    keyLabel: "Tavily API key",
    keyUrl: "https://app.tavily.com/home",
    description: "Agent-focused web search with source URLs and concise excerpts.",
    envVar: "TAVILY_API_KEY",
  },
];

export function isWebSearchProviderId(value: unknown): value is WebSearchProviderId {
  return typeof value === "string" && (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Web search is a Railway-only deployment feature. Railway injects these
 * identifiers into every service, so local, Electron, and other hosted builds
 * stay feature-off without needing a second frontend build flag.
 *
 * MICHI_WEB_SEARCH_ENABLED=0 is an emergency kill switch for Railway. Setting
 * it to 1 outside Railway deliberately does not enable the feature.
 */
export function isWebSearchFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitlyDisabled = ["0", "false", "off", "no"]
    .includes(String(env.MICHI_WEB_SEARCH_ENABLED ?? "").trim().toLowerCase());
  if (explicitlyDisabled) return false;
  return Boolean(
    env.RAILWAY_PROJECT_ID
    || env.RAILWAY_ENVIRONMENT_ID
    || env.RAILWAY_SERVICE_ID,
  );
}

export function getWebSearchProvider(id: WebSearchProviderId): WebSearchProviderDefinition {
  const provider = WEB_SEARCH_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unknown web search provider: ${id}`);
  return provider;
}

/** Deliberately distinct from model-provider keys in the shared key vault. */
export function webSearchKeySlot(provider: WebSearchProviderId): string {
  return `web-search:${provider}`;
}
