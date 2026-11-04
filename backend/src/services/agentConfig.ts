import { isReasoningLevel } from 'michi-shared';
import { readJsonConfig, updateJsonConfig } from "./jsonConfigStore";
import { EventEmitter } from "node:events";
import path from "path";
import os from "os";
import type { RuntimeId, AgentReasoning } from "../agents/types";
import { getUserAgentConfig, upsertUserAgentConfig } from "./dbRepository";
import { DEFAULT_MODELS } from "../agents/agentConfig";
import { resolveDefaultPiProvider } from "./resolveProvider";
import { getProviderInfo, selectDefaultModelId } from "../agents/pi/piProviders";
import { isWebSearchFeatureEnabled, isWebSearchProviderId, type WebSearchProviderId } from "./searchProviders";
import { getMichiConfigPaths } from './configPaths';

export interface AgentConfig {
  runtime: RuntimeId;
  provider: string;
  /** Globally selected web-search integration, or null when disabled. */
  webSearchProvider: WebSearchProviderId | null;
  /**
   * Per-runtime provider memory. When the user explicitly switches providers
   * while on a specific runtime, the choice is recorded here so switching
   * back to that runtime later restores it automatically.
   */
  providerByRuntime: Record<string, string>;
  modelByRuntime: Record<string, string>;
  reasoningByRuntime: Record<string, AgentReasoning>;
  /** Omitted runtimes keep native resume enabled. Live sessions are unaffected. */
  nativeResumeByRuntime?: Record<string, boolean>;
  /** Omitted runtimes keep native fork enabled. Existing branches are unaffected. */
  nativeForkByRuntime?: Record<string, boolean>;
  /** Runtime workflow features (Kiro CLI workflows). Opt-in; applies to new sessions. */
  workflowsByRuntime?: Record<string, boolean>;
  /**
   * Claude config dir override (CLAUDE_CONFIG_DIR for spawned claude
   * processes). Unset = claude's own default (~/.claude). Desktop-only,
   * hand-edited in ~/.michi/config.json — no UI surface, never prompted.
   * Changing it moves claude's whole identity (OAuth creds, settings,
   * plugins, session JSONLs), so resume of sessions created under the old
   * dir will break. Supports a leading "~".
   */
  claudeConfigDir?: string;
}

const { configPath: CONFIG_PATH } = getMichiConfigPaths();

// Hard-coded default model per runtime. Used when neither
// agentConfig.modelByRuntime nor a per-call override picks one.
// Empty string means "let the runtime pick from listModels()".
const BUILTIN_DEFAULT_MODEL_BY_RUNTIME: Record<string, string> = {
  claude: "sonnet",
  // Keep in lockstep with the default Pi provider (anthropic).
  pi: DEFAULT_MODELS.pi,
  kiro: "",
  cursor: "",
  grok: "grok-4.6",
};

// Hard-coded default reasoning level per runtime. Used when neither
// agentConfig.reasoningByRuntime nor a per-call override picks one.
const BUILTIN_DEFAULT_REASONING_BY_RUNTIME: Record<string, AgentReasoning> = {
  codex: "xhigh",
  claude: "high",
  pi: "high",
  kiro: "high",
};

/**
 * Read when defaults are built, not at import: server.ts loads backend/.env,
 * and ~/.michi/.env for the background service, after its imports run.
 */
function envDefaultWebSearchProvider(): WebSearchProviderId | null {
  const provider = process.env.MICHI_DEFAULT_WEB_SEARCH_PROVIDER;
  return isWebSearchFeatureEnabled() && isWebSearchProviderId(provider) ? provider : null;
}

const DEFAULTS: AgentConfig = {
  // Public installs wait for a choice; explicit environment and saved config still win.
  runtime: process.env.MICHI_DEFAULT_RUNTIME ?? "",
  provider: "anthropic",
  webSearchProvider: null,
  providerByRuntime: {},
  modelByRuntime: {},
  reasoningByRuntime: {},
  nativeResumeByRuntime: {},
  nativeForkByRuntime: {},
  workflowsByRuntime: {},
};

