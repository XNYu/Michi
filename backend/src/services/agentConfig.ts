import fs from "fs";
import { EventEmitter } from "node:events";
import path from "path";
import os from "os";
import type { RuntimeId, AgentReasoning } from "../agents/types";
import { getUserAgentConfig, upsertUserAgentConfig } from "./dbRepository";
import { DEFAULT_MODELS } from "../agents/agentConfig";
import { resolveDefaultPiProvider } from "./resolveProvider";

export interface AgentConfig {
  runtime: RuntimeId;
  provider: string;
  /**
   * Per-runtime provider memory. When the user explicitly switches providers
   * while on a specific runtime, the choice is recorded here so switching
   * back to that runtime later restores it automatically.
   */
  providerByRuntime: Record<string, string>;
  modelByRuntime: Record<string, string>;
  reasoningByRuntime: Record<string, AgentReasoning>;
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

const CONFIG_DIR = path.join(os.homedir(), ".michi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// Hard-coded default model per runtime. Used when neither
// agentConfig.modelByRuntime nor a per-call override picks one.
// Empty string means "let the runtime pick from listModels()".
const BUILTIN_DEFAULT_MODEL_BY_RUNTIME: Record<string, string> = {
  claude: "sonnet",
  // Keep in lockstep with the default Pi provider (anthropic).
  pi: DEFAULT_MODELS.pi,
  kiro: "",
};

// Hard-coded default reasoning level per runtime. Used when neither
// agentConfig.reasoningByRuntime nor a per-call override picks one.
const BUILTIN_DEFAULT_REASONING_BY_RUNTIME: Record<string, AgentReasoning> = {
  claude: "high",
  pi: "high",
  kiro: "high",
};

const DEFAULTS: AgentConfig = {
  runtime: process.env.MICHI_DEFAULT_RUNTIME ?? "kiro",
  provider: "anthropic",
  providerByRuntime: {},
  modelByRuntime: {},
  reasoningByRuntime: {},
};

const VALID_REASONING: AgentReasoning[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

let current: AgentConfig = {
  ...DEFAULTS,
  providerByRuntime: { ...DEFAULTS.providerByRuntime },
  modelByRuntime: { ...DEFAULTS.modelByRuntime },
  reasoningByRuntime: { ...DEFAULTS.reasoningByRuntime },
};

let warnedAboutLegacy = false;

export function normalizeLegacyRuntimeId(runtime: string): RuntimeId {
  return runtime === "gemini" ? "antigravity" : runtime;
}

function readDiskFile(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
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

function persist(): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Read-modify-write: preserve any unrelated fields on disk (e.g. providerApiKeys)
    const existing = readDiskFile() ?? {};
    const next = { ...existing, agent: { ...current } };
    // Drop legacy `model` field if it lingers in the existing agent object.
    if (next.agent && "model" in next.agent) delete (next.agent as any).model;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[agentConfig] persist failed:", err);
  }
}

export function loadAgentConfig(): AgentConfig {
  const disk = readDiskFile();
  let next: AgentConfig = {
    ...DEFAULTS,
    providerByRuntime: { ...DEFAULTS.providerByRuntime },
    modelByRuntime: { ...DEFAULTS.modelByRuntime },
    reasoningByRuntime: { ...DEFAULTS.reasoningByRuntime },
  };
  let migratedFromLegacy = false;

  if (disk && typeof disk === "object") {
    if (disk.agent && typeof disk.agent === "object") {
      const a = disk.agent;
      if (typeof a.runtime === "string" && a.runtime.length > 0) {
        next.runtime = normalizeLegacyRuntimeId(a.runtime);
        if (a.runtime === "gemini") migratedFromLegacy = true;
      }
      if (typeof a.provider === "string" && a.provider) next.provider = a.provider;
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
          if (typeof v === "string" && VALID_REASONING.includes(v as AgentReasoning)) {
            next.reasoningByRuntime[k] = v as AgentReasoning;
          }
        }
      }
      // Migrate legacy `agent.model` (single string) into modelByRuntime[<current runtime>]
      if (typeof a.model === "string" && a.model && !next.modelByRuntime[next.runtime]) {
        next.modelByRuntime[next.runtime] = a.model;
        migratedFromLegacy = true;
      }
      // Migrate legacy `agent.reasoning` (single string) into reasoningByRuntime[<current runtime>]
      if (
        typeof a.reasoning === "string" &&
        VALID_REASONING.includes(a.reasoning as AgentReasoning) &&
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
        VALID_REASONING.includes(disk.agentReasoning as AgentReasoning)
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
      return {
        ...DEFAULTS,
        providerByRuntime: { ...DEFAULTS.providerByRuntime },
        modelByRuntime: { ...DEFAULTS.modelByRuntime },
        reasoningByRuntime: { ...DEFAULTS.reasoningByRuntime },
      };
    }
    let providerByRuntime: Record<string, string> = {};
    let modelByRuntime: Record<string, string> = {};
    let reasoningByRuntime: Record<string, AgentReasoning> = {};
    try { providerByRuntime = JSON.parse((row as any).provider_by_runtime ?? "{}"); } catch { /* keep {} */ }
    try { modelByRuntime = JSON.parse(row.model_by_runtime); } catch { /* keep {} */ }
    try {
      const raw = JSON.parse(row.reasoning_by_runtime);
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && VALID_REASONING.includes(v as AgentReasoning)) {
          reasoningByRuntime[k] = v as AgentReasoning;
        }
      }
    } catch { /* keep {} */ }
    return {
      runtime: normalizeLegacyRuntimeId(row.runtime),
      provider: row.provider,
      providerByRuntime,
      modelByRuntime,
      reasoningByRuntime,
    };
  }
  // Desktop / no userId: return the in-memory singleton.
  return current;
}

