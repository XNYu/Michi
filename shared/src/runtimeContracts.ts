import { CAPABILITY_KEYS } from './harness';
import type { CapabilityAvailability, CapabilityDescriptor, EventConfidence } from './harness';
import { isReasoningLevel, sanitizeReasoningLevels } from './reasoning';
import type { ModelReasoningCapabilities, RuntimeReasoning } from './reasoning';

/** Serializable public Runtime API DTOs. Runtime sessions and SDK objects stay backend-owned. */
export type RuntimeId = string;
export type AgentReasoning = RuntimeReasoning;

export interface AgentCapabilities {
  modes: boolean;
  permissions: boolean;
  models: boolean;
  providerModels: boolean;
  reasoning: boolean;
  supportedReasoningLevels: RuntimeReasoning[];
  apiKeys: boolean;
  warmSessions: boolean;
  /**
   * The adapter can offer the host's save_artifact and update_artifact tools.
   * A session gets each one only when the host's AgentToolBridge implements
   * its method (saveContext, updateContext); this flag does not check that.
   */
  saveContext: boolean;
  /**
   * The adapter can offer the host's spawn_branches tool. A session gets it
   * only when the host's AgentToolBridge implements spawnBranches; this flag
   * does not check that.
   */
  spawnBranches: boolean;
  /** Restores meaningful agent-side state rather than replaying the transcript. */
  nativeResume: boolean;
  nativeResumeSettings?: readonly ('model' | 'reasoning')[];
}

/** Older gateways omitted these fields. Normalize once at the HTTP boundary. */
export type LegacyAgentCapabilities = Omit<AgentCapabilities, 'models' | 'supportedReasoningLevels' | 'nativeResume'>
  & Partial<Pick<AgentCapabilities, 'models' | 'supportedReasoningLevels' | 'nativeResume'>>;

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

export interface AgentRuntimeOption {
  id: RuntimeId;
  label: string;
  available: boolean;
  unavailableReason?: string;
  requiresApiKey?: boolean;
}

export interface AgentModelInfo extends ModelReasoningCapabilities {
  id: string;
  label?: string;
  description?: string;
  isDefault?: boolean;
}

export interface WebSearchProviderInfo {
  id: string;
  label: string;
  keyLabel: string;
  keyUrl: string;
  description: string;
  hasKey: boolean;
}

export interface AgentStatus {
  runtime: RuntimeId;
  label: string;
  customAgentsEnabled?: boolean;
  capabilities: AgentCapabilities;
  availableRuntimes: AgentRuntimeOption[];
  provider?: string;
  providers?: AgentProviderInfo[];
  webSearchProvider?: string | null;
  webSearchProviders?: WebSearchProviderInfo[];
  providerByRuntime?: Record<string, string>;
  model?: string;
  modelByRuntime?: Record<string, string>;
  reasoning?: RuntimeReasoning;
  reasoningByRuntime?: Record<string, RuntimeReasoning>;
  nativeResumeByRuntime?: Record<string, boolean>;
  nativeForkByRuntime?: Record<string, boolean>;
  /** Opt-in runtime workflows (Kiro CLI). */
  workflowsByRuntime?: Record<string, boolean>;
  /** Runtimes whose workflow feature can be enabled. */
  workflowRuntimes?: string[];
  hasRequiredKey: boolean;
  capabilityDescriptor?: CapabilityDescriptor;
}

export type LegacyAgentStatus = Omit<AgentStatus, 'capabilities'> & { capabilities: LegacyAgentCapabilities };

export interface AgentModelsResponse {
  models: AgentModelInfo[];
  sanitizedModel: string | null;
}

export interface RuntimeCatalogResponse {
  providers: AgentProviderInfo[];
  models: AgentModelInfo[];
  capabilities: AgentCapabilities | null;
}