function defaultAgentConfig(): AgentConfig {
  return {
    ...DEFAULTS,
    webSearchProvider: envDefaultWebSearchProvider(),
    providerByRuntime: { ...DEFAULTS.providerByRuntime },
    modelByRuntime: { ...DEFAULTS.modelByRuntime },
    reasoningByRuntime: { ...DEFAULTS.reasoningByRuntime },
  };
}


function booleanRuntimeMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean'));
}

export function isNativeResumeEnabled(runtimeId: string, userId?: string | null): boolean {
  return getAgentConfig(userId ?? undefined).nativeResumeByRuntime?.[runtimeId] !== false;
}

export function isNativeForkEnabled(runtimeId: string, userId?: string | null): boolean {
  return getAgentConfig(userId ?? undefined).nativeForkByRuntime?.[runtimeId] !== false;
}

/** Off unless the user opted in. */
export function isWorkflowsEnabled(runtimeId: string, userId?: string | null): boolean {
  return getAgentConfig(userId ?? undefined).workflowsByRuntime?.[runtimeId] === true;
}

let current: AgentConfig = defaultAgentConfig();

let warnedAboutLegacy = false;

export function normalizeLegacyRuntimeId(runtime: string): RuntimeId {
  return runtime === "gemini" ? "antigravity" : runtime;
}

function readDiskFile(): Record<string, any> | null {
  return readJsonConfig(CONFIG_PATH);
}

function readRuntimeFromEnv(): RuntimeId | undefined {
  // Prefer the new env var; fall back to legacy MICHI_AGENT for one release.
  // The registry (not this module) decides whether the id is real, so we
  // accept any non-empty string here.
  const newEnv = process.env.MICHI_AGENT_RUNTIME;
  if (typeof newEnv === "string" && newEnv.length > 0) return normalizeLegacyRuntimeId(newEnv);
  const legacy = process.env.MICHI_AGENT;
  if (legacy) {
    if (legacy === "pi-deepseek") {
      // One-shot deprecation warning; do not crash.
      if (!warnedAboutLegacy) {
        console.warn(
          "[agentConfig] MICHI_AGENT=pi-deepseek is deprecated; use MICHI_AGENT_RUNTIME=pi instead.",
        );
        warnedAboutLegacy = true;
      }
      return "pi";
    }
    if (legacy === "kiro") return "kiro";
    if (!warnedAboutLegacy) {
      console.warn(
        `[agentConfig] Unknown legacy MICHI_AGENT='${legacy}'; ignoring. Use MICHI_AGENT_RUNTIME=<runtime-id>.`,
      );
      warnedAboutLegacy = true;
    }
  }
  return undefined;
}

function persist(config: AgentConfig = current): void {
  updateJsonConfig(CONFIG_PATH, (existing) => {
    const agent = { ...config };
    // Drop the legacy field without changing any unrelated namespace.
    if ('model' in agent) delete (agent as any).model;
    return { ...existing, agent };
  });
}

