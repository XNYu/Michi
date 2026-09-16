import { Router, Request, Response } from "express";
import {
  getAgentConfig,
  updateAgentConfig,
  updateAgentModelForRuntime,
  updateAgentReasoningForRuntime,
  resolveModel,
  resolveReasoning,
  resolveProvider,
  updateProviderForRuntime,
} from "../services/agentConfig";
import {
  getProviderApiKey,
  setProviderApiKey,
  listProviderKeyPresence,
} from "../services/secrets";
import {
  setUserProviderKey,
  clearUserProviderKey,
  listUserProviderKeys,
  getUserProviderKey,
} from "../services/userKeys";
import { listRuntimes, getRuntime } from "../agents/registry";
import { describeRuntimeCapabilities } from "../agents/capabilityDescriptors";
import { hasProviders } from "../agents/types";
import { getModelReasoningOptions } from '../agents/modelReasoning';
import { getProviderInfo, providerRequiresUserKey } from "../agents/pi/piProviders";
import { evaluateProviderReadiness } from "../services/providerReadiness";
import {
  hasBedrockCredentials,
  getBedrockConfigSanitized,
  saveBedrockConfig,
  clearBedrockConfig,
} from "../services/bedrockCredentials";
import type { AgentStatus, AgentRuntimeOption, AgentReasoning } from "../agents/types";

import type { RuntimeCatalogCache } from "../agents/runtimeModelCache";