export interface AgentOptionsPatch {
  nativeResumeByRuntime?: Record<string, boolean>;
  nativeForkByRuntime?: Record<string, boolean>;
  workflowsByRuntime?: Record<string, boolean>;
  runtime?: RuntimeId;
  provider?: string;
  webSearchProvider?: string | null;
  model?: string;
  reasoning?: RuntimeReasoning;
  /** Reject a save when the selected active runtime changed in the meantime. */
  expectedRuntime?: RuntimeId;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function optional<K extends string, T>(key: K, value: unknown, guard: (value: unknown) => value is T): Partial<Record<K, T>> {
  return (guard(value) ? { [key]: value } : {}) as Partial<Record<K, T>>;
}
const string = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
function map<T>(value: unknown, guard: (value: unknown) => value is T): Record<string, T> | undefined {
  const raw = object(value);
  return raw ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, T] => guard(entry[1]))) : undefined;
}
function entries<T>(value: unknown, normalize: (value: unknown) => T | undefined): T[] {
  return Array.isArray(value) ? value.flatMap((item) => { const out = normalize(item); return out === undefined ? [] : [out]; }) : [];
}

/** Missing legacy capabilities stay disabled; no provider support is inferred from an ID. */
export function normalizeAgentCapabilities(value: unknown): AgentCapabilities | null {
  const raw = object(value);
  // An empty/malformed object is not an unavailable runtime: keep it unknown
  // so callers can retry a catalog that is still warming up.
  if (!raw || !['modes', 'permissions', 'models', 'providerModels', 'reasoning', 'apiKeys', 'warmSessions', 'saveContext', 'spawnBranches', 'nativeResume'].some((key) => boolean(raw[key]))) return null;
  return {
    modes: raw.modes === true, permissions: raw.permissions === true,
    models: raw.models === true, providerModels: raw.providerModels === true,
    reasoning: raw.reasoning === true,
    supportedReasoningLevels: sanitizeReasoningLevels(raw.supportedReasoningLevels) ?? [],
    apiKeys: raw.apiKeys === true, warmSessions: raw.warmSessions === true,
    saveContext: raw.saveContext === true, spawnBranches: raw.spawnBranches === true,
    nativeResume: raw.nativeResume === true,
    ...(Array.isArray(raw.nativeResumeSettings) ? { nativeResumeSettings: [...new Set(raw.nativeResumeSettings.filter((setting): setting is 'model' | 'reasoning' => setting === 'model' || setting === 'reasoning'))] } : {}),
  };
}

function reasoning(value: Record<string, unknown>): ModelReasoningCapabilities {
  return {
    ...optional('supportsReasoning', value.supportsReasoning, boolean),
    ...(Array.isArray(value.supportedReasoningLevels) ? { supportedReasoningLevels: sanitizeReasoningLevels(value.supportedReasoningLevels) } : {}),
    ...optional('defaultReasoning', value.defaultReasoning, isReasoningLevel),
  };
}

export function normalizeAgentModel(value: unknown): AgentModelInfo | undefined {
  const raw = object(value);
  if (!raw || !string(raw.id) || !raw.id) return undefined;
  return { id: raw.id, ...reasoning(raw), ...optional('label', raw.label, string), ...optional('description', raw.description, string), ...optional('isDefault', raw.isDefault, boolean) };
}

function provider(value: unknown): AgentProviderInfo | undefined {
  const raw = object(value);
  if (!raw || !string(raw.id) || !raw.id || !string(raw.label)) return undefined;
  return {
    id: raw.id, label: raw.label, keyLabel: string(raw.keyLabel) ? raw.keyLabel : '',
    envVars: entries(raw.envVars, (item) => string(item) ? item : undefined),
    defaultModel: string(raw.defaultModel) ? raw.defaultModel : '',
    ...reasoning(raw), supportsReasoning: raw.supportsReasoning === true,
    ...optional('keyUrl', raw.keyUrl, string), ...optional('hasKey', raw.hasKey, boolean),
    ...optional('requiresUserKey', raw.requiresUserKey, boolean), ...optional('modelLocked', raw.modelLocked, boolean),
  };
}

function runtime(value: unknown): AgentRuntimeOption | undefined {
  const raw = object(value);
  if (!raw || !string(raw.id) || !raw.id || !string(raw.label)) return undefined;
  return { id: raw.id, label: raw.label, available: raw.available === true, ...optional('unavailableReason', raw.unavailableReason, string), ...optional('requiresApiKey', raw.requiresApiKey, boolean) };
}

