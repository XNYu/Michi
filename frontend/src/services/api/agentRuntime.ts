import type { CapabilityDescriptor, ModelReasoningCapabilities } from 'michi-shared';
import { activeBackendApiBase, backendApiBase } from '../../config/backendConnections';

// === Agent runtime API ===

export type AgentReasoning = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RuntimeId = string;

export interface AgentCapabilities {
  modes: boolean;
  permissions: boolean;
  models?: boolean;
  providerModels: boolean;
  reasoning: boolean;
  /** Reasoning levels this runtime accepts. Empty when reasoning=false. Optional for backward-compat. */
  supportedReasoningLevels?: AgentReasoning[];
  apiKeys: boolean;
  warmSessions: boolean;
  saveContext: boolean;
  spawnBranches: boolean;
  /** True iff loadSession() restores meaningful agent-side state (vs. SQLite replay). Optional for backward-compat. */
  nativeResume?: boolean;
}

export interface AgentProviderInfo extends ModelReasoningCapabilities {
  id: string;
  label: string;
  keyLabel: string;
  envVars: string[];
  defaultModel: string;
  keyUrl?: string;
  supportsReasoning: boolean;
  hasKey?: boolean;
  requiresUserKey?: boolean;
  modelLocked?: boolean;
}

export interface WebSearchProviderInfo {
  id: string;
  label: string;
  keyLabel: string;
  keyUrl: string;
  description: string;
  hasKey: boolean;
}

export interface AgentRuntimeOption {
  id: RuntimeId;
  label: string;
  available: boolean;
  /**
   * Why the runtime is unavailable (missing CLI, missing credentials). Present
   * only when `available` is false. Backed by a real local probe per runtime —
   * before that probe existed the backend always sent `available: true`.
   */
  unavailableReason?: string;
  /** True iff this runtime needs a user-supplied API key before it can run. */
  requiresApiKey?: boolean;
}

export interface AgentStatus {
  runtime: RuntimeId;
  label: string;
  /** Optional routes must not be polled on older or feature-disabled backends. */
  customAgentsEnabled?: boolean;
  capabilities: AgentCapabilities;
  availableRuntimes: AgentRuntimeOption[];
  provider?: string;
  providers?: AgentProviderInfo[];
  webSearchProvider?: string | null;
  webSearchProviders?: WebSearchProviderInfo[];
  /** Per-runtime last-used provider (only meaningful for provider runtimes like Pi). */
  providerByRuntime?: Record<string, string>;
  /** Resolved model id for the active runtime. */
  model?: string;
  /** Per-runtime model overrides set by the user. */
  modelByRuntime?: Record<string, string>;
  /** Resolved reasoning level for the active runtime. */
  reasoning?: AgentReasoning;
  /** Per-runtime reasoning overrides set by the user. */
  reasoningByRuntime?: Record<string, AgentReasoning>;
  nativeResumeByRuntime?: Record<string, boolean>;
  hasRequiredKey: boolean;
  capabilityDescriptor?: CapabilityDescriptor;
}

export interface SetCustomAgentsEnabledResponse {
  ok: true;
  customAgentsEnabled: boolean;
}

export async function setCustomAgentsEnabled(
  enabled: boolean,
  connectionId?: string,
): Promise<SetCustomAgentsEnabledResponse> {
  const base = connectionId === undefined ? activeBackendApiBase() : backendApiBase(connectionId);
  const res = await fetch(`${base}/agent/custom-agents`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const body = await res.json().catch(() => ({})) as Partial<SetCustomAgentsEnabledResponse> & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `setCustomAgentsEnabled failed: ${res.status}`);
  }
  return {
    ok: true,
    customAgentsEnabled: body.customAgentsEnabled === true,
  };
}

export interface AgentModelInfo extends ModelReasoningCapabilities {
  id: string;
  label?: string;
  description?: string;
  isDefault?: boolean;
}

export interface VerifyProviderKeyResult {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}

export async function fetchAgentStatus(connectionId?: string, signal?: AbortSignal): Promise<AgentStatus> {
  const base = connectionId === undefined ? activeBackendApiBase() : backendApiBase(connectionId);
  const res = await fetch(`${base}/agent/status`, { signal });
  if (!res.ok) throw new Error(`fetchAgentStatus failed: ${res.status}`);
  return res.json();
}

export type ReadyStatus = 'pending' | 'ready' | 'failed';

export interface ReadyResponse {
  status: ReadyStatus;
  error: string | null;
}