const VALID_REASONING: AgentReasoning[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function setupAgentRoutes(opts?: { catalogCache?: RuntimeCatalogCache; customAgentsEnabled?: boolean }): Router {
  const catalogCache = opts?.catalogCache ?? null;
  const router = Router();

  router.get("/agent/status", async (_req: Request, res: Response) => {
    const userId = (_req as any).user?.id as string | undefined;
    const cfg = getAgentConfig(userId);
    const active = getRuntime(cfg.runtime);
    const all = listRuntimes();
    const availableRuntimes: AgentRuntimeOption[] = all.map((r) => ({
      id: r.id,
      label: r.label,
      available: true,
      requiresApiKey: r.capabilities.apiKeys === true,
    }));

    if (!active) {
      // No runtime registered yet — frontend hides chips and waits.
      const status: AgentStatus = {
        runtime: cfg.runtime,
        label: cfg.runtime,
        customAgentsEnabled: opts?.customAgentsEnabled ?? false,
        capabilities: {
          modes: false, permissions: false, models: false, providerModels: false, reasoning: false, supportedReasoningLevels: [],
          apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
        },
        capabilityDescriptor: describeRuntimeCapabilities(cfg.runtime),
        availableRuntimes,
        provider: resolveProvider(cfg.runtime, userId),
        providerByRuntime: cfg.providerByRuntime,
        model: resolveModel(cfg.runtime, userId),
        modelByRuntime: cfg.modelByRuntime,
        reasoning: resolveReasoning(cfg.runtime, userId),
        reasoningByRuntime: cfg.reasoningByRuntime,
        hasRequiredKey: true,
      };
      res.json(status);
      return;
    }

    // Providers (only meaningful for runtimes that report apiKeys capability).
    let providers: AgentStatus["providers"] = undefined;
    let hasRequiredKey = true;
    const effectiveProvider = resolveProvider(cfg.runtime, userId);

    if (hasProviders(active)) {
      const list = await active.listProviders();
      const userId = (_req as any).user?.id as string | undefined;
      // BYOK: in cloud mode, "do I have a key for X?" is per-user, not
      // global. The desktop disk store still wins when no user is bound.
      const presence: Record<string, boolean> = userId
        ? Object.fromEntries(
            listUserProviderKeys(userId).map((r) => [r.provider, true]),
          )
        : listProviderKeyPresence(list.map((p) => p.id));
      const readiness = evaluateProviderReadiness(list, {
        keyPresence: presence,
        resolveOperatorKey: (providerId) => getProviderApiKey(providerId, userId),
        hasAwsCredentials: hasBedrockCredentials(),
      });
      providers = readiness.providers;
      // hasRequiredKey gates the welcome modal. Provider selection can be
      // stale or point at an operator-managed provider that is temporarily
      // unavailable, while another provider already has usable credentials.
      // Treat Pi as configured when any currently-listed provider is usable;
      // ApiKeyGate separately checks whether the active provider needs a key.
      hasRequiredKey = readiness.hasRequiredKey;
    }

    const model = resolveModel(cfg.runtime, userId);
    // NOTE: We intentionally do NOT call active.listModels() here. The
    // /agent/models endpoint (below) handles sanitize-and-persist when an
    // invalid persisted model id is detected. Keeping this handler
    // listModels-free guarantees /agent/status responds within a few ms
    // even when warm() has not yet completed.

    const status: AgentStatus = {
      runtime: cfg.runtime,
      label: active.label,
      customAgentsEnabled: opts?.customAgentsEnabled ?? false,
      capabilities: active.capabilities,
      capabilityDescriptor: active.capabilityDescriptor ?? describeRuntimeCapabilities(active.id),
      availableRuntimes,
      provider: effectiveProvider,
      providers,
      providerByRuntime: getAgentConfig(userId).providerByRuntime,
      model,
      modelByRuntime: getAgentConfig(userId).modelByRuntime,
      reasoning: resolveReasoning(cfg.runtime, userId),
      reasoningByRuntime: cfg.reasoningByRuntime,
      hasRequiredKey,
    };
    res.json(status);
  });

  router.post("/agent/options", async (req: Request, res: Response) => {
    const userId = req.user?.id as string | undefined;
    const cfg = getAgentConfig(userId);
    const patch: Partial<typeof cfg> = {};
    let modelToSet: string | undefined;

    if (req.body?.runtime !== undefined) {
      if (typeof req.body.runtime !== "string" || !req.body.runtime.trim()) {
        res.status(400).json({ ok: false, error: "Invalid runtime" });
        return;
      }
      if (!getRuntime(req.body.runtime)) {
        res.status(400).json({ ok: false, error: `Unknown runtime: ${req.body.runtime}` });
        return;
      }
      patch.runtime = req.body.runtime;
    }
    if (req.body?.provider !== undefined) {
      if (typeof req.body.provider !== "string" || !req.body.provider.trim()) {
        res.status(400).json({ ok: false, error: "Invalid provider" });
        return;
      }
      patch.provider = req.body.provider.trim();
    }
    if (req.body?.model !== undefined) {
      if (typeof req.body.model !== "string" || !req.body.model.trim()) {
        res.status(400).json({ ok: false, error: "Invalid model" });
        return;
      }
      modelToSet = req.body.model.trim();
    }
    let reasoningToSet: AgentReasoning | undefined;
    if (req.body?.reasoning !== undefined) {
      if (!VALID_REASONING.includes(req.body.reasoning)) {
        res.status(400).json({
          ok: false,
          error: `Invalid reasoning level. Expected one of: ${VALID_REASONING.join(", ")}`,
        });
        return;
      }
      reasoningToSet = req.body.reasoning as AgentReasoning;
    }
    const runtimeForModel = getRuntime(patch.runtime ?? cfg.runtime);
    const effectiveRuntime = patch.runtime ?? cfg.runtime;

    // When switching runtime and no explicit provider was sent, auto-resolve
    // the best provider for that runtime (based on key availability).
    if (patch.runtime && !patch.provider) {
      const resolved = resolveProvider(patch.runtime, userId);
      patch.provider = resolved;
    }

    // When the user explicitly selects a provider, record it per-runtime
    // so switching back to this runtime later restores their choice. Only
    // provider runtimes (Pi) have this concept; recording the resolved
    // fallback for kiro/claude would just pollute the map.
    if (patch.provider && runtimeForModel?.capabilities.providerModels) {
      patch.providerByRuntime = { [effectiveRuntime]: patch.provider };
    }

    const providerForModel = patch.provider ?? resolveProvider(effectiveRuntime, userId);
    const providerInfo = runtimeForModel?.capabilities.providerModels
      ? getProviderInfo(providerForModel)
      : undefined;
    if (providerInfo?.modelLocked) {
      if (modelToSet !== undefined && modelToSet !== providerInfo.defaultModel) {
        res.status(400).json({
          ok: false,
          error: `Provider model is locked to ${providerInfo.defaultModel}`,
        });
        return;
      }
      if (patch.provider !== undefined && modelToSet === undefined) {
        modelToSet = providerInfo.defaultModel;
      }
    }
    if (reasoningToSet !== undefined && runtimeForModel) {
      try {
        const options = await getModelReasoningOptions(runtimeForModel, modelToSet ?? resolveModel(effectiveRuntime, userId), providerForModel, reasoningToSet);
        if (!options.levels.includes(reasoningToSet)) {
          res.status(400).json({ ok: false, error: 'This model does not support the selected thinking effort' });
          return;
        }
      } catch {
        res.status(503).json({ ok: false, error: 'Unable to verify model capabilities. Please retry.' });
        return;
      }
    }
    updateAgentConfig(patch, userId);
    if (modelToSet !== undefined) {
      updateAgentModelForRuntime(getAgentConfig(userId).runtime, modelToSet, userId);
    }
    if (reasoningToSet !== undefined) {
      updateAgentReasoningForRuntime(getAgentConfig(userId).runtime, reasoningToSet, userId);
    }
    res.json({ ok: true });
  });

  // Runtime-scoped catalog for the Agent editor and per-node composer pickers:
  // providers, models, and capabilities for ANY registered runtime, independent
  // of the currently active chat runtime. Cache-first with background revalidate.
  router.get("/agent/runtime-catalog", async (req: Request, res: Response) => {
    const runtimeId = typeof req.query.runtime === "string" ? req.query.runtime.trim() : "";
    const runtime = runtimeId ? getRuntime(runtimeId) : null;
    if (!runtime) {
      res.json({ providers: [], models: [], capabilities: null });
      return;
    }
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;

    // Cache-first: return cached catalog immediately when available.
    const cached = catalogCache?.loadCatalog(runtimeId, provider);
    if (cached) {
      res.json({
        providers: cached.providers,
        models: cached.models,
        capabilities: runtime.capabilities,
      });
      // Background revalidate — fire-and-forget.
      void (async () => {
        try {
          const freshProviders = hasProviders(runtime) ? await runtime.listProviders() : [];
          const freshModels = runtime.listModels ? await runtime.listModels({ provider }) : [];
          catalogCache!.saveCatalog(runtimeId, { models: freshModels, providers: freshProviders }, provider);
        } catch { /* best effort */ }
      })();
      return;
    }

    // Cache miss: synchronous fetch, then cache.
    const providers = hasProviders(runtime) ? await runtime.listProviders() : [];
    const models = runtime.listModels ? await runtime.listModels({ provider }) : [];
    catalogCache?.saveCatalog(runtimeId, { models, providers }, provider);
    res.json({ providers, models, capabilities: runtime.capabilities });
  });

  router.get("/agent/models", async (req: Request, res: Response) => {
    const userId = req.user?.id as string | undefined;
    const cfg = getAgentConfig(userId);
    const active = getRuntime(cfg.runtime);
    if (!active) {
      res.json({ models: [], sanitizedModel: null });
      return;
    }
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    const models = active.listModels ? await active.listModels({ provider }) : [];

    // Sanitize-and-persist: if the persisted model id is missing or not
    // present in the freshly-fetched list, fall back to the runtime's
    // first reported model and write it back so disk self-heals. Moved
    // here from /agent/status so /agent/status can stay sync-fast.
    const ids = models.map((m) => m.id);
    let sanitizedModel: string | null = null;
    const persisted = resolveModel(cfg.runtime, userId);
    if (active.capabilities.models && ids.length > 0) {
      if (!persisted || !ids.includes(persisted)) {
        sanitizedModel = models.find((m) => m.isDefault)?.id ?? ids[0];
        updateAgentModelForRuntime(cfg.runtime, sanitizedModel, userId);
      }
    }
    res.json({ models, sanitizedModel });
  });

  router.post("/agent/provider-key", (req: Request, res: Response) => {
    const provider = typeof req.body?.provider === "string" ? req.body.provider.trim() : "";
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!provider) {
      res.status(400).json({ ok: false, error: "Missing provider" });
      return;
    }
    if (!providerRequiresUserKey(provider)) {
      res.status(400).json({ ok: false, error: "Provider uses a built-in server key" });
      return;
    }
    if (!key) {
      res.status(400).json({ ok: false, error: "Empty key" });
      return;
    }
    // BYOK: in cloud mode, write the user-scoped encrypted slot. Desktop
    // / Electron mode falls through to the legacy disk store.
    const userId = req.user?.id as string | undefined;
    if (userId) {
      setUserProviderKey(userId, provider, key);
    } else {
      setProviderApiKey(provider, key);
    }
    res.json({ ok: true });
  });

  router.delete("/agent/provider-key/:provider", (req: Request<{ provider: string }>, res: Response) => {
    if (!providerRequiresUserKey(req.params.provider)) {
      res.status(400).json({ ok: false, error: "Provider uses a built-in server key" });
      return;
    }
    const userId = req.user?.id as string | undefined;
    if (userId) {
      clearUserProviderKey(userId, req.params.provider);
    } else {
      setProviderApiKey(req.params.provider, null);
    }
    res.json({ ok: true });
  });

  router.post("/agent/provider-key/verify", async (req: Request, res: Response) => {
    const cfg = getAgentConfig();
    const active = getRuntime(cfg.runtime);
    if (!active || !hasProviders(active)) {
      res.status(400).json({ ok: false, error: "Active runtime does not support key verification" });
      return;
    }
    try {
      // Cloud mode: if the request body omits a key, fall back to the
      // user's stored encrypted key (legacy desktop verifyProviderKey
      // already does the disk fallback). This keeps "verify the key I
      // just saved" working without sending the plaintext back over the
      // wire.
      const userId = req.user?.id as string | undefined;
      let body = req.body ?? {};
      if (userId && !body.key && body.provider) {
        const key = getUserProviderKey(userId, body.provider) ?? undefined;
        if (key) body = { ...body, key };
      }
      const result = await active.verifyProviderKey(body);
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  // -----------------------------------------------------------------------
  // Bedrock credential configuration
  // -----------------------------------------------------------------------

  /** Sanitized Bedrock config — never returns actual secret values. */
  router.get("/agent/bedrock-config", (_req: Request, res: Response) => {
    res.json(getBedrockConfigSanitized());
  });

  /** Save Bedrock credential config to ~/.michi/config.json. */
  router.post("/agent/bedrock-config", (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ ok: false, error: "Missing request body" });
      return;
    }
    saveBedrockConfig(body);
    res.json({ ok: true });
  });

  /** Clear Bedrock config from ~/.michi/config.json. */
  router.delete("/agent/bedrock-config", (_req: Request, res: Response) => {
    clearBedrockConfig();
    res.json({ ok: true });
  });

  /**
   * Verify Bedrock connection using saved or supplied credentials.
   * Re-uses the existing verifyProviderKey flow for the amazon-bedrock provider.
   */
  router.post("/agent/bedrock-config/verify", async (req: Request, res: Response) => {
    const cfg = getAgentConfig();
    const active = getRuntime(cfg.runtime);
    if (!active || !hasProviders(active)) {
      res.status(400).json({ ok: false, error: "Active runtime does not support verification" });
      return;
    }
    try {
      const result = await active.verifyProviderKey({ provider: "amazon-bedrock" });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  return router;
}