export function loadAgentConfig(): AgentConfig {
  const disk = readDiskFile();
  let next: AgentConfig = defaultAgentConfig();
  let migratedFromLegacy = false;

  if (disk && typeof disk === "object") {
    if (disk.agent && typeof disk.agent === "object") {
      const a = disk.agent;
      if (typeof a.runtime === "string" && a.runtime.length > 0) {
        next.runtime = normalizeLegacyRuntimeId(a.runtime);
        if (a.runtime === "gemini") migratedFromLegacy = true;
      }
      if (typeof a.provider === "string" && a.provider) next.provider = a.provider;
      if (isWebSearchProviderId(a.webSearchProvider)) next.webSearchProvider = a.webSearchProvider;
      if (typeof a.claudeConfigDir === "string" && a.claudeConfigDir.trim()) {
        next.claudeConfigDir = a.claudeConfigDir.trim();
      }
      if (a.providerByRuntime && typeof a.providerByRuntime === "object" && !Array.isArray(a.providerByRuntime)) {
        for (const [k, v] of Object.entries(a.providerByRuntime)) {
          if (typeof v === "string" && v.length > 0) next.providerByRuntime[k] = v;
        }
      }
      if (a.modelByRuntime && typeof a.modelByRuntime === "object" && !Array.isArray(a.modelByRuntime)) {
        for (const [k, v] of Object.entries(a.modelByRuntime)) {
          if (typeof v === "string" && v.length > 0) next.modelByRuntime[k] = v;
        }
      }
      if (a.reasoningByRuntime && typeof a.reasoningByRuntime === "object" && !Array.isArray(a.reasoningByRuntime)) {
        for (const [k, v] of Object.entries(a.reasoningByRuntime)) {
          if (isReasoningLevel(v)) {
            next.reasoningByRuntime[k] = v;
          }
        }
      }
      next.nativeResumeByRuntime = booleanRuntimeMap(a.nativeResumeByRuntime);
      next.nativeForkByRuntime = booleanRuntimeMap(a.nativeForkByRuntime);
      next.workflowsByRuntime = booleanRuntimeMap(a.workflowsByRuntime);
      // Migrate legacy `agent.model` (single string) into modelByRuntime[<current runtime>]
      if (typeof a.model === "string" && a.model && !next.modelByRuntime[next.runtime]) {
        next.modelByRuntime[next.runtime] = a.model;
        migratedFromLegacy = true;
      }
      // Migrate legacy `agent.reasoning` (single string) into reasoningByRuntime[<current runtime>]
      if (
        typeof a.reasoning === "string" &&
        isReasoningLevel(a.reasoning) &&
        !next.reasoningByRuntime[next.runtime]
      ) {
        next.reasoningByRuntime[next.runtime] = a.reasoning as AgentReasoning;
        migratedFromLegacy = true;
      }
    } else {
      // Migrate from very-legacy flat shape
      if (typeof disk.agentProvider === "string" && disk.agentProvider) {
        next.provider = disk.agentProvider;
        migratedFromLegacy = true;
      }
      if (typeof disk.agentModel === "string" && disk.agentModel) {
        next.modelByRuntime[next.runtime] = disk.agentModel;
        migratedFromLegacy = true;
      }
      if (
        typeof disk.agentReasoning === "string" &&
        isReasoningLevel(disk.agentReasoning)
      ) {
        next.reasoningByRuntime[next.runtime] = disk.agentReasoning as AgentReasoning;
        migratedFromLegacy = true;
      }
    }
  }

  const envRuntime = readRuntimeFromEnv();
  if (envRuntime) next.runtime = envRuntime;

  current = next;

  if (migratedFromLegacy) {
    try {
      persist();
    } catch (err) {
      console.warn("[agentConfig] post-migration persist failed:", err);
    }
  }

  return current;
}

export function getAgentConfig(userId?: string): AgentConfig {
  // Cloud mode with a known user: read from DB (lazy init on missing row).
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const row = getUserAgentConfig(userId);
    if (!row) {
      // First access — return built-in defaults; the row will be created on
      // first write via updateAgentConfig.
      return defaultAgentConfig();
    }
    let providerByRuntime: Record<string, string> = {};
    let modelByRuntime: Record<string, string> = {};
    let reasoningByRuntime: Record<string, AgentReasoning> = {};
    try { providerByRuntime = JSON.parse(row.provider_by_runtime ?? "{}"); } catch { /* keep {} */ }
    try { modelByRuntime = JSON.parse(row.model_by_runtime); } catch { /* keep {} */ }
    try {
      const raw = JSON.parse(row.reasoning_by_runtime);
      for (const [k, v] of Object.entries(raw)) {
        if (isReasoningLevel(v)) {
          reasoningByRuntime[k] = v as AgentReasoning;
        }
      }
    } catch { /* keep {} */ }
    return {
      runtime: normalizeLegacyRuntimeId(row.runtime),
      provider: row.provider,
      webSearchProvider: isWebSearchProviderId(row.web_search_provider) ? row.web_search_provider : null,
      providerByRuntime,
      modelByRuntime,
      reasoningByRuntime,
      nativeResumeByRuntime: (() => {
        try { return booleanRuntimeMap(JSON.parse(row.native_resume_by_runtime)); } catch { return {}; }
      })(),
      nativeForkByRuntime: (() => {
        try { return booleanRuntimeMap(JSON.parse(row.native_fork_by_runtime)); } catch { return {}; }
      })(),
      workflowsByRuntime: (() => {
        try { return booleanRuntimeMap(JSON.parse(row.workflows_by_runtime ?? '{}')); } catch { return {}; }
      })(),
    };
  }
  // Desktop / no userId: return the in-memory singleton.
  return current;
}

