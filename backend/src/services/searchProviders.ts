/**
 * Metadata and identifiers for web-search integrations.
 *
 * Keep these separate from Pi model providers: a search credential must never
 * appear in the model selector or be sent to an LLM provider.
 */

import { isOwnerScopedAccess } from "./accessPolicy";

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
 * Whether this deployment offers web search: Pi's web_search and
 * fetch_content tools and the Settings → Model → Web Search configuration.
 * Each user still has to choose a provider and save its key before a chat
 * receives the tools.
 *
 * - Local and desktop backends (MICHI_CLOUD unset: Electron, the web
 *   launcher, local authenticated mode, and a desktop backend reached through
 *   remote or phone access): on. The key is kept in the backend's local
 *   credential store, and the configuration routes sit behind the same access
 *   guards as model-provider keys.
 * - Railway, detected from the service identifiers Railway injects: on.
 * - Other hosted multi-user deployments (MICHI_CLOUD=1 outside Railway): off.
 *   An access configuration resolveAccessPolicy rejects counts as hosted.
 *
 * MICHI_WEB_SEARCH_ENABLED=0 (or false/off/no) turns it off everywhere.
 * Setting it to 1 does not enable it on a hosted deployment outside Railway.
 * The frontend has no build flag: it shows the section only when
 * /agent/status reports search providers.
 */
export function isWebSearchFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitlyDisabled = ["0", "false", "off", "no"]
    .includes(String(env.MICHI_WEB_SEARCH_ENABLED ?? "").trim().toLowerCase());
  if (explicitlyDisabled) return false;
  const railway = Boolean(
    env.RAILWAY_PROJECT_ID
    || env.RAILWAY_ENVIRONMENT_ID
    || env.RAILWAY_SERVICE_ID,
  );
  return railway || !isOwnerScopedAccess(env);
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