export async function fetchReady(): Promise<ReadyResponse> {
  const res = await fetch(`${activeBackendApiBase()}/ready`);
  if (!res.ok) throw new Error(`fetchReady failed: ${res.status}`);
  const body = await res.json();
  return {
    status:
      body.status === 'ready' || body.status === 'failed' ? body.status : 'pending',
    error: typeof body.error === 'string' ? body.error : null,
  };
}

export interface AgentOptionsPatch {
  nativeResumeByRuntime?: Record<string, boolean>;
  runtime?: RuntimeId;
  provider?: string;
  /** null disables web search. */
  webSearchProvider?: string | null;
  model?: string;
  reasoning?: AgentReasoning;
}

export async function saveAgentOptions(
  patch: AgentOptionsPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${activeBackendApiBase()}/agent/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export interface AgentModelsResponse {
  models: AgentModelInfo[];
  sanitizedModel: string | null;
}

export async function listAgentModels(opts?: { provider?: string }): Promise<AgentModelsResponse> {
  const url = new URL(`${activeBackendApiBase()}/agent/models`, window.location.href);
  if (opts?.provider) url.searchParams.set('provider', opts.provider);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`listAgentModels failed: ${res.status}`);
  const body = await res.json();
  return {
    models: Array.isArray(body.models) ? body.models : [],
    sanitizedModel: typeof body.sanitizedModel === 'string' ? body.sanitizedModel : null,
  };
}

export interface RuntimeCatalogResponse {
  providers: AgentProviderInfo[];
  models: AgentModelInfo[];
  capabilities: AgentCapabilities | null;
}

/**
 * Providers, models, and capabilities for an ARBITRARY runtime (the Agent
 * editor and per-node composer pickers use this for any runtime, not just
 * the active chat runtime). Backend returns cached data when available.
 */
export async function fetchRuntimeCatalog(runtimeId: string, provider?: string): Promise<RuntimeCatalogResponse> {
  const url = new URL(`${activeBackendApiBase()}/agent/runtime-catalog`, window.location.href);
  url.searchParams.set('runtime', runtimeId);
  if (provider) url.searchParams.set('provider', provider);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`fetchRuntimeCatalog failed: ${res.status}`);
  const body = await res.json();
  return {
    providers: Array.isArray(body.providers) ? body.providers : [],
    models: Array.isArray(body.models) ? body.models : [],
    capabilities: body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : null,
  };
}

export async function saveProviderKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${activeBackendApiBase()}/agent/provider-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearProviderKey(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(
    `${activeBackendApiBase()}/agent/provider-key/${encodeURIComponent(provider)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function verifyProviderKey(
  provider: string,
  opts?: { key?: string; model?: string },
): Promise<VerifyProviderKeyResult> {
  const res = await fetch(`${activeBackendApiBase()}/agent/provider-key/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key: opts?.key, model: opts?.model }),
  });
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
  if (!res.ok) return { ok: false, error: body.error ?? `status ${res.status}` };
  return body;
}

export async function saveWebSearchKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${activeBackendApiBase()}/agent/search-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearWebSearchKey(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(
    `${activeBackendApiBase()}/agent/search-key/${encodeURIComponent(provider)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Bedrock credential configuration
// ---------------------------------------------------------------------------

export type BedrockCredentialSource = 'bearer-token' | 'access-keys' | 'profile' | 'auto';

export interface BedrockConfigSanitized {
  configured: boolean;
  region: string | null;
  credentialSource: BedrockCredentialSource | 'env' | null;
  hasProfile: boolean;
  hasBearerToken: boolean;
  hasAccessKeys: boolean;
  hasAuthRefresh: boolean;
  envDetected: boolean;
  envProfile?: string;
  envRegion?: string;
}

export interface BedrockConfigInput {
  region?: string;
  credentialSource?: BedrockCredentialSource;
  bearerToken?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  profile?: string;
  authRefreshCommand?: string;
}

export async function getBedrockConfig(): Promise<BedrockConfigSanitized> {
  const res = await fetch(`${activeBackendApiBase()}/agent/bedrock-config`);
  if (!res.ok) throw new Error(`getBedrockConfig failed: ${res.status}`);
  return res.json();
}

export async function saveBedrockConfig(
  cfg: BedrockConfigInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${activeBackendApiBase()}/agent/bedrock-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearBedrockConfig(): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${activeBackendApiBase()}/agent/bedrock-config`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function verifyBedrockConfig(): Promise<VerifyProviderKeyResult> {
  const res = await fetch(`${activeBackendApiBase()}/agent/bedrock-config/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
  if (!res.ok) return { ok: false, error: body.error ?? `status ${res.status}` };
  return body;
}