export function updateAgentConfig(patch: Partial<AgentConfig>, userId?: string): AgentConfig {
  // Cloud mode with a known user: write to DB.
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const existing = getAgentConfig(userId);
    // `null` is meaningful for webSearchProvider: it is how Settings turns
    // the feature off. Nullish coalescing would accidentally retain the
    // previously selected provider instead.
    const hasWebSearchProviderPatch = Object.prototype.hasOwnProperty.call(patch, 'webSearchProvider');
    const webSearchProvider = hasWebSearchProviderPatch
      ? patch.webSearchProvider ?? null
      : existing.webSearchProvider;
    const mergedProviderByRuntime = patch.providerByRuntime
      ? { ...existing.providerByRuntime, ...patch.providerByRuntime }
      : { ...existing.providerByRuntime };
    const mergedModelByRuntime = patch.modelByRuntime
      ? { ...existing.modelByRuntime, ...patch.modelByRuntime }
      : { ...existing.modelByRuntime };
    const mergedReasoningByRuntime = patch.reasoningByRuntime
      ? { ...existing.reasoningByRuntime, ...patch.reasoningByRuntime }
      : { ...existing.reasoningByRuntime };
    const nativeResumeByRuntime = { ...existing.nativeResumeByRuntime, ...booleanRuntimeMap(patch.nativeResumeByRuntime) };
    const nativeForkByRuntime = { ...existing.nativeForkByRuntime, ...booleanRuntimeMap(patch.nativeForkByRuntime) };
    const workflowsByRuntime = { ...existing.workflowsByRuntime, ...booleanRuntimeMap(patch.workflowsByRuntime) };
    upsertUserAgentConfig(userId, {
      runtime: (patch.runtime ?? existing.runtime) as string,
      provider: patch.provider ?? existing.provider,
      web_search_provider: webSearchProvider ?? "",
      provider_by_runtime: JSON.stringify(mergedProviderByRuntime),
      model_by_runtime: JSON.stringify(mergedModelByRuntime),
      reasoning_by_runtime: JSON.stringify(mergedReasoningByRuntime),
      native_resume_by_runtime: JSON.stringify(nativeResumeByRuntime),
      native_fork_by_runtime: JSON.stringify(nativeForkByRuntime),
      workflows_by_runtime: JSON.stringify(workflowsByRuntime),
    });
    return {
      ...existing,
      ...patch,
      webSearchProvider,
      providerByRuntime: mergedProviderByRuntime,
      modelByRuntime: mergedModelByRuntime,
      reasoningByRuntime: mergedReasoningByRuntime,
      nativeResumeByRuntime,
      nativeForkByRuntime,
      workflowsByRuntime,
    };
  }
  // Desktop: mutate in-memory singleton + persist to disk.
  const merged: AgentConfig = { ...current, ...patch };
  // Never replace providerByRuntime / modelByRuntime / reasoningByRuntime
  // wholesale through a generic patch — merge incrementally.
  merged.providerByRuntime = patch.providerByRuntime
    ? { ...current.providerByRuntime, ...patch.providerByRuntime }
    : { ...current.providerByRuntime };
  merged.modelByRuntime = patch.modelByRuntime
    ? { ...current.modelByRuntime, ...patch.modelByRuntime }
    : { ...current.modelByRuntime };
  merged.reasoningByRuntime = patch.reasoningByRuntime
    ? { ...current.reasoningByRuntime, ...patch.reasoningByRuntime }
    : { ...current.reasoningByRuntime };
  merged.nativeResumeByRuntime = { ...current.nativeResumeByRuntime, ...booleanRuntimeMap(patch.nativeResumeByRuntime) };
  merged.nativeForkByRuntime = { ...current.nativeForkByRuntime, ...booleanRuntimeMap(patch.nativeForkByRuntime) };
  merged.workflowsByRuntime = { ...current.workflowsByRuntime, ...booleanRuntimeMap(patch.workflowsByRuntime) };
  persist(merged);
  current = merged;
  return current;
}