export function updateAgentConfig(patch: Partial<AgentConfig>, userId?: string): AgentConfig {
  // Cloud mode with a known user: write to DB.
  if (process.env.MICHI_CLOUD === '1' && userId) {
    const existing = getAgentConfig(userId);
    const mergedProviderByRuntime = patch.providerByRuntime
      ? { ...existing.providerByRuntime, ...patch.providerByRuntime }
      : { ...existing.providerByRuntime };
    const mergedModelByRuntime = patch.modelByRuntime
      ? { ...existing.modelByRuntime, ...patch.modelByRuntime }
      : { ...existing.modelByRuntime };
    const mergedReasoningByRuntime = patch.reasoningByRuntime
      ? { ...existing.reasoningByRuntime, ...patch.reasoningByRuntime }
      : { ...existing.reasoningByRuntime };
    upsertUserAgentConfig(userId, {
      runtime: (patch.runtime ?? existing.runtime) as string,
      provider: patch.provider ?? existing.provider,
      model_by_runtime: JSON.stringify(mergedModelByRuntime),
      reasoning_by_runtime: JSON.stringify(mergedReasoningByRuntime),
    });
    return {
      ...existing,
      ...patch,
      providerByRuntime: mergedProviderByRuntime,
      modelByRuntime: mergedModelByRuntime,
      reasoningByRuntime: mergedReasoningByRuntime,
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
  current = merged;
  persist();
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
  current = {
    ...current,
    modelByRuntime: { ...current.modelByRuntime, [runtimeId]: modelId },
  };
  persist();
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
  current = {
    ...current,
    reasoningByRuntime: { ...current.reasoningByRuntime, [runtimeId]: level },
  };
  persist();
  return current;
}

/**
 * Resolve the model id to use for a runtime. Priority:
 *   1. agentConfig.modelByRuntime[runtimeId]    (user override)
 *   2. BUILTIN_DEFAULT_MODEL_BY_RUNTIME[runtimeId]   (code-level default)
 *   3. ""                                       (let runtime decide)
 */
export function resolveModel(runtimeId: string, userId?: string): string {
  const cfg = getAgentConfig(userId);
  const userOverride = cfg.modelByRuntime[runtimeId];
  if (userOverride) return userOverride;
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

/**
 * Boot-time guard: if the persisted (or env-overridden) cfg.runtime is
 * not actually registered in this deployment (e.g. disk says 'kiro' but
 * MICHI_ENABLED_RUNTIMES=pi this run), migrate cfg.runtime to the first
 * registered runtime and persist it. Without this, /agent/status falls
 * back to a chip-less placeholder for the missing runtime, and Settings
 * won't auto-pick a working runtime — users get a stuck UI even though
 * the right runtime is registered.
 */
export function reconcileRuntimeWithRegistered(registeredIds: readonly string[]): void {
  if (registeredIds.length === 0) return;
  if (registeredIds.includes(current.runtime)) return;
  const fallback = registeredIds[0];
  console.warn(
    `[agentConfig] persisted runtime '${current.runtime}' is not registered (registered: ${registeredIds.join(", ")}); falling back to '${fallback}'`,
  );
  updateAgentConfig({ runtime: fallback });
}

/**
 * Resolve the effective provider for a runtime. For Pi, dynamically picks
 * the best provider based on key availability rather than a static default.
 *
 * Priority:
 *   1. providerByRuntime[runtimeId] — last explicitly-used provider for this runtime (if key still valid)
 *   2. First provider with a configured key
 *   3. openrouter-free (no key required)
 *
 * Other runtimes return cfg.provider as-is since they don't have the
 * multi-provider concept.
 */
export function resolveProvider(runtimeId: string, userId?: string): string {
  const cfg = getAgentConfig(userId);
  if (runtimeId === "pi") {
    return resolveDefaultPiProvider(cfg.providerByRuntime, cfg.provider, userId);
  }
  return cfg.provider;
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