function webSearchProvider(value: unknown): WebSearchProviderInfo | undefined {
  const raw = object(value);
  if (!raw || !string(raw.id) || !raw.id || !string(raw.label)) return undefined;
  return { id: raw.id, label: raw.label, keyLabel: string(raw.keyLabel) ? raw.keyLabel : '', keyUrl: string(raw.keyUrl) ? raw.keyUrl : '', description: string(raw.description) ? raw.description : '', hasKey: raw.hasKey === true };
}

// Records make the parser vocabulary exhaustive when the shared unions grow.
const availabilityValues: Record<CapabilityAvailability, true> = {
  native: true, native_unwired: true, michi_simulated: true, inferred: true, invisible: true, experimental: true,
};
const confidenceValues: Record<EventConfidence, true> = {
  native: true, projected: true, unknown: true, unverifiable: true,
};
function knownKey<K extends string>(values: Record<K, unknown>, value: unknown): value is K {
  return string(value) && Object.prototype.hasOwnProperty.call(values, value);
}

function descriptor(value: unknown): CapabilityDescriptor | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const out = {} as CapabilityDescriptor;
  for (const key of CAPABILITY_KEYS) {
    const slot = object(raw[key]);
    if (!slot || !knownKey(availabilityValues, slot.availability) || !knownKey(confidenceValues, slot.confidence)) return undefined;
    out[key] = { availability: slot.availability, confidence: slot.confidence, ...optional('notes', slot.notes, string) };
  }
  return out;
}

/** Accepts old gateways at one boundary; consumers receive the current DTO. */
export function normalizeAgentStatus(value: unknown): AgentStatus {
  const raw = object(value);
  const capabilities = normalizeAgentCapabilities(raw?.capabilities);
  if (!raw || !string(raw.runtime) || !string(raw.label) || !capabilities) throw new Error('Invalid agent status response');
  const capabilityDescriptor = descriptor(raw.capabilityDescriptor);
  return {
    runtime: raw.runtime, label: raw.label, capabilities,
    availableRuntimes: entries(raw.availableRuntimes, runtime), hasRequiredKey: raw.hasRequiredKey === true,
    ...optional('customAgentsEnabled', raw.customAgentsEnabled, boolean),
    ...optional('provider', raw.provider, string), ...optional('model', raw.model, string),
    ...optional('reasoning', raw.reasoning, isReasoningLevel),
    ...(raw.webSearchProvider === null || string(raw.webSearchProvider) ? { webSearchProvider: raw.webSearchProvider } : {}),
    ...(Array.isArray(raw.providers) ? { providers: entries(raw.providers, provider) } : {}),
    ...(Array.isArray(raw.webSearchProviders) ? { webSearchProviders: entries(raw.webSearchProviders, webSearchProvider) } : {}),
    ...(object(raw.providerByRuntime) ? { providerByRuntime: map(raw.providerByRuntime, string) } : {}),
    ...(object(raw.modelByRuntime) ? { modelByRuntime: map(raw.modelByRuntime, string) } : {}),
    ...(object(raw.reasoningByRuntime) ? { reasoningByRuntime: map(raw.reasoningByRuntime, isReasoningLevel) } : {}),
    ...(object(raw.nativeResumeByRuntime) ? { nativeResumeByRuntime: map(raw.nativeResumeByRuntime, boolean) } : {}),
    ...(object(raw.nativeForkByRuntime) ? { nativeForkByRuntime: map(raw.nativeForkByRuntime, boolean) } : {}),
    ...(object(raw.workflowsByRuntime) ? { workflowsByRuntime: map(raw.workflowsByRuntime, boolean) } : {}),
    ...(Array.isArray(raw.workflowRuntimes) ? { workflowRuntimes: raw.workflowRuntimes.filter(string) } : {}),
    ...(capabilityDescriptor ? { capabilityDescriptor } : {}),
  };
}

export function normalizeAgentModels(value: unknown): AgentModelsResponse {
  const raw = object(value);
  return { models: entries(raw?.models, normalizeAgentModel), sanitizedModel: string(raw?.sanitizedModel) ? raw.sanitizedModel : null };
}

export function normalizeRuntimeCatalog(value: unknown): RuntimeCatalogResponse {
  const raw = object(value);
  return { providers: entries(raw?.providers, provider), models: entries(raw?.models, normalizeAgentModel), capabilities: normalizeAgentCapabilities(raw?.capabilities) };
}