export interface ModelChangedEvent {
  runtime: string;
  model: string;
}

/**
 * Event emitter for agentConfig changes. Currently exposes:
 *
 *   - `model_changed` ({ runtime, model }): fires whenever
 *     updateAgentModelForRuntime sets a new model (i.e. previous value
 *     was different). Subscribed to by ClaudeRuntime to keep the warm
 *     pool's modelSet aligned with the user's global preference.
 *
 * Use `.on` / `.off` for subscription. Synchronous emit; handlers run
 * inline on the call site of updateAgentModelForRuntime, so heavy work
 * (spawning processes) should be moved off the hot path with void Promise.
 */
export const agentConfigEvents = new EventEmitter();

export function updateAgentModelForRuntime(runtimeId: string, modelId: string, userId?: string): AgentConfig {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const existing = getAgentConfig(userId);
    if (existing.modelByRuntime[runtimeId] === modelId) return existing;
    const updated = updateAgentConfig({ modelByRuntime: { [runtimeId]: modelId } }, userId);
    agentConfigEvents.emit('model_changed', { runtime: runtimeId, model: modelId } as ModelChangedEvent);
    return updated;
  }
  const previous = current.modelByRuntime[runtimeId];
  if (previous === modelId) return current;
  const next = {
    ...current,
    modelByRuntime: { ...current.modelByRuntime, [runtimeId]: modelId },
  };
  persist(next);
  current = next;
  agentConfigEvents.emit('model_changed', { runtime: runtimeId, model: modelId } as ModelChangedEvent);
  return current;
}

export function updateAgentReasoningForRuntime(
  runtimeId: string,
  level: AgentReasoning,
  userId?: string,
): AgentConfig {
  if (process.env.MICHI_CLOUD === '1' && userId) {
    return updateAgentConfig({ reasoningByRuntime: { [runtimeId]: level } }, userId);
  }
  const next = {
    ...current,
    reasoningByRuntime: { ...current.reasoningByRuntime, [runtimeId]: level },
  };
  persist(next);
  current = next;
  return current;
}

/**
 * Resolve the model id to use for a runtime. Priority:
 *   1. agentConfig.modelByRuntime[runtimeId]    (user override)
 *   2. the provider default: its floating alias, else the pinned entry
 *   3. BUILTIN_DEFAULT_MODEL_BY_RUNTIME[runtimeId]   (code-level default)
 *   4. ""                                       (let runtime decide)
 */
export function resolveModel(runtimeId: string, userId?: string): string {
  const cfg = getAgentConfig(userId);
  const provider = runtimeId === 'pi' ? getProviderInfo(resolveProvider(runtimeId, userId)) : undefined;
  if (provider?.modelLocked) return provider.defaultModel;
  const userOverride = cfg.modelByRuntime[runtimeId];
  if (userOverride) return userOverride;
  if (provider) return selectDefaultModelId(provider);
  return BUILTIN_DEFAULT_MODEL_BY_RUNTIME[runtimeId] ?? "";
}

/**
 * Resolve the reasoning level to use for a runtime. Priority:
 *   1. agentConfig.reasoningByRuntime[runtimeId]    (user override)
 *   2. BUILTIN_DEFAULT_REASONING_BY_RUNTIME[runtimeId]
 *   3. undefined                                    (no reasoning passed)
 */
export function resolveReasoning(runtimeId: string, userId?: string): AgentReasoning | undefined {
  const cfg = getAgentConfig(userId);
  const userOverride = cfg.reasoningByRuntime[runtimeId];
  if (userOverride) return userOverride;
  return BUILTIN_DEFAULT_REASONING_BY_RUNTIME[runtimeId];
}

/**
 * Resolve the effective Claude config dir, with "~" expanded to the home
 * directory. Returns undefined when unconfigured — callers must then leave
 * CLAUDE_CONFIG_DIR untouched so claude falls back to its own default
 * (~/.claude, or an env var the launch shell exported). Cloud-mode configs
 * never carry this field (the backend can't reach the user's filesystem).
 */
export function resolveClaudeConfigDir(userId?: string): string | undefined {
  const dir = getAgentConfig(userId).claudeConfigDir;
  if (!dir) return undefined;
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

export function getBuiltinDefaultModel(runtimeId: string): string {
  return BUILTIN_DEFAULT_MODEL_BY_RUNTIME[runtimeId] ?? "";
}

export function getBuiltinDefaultReasoning(runtimeId: string): AgentReasoning | undefined {
  return BUILTIN_DEFAULT_REASONING_BY_RUNTIME[runtimeId];
}

/** Keep a registered saved choice. Public installs never select by registration order. */
export function reconcileRuntimeWithRegistered(registeredIds: readonly string[]): void {
  if (!current.runtime || registeredIds.length === 0 || registeredIds.includes(current.runtime)) return;
  const fallback = "";
  console.warn(`[agentConfig] configured runtime '${current.runtime}' is not registered; ${fallback ? `using '${fallback}'` : 'waiting for a runtime choice'}`);
  updateAgentConfig({ runtime: fallback });
}

/**
 * Resolve the effective provider for a runtime. For Pi, dynamically picks
 * the best provider based on key availability rather than a static default.
 *
 * Priority:
 *   1. providerByRuntime[runtimeId] — last explicitly-used provider for this runtime
 *   2. First provider with a configured key
 *   3. openrouter-free (no key required)
 *
 * Other runtimes return their per-runtime memory when present, else
 * cfg.provider. Non-provider runtimes (kiro/claude) ignore the value anyway.
 */
export function resolveProvider(runtimeId: string, userId?: string): string {
  const cfg = getAgentConfig(userId);
  if (runtimeId === "pi") {
    return resolveDefaultPiProvider(cfg.providerByRuntime, cfg.provider, userId);
  }
  return cfg.providerByRuntime[runtimeId] ?? cfg.provider;
}

/**
 * Record a per-runtime provider choice. Called when the user explicitly
 * switches providers — persists the mapping so switching back to this
 * runtime later restores their last-used provider.
 */
export function updateProviderForRuntime(
  runtimeId: string,
  providerId: string,
  userId?: string,
): AgentConfig {
  return updateAgentConfig(
    { provider: providerId, providerByRuntime: { [runtimeId]: providerId } },
    userId,
  );
}

/**
 * Remember the provider + model a conversation actually ran with, so a new
 * pane switched to this runtime lands on the same pair instead of the
 * built-in fallback. Pane-level picks never go through /agent/options, so
 * this is the only place they become "last used".
 *
 * Provider runtimes (Pi) pass their provider: the two fields are written
 * together because modelByRuntime is only meaningful under the provider it
 * was chosen for. Runtimes without provider-scoped models (Kiro, Claude,
 * Codex) pass `null` and only the model is recorded, so providerByRuntime
 * stays limited to provider runtimes.
 *
 * Returns true when the stored memory changed; no-op otherwise.
 */
export function recordLastUsedProviderModel(
  runtimeId: string,
  providerId: string | null,
  modelId: string | null | undefined,
  userId?: string,
): boolean {
  const cfg = getAgentConfig(userId);
  if (providerId === null) {
    if (!modelId || cfg.modelByRuntime[runtimeId] === modelId) return false;
    updateAgentConfig({ modelByRuntime: { [runtimeId]: modelId } }, userId);
    return true;
  }
  const providerChanged = cfg.providerByRuntime[runtimeId] !== providerId;
  const modelChanged = !!modelId && cfg.modelByRuntime[runtimeId] !== modelId;
  if (!providerChanged && !modelChanged) return false;
  updateAgentConfig(
    {
      providerByRuntime: { [runtimeId]: providerId },
      ...(modelId || providerChanged ? { modelByRuntime: { [runtimeId]: modelId || '' } } : {}),
    },
    userId,
  );
  return true;
}
