import { loadPiAi } from "./piAi";
import { DEFAULT_MODELS } from "../agentConfig";
import { fetchOpenRouterModels, type OpenRouterModelInfo } from "./openrouterModels";
import {
    cachedDiscoveredModels,
    discoverProviderModels,
    type LiveProviderModel,
    type ModelDiscoveryDialect,
} from "./providerModelDiscovery";
import { getProviderApiKey } from "../../services/secrets";
import type { PiModelInfo } from "./piModelTypes";
import { isReasoningLevel, type ModelReasoningCapabilities } from 'michi-shared';
import { GEMINI_ARGON_ID, argonThinkingLevelMap, geminiArgonModel, isGeminiArgon, isOpenRouterArgon } from './geminiArgonModel';
import { streamPiModel } from './geminiArgonStream';

export interface PiProviderInfo {
    id: string;
    name: string;
    apiKeyLabel: string;
    envVars: string[];
    /**
     * Concrete catalog entry used as the descriptor template and the offline
     * fallback. `/models` also falls back to it when nothing better is known.
     */
    defaultModel: string;
    /**
     * Alias slug the provider itself documents as "the newest model of this
     * line" (DeepSeek `deepseek-chat`, Mistral `-latest`, OpenRouter `~…-latest`).
     * When set it is what users get by default, so the default follows a
     * release instead of pinning one — and `defaultModel` stays behind as the
     * descriptor template. Listing guarantees it appears in `listPiModels()`:
     * `/agent/models` sanitizes away any id the catalog does not contain.
     */
    floatingModel?: string;
    /**
     * Dialect of the provider's live `/models` catalog. Unset means the static
     * (pi-ai) catalog is the only source, e.g. Bedrock, which would need
     * ListFoundationModels plus AWS credentials.
     */
    discovery?: ModelDiscoveryDialect;
    supportsReasoning: boolean;
    keyUrl?: string;
    requiresUserKey?: boolean;
    modelLocked?: boolean;
    upstreamProviderId?: string;
    fallbackModel?: string;
    /**
     * How this provider authenticates. API-key-based providers use a single
     * string key; `aws-credential-chain` providers resolve credentials through
     * the AWS SDK default chain (profile, env vars, IAM roles, etc.).
     * Defaults to `'api-key'` when unset.
     */
    credentialMode?: "api-key" | "aws-credential-chain";
}

/**
 * Shape used by routes/agent.ts for POST /api/agent/provider-key/verify.
 * The route forwards req.body to runtime.verifyProviderKey({ provider, key, model? }).
 */
export interface VerifyPiProviderKeyOptions {
    provider?: string;
    key?: string;
    model?: string;
    timeoutMs?: number;
    /** Internal callers (PiRuntime) may pass apiKey directly when no body key was given. */
    apiKey?: string;
}

export interface VerifyPiProviderKeyResult {
    ok: boolean;
    provider: string;
    model: string;
    latencyMs: number;
    error?: string;
}

export const OPENROUTER_FREE_PROVIDER_ID = "openrouter-free";

// Locked model + fallback for the built-in "OpenRouter Free Trial" provider.
// Overridable per-deployment via env so the free model can be swapped
// (e.g. when OpenRouter rotates cloaked/free slugs) without a redeploy of code.
// Read once at import time — the server process picks these up at boot.
export const OPENROUTER_FREE_PRIMARY_MODEL =
    process.env.OPENROUTER_FREE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
export const OPENROUTER_FREE_FALLBACK_MODEL =
    process.env.OPENROUTER_FREE_FALLBACK_MODEL || "openrouter/free";

export const PI_PROVIDERS: PiProviderInfo[] = [
    {
        id: "anthropic",
        name: "Anthropic",
        apiKeyLabel: "Anthropic API key",
        envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
        defaultModel: DEFAULT_MODELS.pi,
        // No documented "newest Opus" alias exists, so the default stays pinned;
        // discovery keeps Opus/Sonnet/Haiku releases visible in the picker.
        discovery: "anthropic",
        supportsReasoning: true,
        keyUrl: "https://console.anthropic.com/settings/keys",
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        apiKeyLabel: "DeepSeek API key",
        envVars: ["DEEPSEEK_API_KEY"],
        defaultModel: "deepseek-v4-pro",
        // `deepseek-chat` is DeepSeek's own alias for the newest chat model, so
        // the default follows a release instead of pinning V4 Pro. The pinned
        // entry stays as the descriptor template (context, limits, thinking map).
        floatingModel: "deepseek-chat",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://platform.deepseek.com",
    },
    {
        id: "openai",
        name: "OpenAI",
        apiKeyLabel: "OpenAI API key",
        envVars: ["OPENAI_API_KEY"],
        defaultModel: "gpt-5.5",
        // Undated OpenAI ids float within a release line; there is no
        // "newest GPT" alias, so discovery carries the newer releases instead.
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://platform.openai.com/api-keys",
    },
    {
        id: "google",
        name: "Google AI",
        apiKeyLabel: "Gemini API key",
        envVars: ["GEMINI_API_KEY"],
        defaultModel: GEMINI_ARGON_ID,
        // Argon stays the default on purpose (custom streaming + thinking map);
        // discovery adds the Gemini releases pi-ai has not published yet.
        discovery: "gemini",
        supportsReasoning: true,
        keyUrl: "https://aistudio.google.com/app/apikey",
    },
    {
        id: "xai",
        name: "xAI",
        apiKeyLabel: "xAI API key",
        envVars: ["XAI_API_KEY"],
        defaultModel: "grok-4",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://console.x.ai",
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        apiKeyLabel: "OpenRouter API key",
        envVars: ["OPENROUTER_API_KEY"],
        defaultModel: "~anthropic/claude-sonnet-latest",
        // OpenRouter's `~` prefix is its own floating alias. Its live catalog
        // comes from openrouterModels.ts, so no `discovery` dialect is needed.
        floatingModel: "~anthropic/claude-sonnet-latest",
        supportsReasoning: true,
        keyUrl: "https://openrouter.ai/settings/keys",
    },
    {
        id: "mistral",
        name: "Mistral",
        apiKeyLabel: "Mistral API key",
        envVars: ["MISTRAL_API_KEY"],
        defaultModel: "mistral-large-latest",
        // Mistral's own `-latest` slugs already float; discovery covers the
        // models that appear under a new id instead of a new suffix.
        floatingModel: "mistral-large-latest",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://console.mistral.ai/api-keys",
    },
    {
        id: "groq",
        name: "Groq",
        apiKeyLabel: "Groq API key",
        envVars: ["GROQ_API_KEY"],
        defaultModel: "llama-3.3-70b-versatile",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://console.groq.com/keys",
    },
    {
        id: "cerebras",
        name: "Cerebras",
        apiKeyLabel: "Cerebras API key",
        envVars: ["CEREBRAS_API_KEY"],
        defaultModel: "gpt-oss-120b",
        // No discovery: CEREBRAS_MODELS below is the authority for this catalog
        // (it removes a decommissioned model and adds one pi-ai never had).
        supportsReasoning: true,
        keyUrl: "https://cloud.cerebras.ai",
    },
    {
        id: "moonshotai",
        name: "Moonshot AI",
        apiKeyLabel: "Moonshot API key",
        envVars: ["MOONSHOT_API_KEY"],
        defaultModel: "kimi-k2.6",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://platform.moonshot.ai",
    },
    {
        id: "zai",
        name: "Z.ai",
        apiKeyLabel: "Z.ai API key",
        envVars: ["ZAI_API_KEY"],
        defaultModel: "glm-4.7",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://z.ai",
    },
    {
        id: "fireworks",
        name: "Fireworks",
        apiKeyLabel: "Fireworks API key",
        envVars: ["FIREWORKS_API_KEY"],
        defaultModel: "accounts/fireworks/models/deepseek-v4-pro",
        discovery: "openai",
        supportsReasoning: true,
        keyUrl: "https://fireworks.ai/account/api-keys",
    },
    {
        id: "huggingface",
        name: "Hugging Face",
        apiKeyLabel: "Hugging Face token",
        envVars: ["HF_TOKEN"],
        defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        // Hugging Face ids are repo paths served by the router, not a
        // provider-owned catalog with a stable /models contract: static only.
        supportsReasoning: true,
        keyUrl: "https://huggingface.co/settings/tokens",
    },
    {
        id: "amazon-bedrock",
        name: "Amazon Bedrock",
        apiKeyLabel: "AWS Bearer Token (optional)",
        envVars: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID"],
        defaultModel: "anthropic.claude-sonnet-5",
        // Bedrock's catalog comes from ListFoundationModels, which needs the
        // AWS credential chain rather than an API key: static only for now.
        supportsReasoning: true,
        credentialMode: "aws-credential-chain",
        requiresUserKey: false,
    },
    {
        id: OPENROUTER_FREE_PROVIDER_ID,
        name: "OpenRouter Free Trial",
        apiKeyLabel: "Built-in OpenRouter trial",
        envVars: ["OPENROUTER_FREE_API_KEY", "OPENROUTER_API_KEY"],
        defaultModel: OPENROUTER_FREE_PRIMARY_MODEL,
        fallbackModel: OPENROUTER_FREE_FALLBACK_MODEL,
        upstreamProviderId: "openrouter",
        supportsReasoning: false,
        requiresUserKey: false,
        modelLocked: true,
        keyUrl: "https://openrouter.ai/settings/keys",
    },
];

export function listProviderInfos(): PiProviderInfo[] {
    return PI_PROVIDERS;
}

export function getProviderInfo(provider: string): PiProviderInfo | undefined {
    return PI_PROVIDERS.find((p) => p.id === provider);
}

export function getUpstreamProviderId(provider: string): string {
    return getProviderInfo(provider)?.upstreamProviderId ?? provider;
}

export function providerRequiresUserKey(provider: string): boolean {
    return getProviderInfo(provider)?.requiresUserKey !== false;
}

export function providerUsesAwsCredentials(provider: string): boolean {
    return getProviderInfo(provider)?.credentialMode === "aws-credential-chain";
}

/**
 * The model a user gets when they have not chosen one: the provider's own
 * floating alias when it documents one, otherwise the pinned catalog entry.
 * Every consumer that answers "what is the default" reads it from here, so
 * rotating a default is a one-line change in PI_PROVIDERS.
 */
export function selectDefaultModelId(info: PiProviderInfo): string {
    return info.floatingModel ?? info.defaultModel;
}

export function getModelAttemptIds(provider: string, requested?: string | null): string[] {
    const info = getProviderInfo(provider);
    if (!info) return requested ? [requested] : [];
    if (info.modelLocked) {
        return info.fallbackModel
            ? [info.defaultModel, info.fallbackModel]
            : [info.defaultModel];
    }
    if (provider === "cerebras" && requested === "gemma-4-31b") {
        return [info.defaultModel];
    }
    return [requested || selectDefaultModelId(info)];
}

export function isSupportedProvider(provider: unknown): provider is string {
    return typeof provider === "string" && !!getProviderInfo(provider);
}

/**
 * Look up an API key directly from process.env using the provider's
 * declared env vars. Used by secrets.ts via setProviderEnvBindings — the
 * binding table provides the env var list, secrets.ts reads them itself.
 */
export function getEnvProviderApiKey(provider: string): string | null {
    const info = getProviderInfo(provider);
    if (!info) return null;
    for (const envVar of info.envVars) {
        const value = process.env[envVar];
        if (value) return value;
    }
    return null;
}

/**
 * Bindings shape consumed by secrets.ts via setProviderEnvBindings(...).
 * Each entry maps a provider id to the ordered list of env vars that
 * may carry its API key. secrets.ts iterates these in order and returns
 * the first non-empty value.
 */
export function getProviderEnvBindings(): Array<{ provider: string; envVars: string[] }> {
    return PI_PROVIDERS.map((p) => ({ provider: p.id, envVars: p.envVars }));
}

export async function listPiModels(provider: string): Promise<PiModelInfo[]> {
    if (!isSupportedProvider(provider)) {
        throw new Error(`Unsupported provider: ${provider}`);
    }
    const info = getProviderInfo(provider)!;
    if (info.modelLocked) {
        const upstreamProvider = getUpstreamProviderId(provider);
        const piMod = await loadPiAi();
        const model = (piMod as any).getModel(upstreamProvider, info.defaultModel);
        return [{
            model_id: String(model.id),
            model_name: String(model.name || model.id),
            description: typeof model.description === "string" ? model.description : undefined,
            context_window_tokens:
                typeof model.contextWindow === "number" ? model.contextWindow : undefined,
            ...piModelReasoning(piMod, model, info.supportsReasoning),
        }];
    }

    // Cerebras: override stale pi-ai static catalog (removes decommissioned gemma-4-31b, adds qwen-3.8-27b)
    if (provider === "cerebras") {
        const piMod = await loadPiAi();
        return Object.values(CEREBRAS_MODELS).map((m) => ({
            model_id: String(m.id),
            model_name: String(m.name || m.id),
            description: typeof m.description === "string" ? m.description : undefined,
            context_window_tokens:
                typeof m.contextWindow === "number" ? m.contextWindow : undefined,
            ...piModelReasoning(piMod, m, info.supportsReasoning),
        }));
    }

    // OpenRouter: prefer dynamic fetch from live API, fall back to static list
    if (provider === "openrouter") {
        const apiKey = getEnvProviderApiKey(provider);
        const dynamic = await fetchOpenRouterModels(apiKey);
        if (dynamic && dynamic.length > 0) {
            const piMod = await loadPiAi();
            return dynamic.map((model) => ({ ...model, ...piModelReasoning(piMod, dynamicOpenRouterModel(model.model_id, model), info.supportsReasoning) }));
        }
        // fall through to static list below
    }

    const piMod = await loadPiAi();
    const builtinModels = (piMod as any).getModels(provider) as Array<Record<string, any>>;
    const rawModels: Array<Record<string, any>> = provider === 'google'
        ? [geminiArgonModel(), ...builtinModels.filter((model) => model.id !== GEMINI_ARGON_ID)]
        : builtinModels;
    const staticModels = rawModels.map((m) => toPiModelInfo(piMod, m, info.supportsReasoning));
    if (!info.discovery && !info.floatingModel) return staticModels;
    return mergeCatalogWithDiscovery(info, piMod, rawModels, staticModels);
}

function toPiModelInfo(
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
    model: any,
    providerSupportsReasoning: boolean,
): PiModelInfo {
    return {
        model_id: String(model.id),
        model_name: String(model.name || model.id),
        description: typeof model.description === "string" ? model.description : undefined,
        context_window_tokens:
            typeof model.contextWindow === "number" ? model.contextWindow : undefined,
        ...piModelReasoning(piMod, model, providerSupportsReasoning),
    };
}

/**
 * Base URL of a provider's catalog, read from the static entries instead of a
 * second hand-maintained table: every pi-ai model descriptor already carries
 * the `baseUrl` the provider is served from.
 */
function providerCatalogBaseUrl(
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
    provider: string,
): string | undefined {
    const models = (piMod as any).getModels?.(provider) as Array<Record<string, any>> | undefined;
    const baseUrl = models?.find((model) => typeof model?.baseUrl === "string")?.baseUrl;
    return typeof baseUrl === "string" && baseUrl ? baseUrl : undefined;
}

/**
 * Key for the discovery call, resolved the way the desktop app resolves it
 * (env first, then the stored key file). Cloud per-user keys are database
 * scoped and deliberately not consulted: discovery only enriches a catalog.
 */
function resolveDiscoveryApiKey(provider: string): string | null {
    try {
        return getProviderApiKey(provider);
    } catch {
        return null;
    }
}

/**
 * How long a catalog read waits for the live endpoint before answering from
 * what it already has. Discovery keeps running in the background, so the next
 * read is warm; this only keeps a cold or offline picker responsive.
 */
const DISCOVERY_BUDGET_MS = 1_500;

async function withinDiscoveryBudget<T>(
    task: Promise<T | null>,
    fallback: () => T | null,
): Promise<T | null> {
    const guarded = task.catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T | null>((resolve) => {
        timer = setTimeout(() => resolve(fallback()), DISCOVERY_BUDGET_MS);
    });
    try {
        return await Promise.race([guarded, deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function discoverLiveModels(
    info: PiProviderInfo,
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
): Promise<LiveProviderModel[]> {
    if (!info.discovery) return [];
    const baseUrl = providerCatalogBaseUrl(piMod, getUpstreamProviderId(info.id));
    if (!baseUrl) return [];
    const models = await withinDiscoveryBudget(
        discoverProviderModels({
            provider: info.id,
            baseUrl,
            dialect: info.discovery,
            // Resolves env then the desktop key file. In cloud the per-user key
            // lives in the database and is not reachable from a catalog read, so a
            // provider that requires auth simply contributes no live ids there.
            apiKey: resolveDiscoveryApiKey(info.id),
        }),
        () => cachedDiscoveredModels(info.id),
    );
    return models ?? [];
}

/**
 * The floating alias as a catalog entry. It is described from the pinned
 * model's descriptor — same API family, limits and thinking map — because an
 * alias has no metadata of its own; cost and context are the pinned model's
 * approximation, which is the honest thing to show for "some newer model".
 */
function floatingModelInfo(
    info: PiProviderInfo,
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
    rawModels: Array<Record<string, any>>,
): PiModelInfo {
    const alias = info.floatingModel!;
    const template = rawModels.find((model) => model.id === info.defaultModel);
    return {
        model_id: alias,
        model_name: `${info.name} (latest)`,
        description: `Follows ${alias} upstream, so this entry tracks the newest ${info.name} model instead of pinning a version.`,
        context_window_tokens:
            typeof template?.contextWindow === "number" ? template.contextWindow : undefined,
        ...(template
            ? piModelReasoning(piMod, template, info.supportsReasoning)
            : {
                supportsReasoning: info.supportsReasoning,
                supportedReasoningLevels: [],
            }),
    };
}

function discoveredModelInfo(
    info: PiProviderInfo,
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
    rawModels: Array<Record<string, any>>,
    live: LiveProviderModel,
): PiModelInfo {
    const template = rawModels.find((model) => model.id === info.defaultModel);
    return {
        model_id: live.id,
        model_name: live.name || live.id,
        description: "Listed by the provider's live catalog; pi-ai has not published it yet.",
        context_window_tokens: live.contextWindow
            ?? (typeof template?.contextWindow === "number" ? template.contextWindow : undefined),
        ...(template
            ? piModelReasoning(piMod, template, info.supportsReasoning)
            : {
                supportsReasoning: info.supportsReasoning,
                supportedReasoningLevels: [],
            }),
    };
}

/**
 * One catalog from three sources. The static list carries the metadata pi-ai
 * knows (cost, limits, thinking levels); discovery adds ids it does not; the
 * floating alias goes first because `models[0]` is what
 * `resolveProviderModel()` and the sanitizer fall back to, and because that is
 * the entry the default actually uses.
 */
async function mergeCatalogWithDiscovery(
    info: PiProviderInfo,
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
    rawModels: Array<Record<string, any>>,
    staticModels: PiModelInfo[],
): Promise<PiModelInfo[]> {
    const merged: PiModelInfo[] = [];
    const seen = new Set<string>();
    const push = (model: PiModelInfo) => {
        if (seen.has(model.model_id)) return;
        seen.add(model.model_id);
        merged.push(model);
    };

    if (info.floatingModel) push(floatingModelInfo(info, piMod, rawModels));
    for (const model of staticModels) push(model);
    for (const live of await discoverLiveModels(info, piMod)) {
        push(discoveredModelInfo(info, piMod, rawModels, live));
    }
    return merged;
}

function piModelReasoning(piMod: Awaited<ReturnType<typeof loadPiAi>>, model: any, providerSupportsReasoning: boolean): ModelReasoningCapabilities {
    if (isGeminiArgon(model) || (model.provider === 'openrouter' && isOpenRouterArgon(model.id))) {
        return { supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'medium' };
    }
    const supportsReasoning = providerSupportsReasoning && model.reasoning === true;
    const levels = supportsReasoning ? piMod.getSupportedThinkingLevels(model).filter(isReasoningLevel) : [];
    return { supportsReasoning, supportedReasoningLevels: levels, ...(levels.includes('high') ? { defaultReasoning: 'high' as const } : {}) };
}

export async function resolveProviderModel(provider: string, requested?: string): Promise<string> {
    const info = getProviderInfo(provider);
    if (!info) {
        throw new Error(`Unsupported provider: ${provider}`);
    }
    if (info.modelLocked) return info.defaultModel;

    // OpenRouter: allow arbitrary model ID passthrough. The upstream API
    // will validate/reject unknown IDs itself. This lets users type any
    // newly-added model slug (e.g. "stealth/ox-alpha") even before the
    // dynamic cache refreshes.
    if (provider === "openrouter" && requested) return requested;

    const models = await listPiModels(provider);
    if (requested && models.some((m) => m.model_id === requested)) return requested;
    // The static catalog lags a release, so an id it does not list may still be
    // real. A provider that speaks the OpenAI catalog dialect is authoritative
    // for its own ids, and a declared alias is authoritative by definition:
    // pass both through instead of silently snapping back to the default.
    if (requested && acceptsUnlistedModel(info, requested)) return requested;

    const fallback = selectDefaultModelId(info);
    if (models.some((m) => m.model_id === fallback)) return fallback;
    return models[0]?.model_id ?? fallback;
}

/** Whether an id the static catalog does not list may still reach the provider. */
function acceptsUnlistedModel(info: PiProviderInfo, modelId: string): boolean {
    if (modelId === info.floatingModel) return true;
    if (cachedDiscoveredModels(info.id)?.some((model) => model.id === modelId)) return true;
    return info.discovery === "openai";
}

const CEREBRAS_MODELS: Record<string, Record<string, unknown>> = {
    "gpt-oss-120b": {
        id: "gpt-oss-120b",
        name: "GPT OSS 120B",
        api: "openai-completions",
        provider: "cerebras",
        baseUrl: "https://api.cerebras.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.35, output: 0.75, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 40_960,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
        },
        thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
        },
    },
    "qwen-3.8-27b": {
        id: "qwen-3.8-27b",
        name: "Qwen 3.8 27B",
        api: "openai-completions",
        provider: "cerebras",
        baseUrl: "https://api.cerebras.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.20, output: 0.60, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 8_192,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
        },
        thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
        },
    },
};

const OPENROUTER_MODEL_DEFAULTS = {
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
    },
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
};

function dynamicOpenRouterModel(modelId: string, info?: OpenRouterModelInfo): Record<string, unknown> {
    return {
        ...OPENROUTER_MODEL_DEFAULTS,
        id: modelId,
        name: info?.model_name || modelId,
        reasoning: info?.reasoning ?? OPENROUTER_MODEL_DEFAULTS.reasoning,
        input: info?.input ?? OPENROUTER_MODEL_DEFAULTS.input,
        cost: info?.cost ?? OPENROUTER_MODEL_DEFAULTS.cost,
        contextWindow:
            info?.context_window_tokens ?? OPENROUTER_MODEL_DEFAULTS.contextWindow,
        maxTokens: info?.max_tokens ?? OPENROUTER_MODEL_DEFAULTS.maxTokens,
        ...(isOpenRouterArgon(modelId) ? { reasoning: true, thinkingLevelMap: argonThinkingLevelMap(false) } : {}),
    };
}

/**
 * Resolve the actual pi-ai Model object used for a turn.
 *
 * pi-ai's compatibility catalog is generated at package publish time, while
 * OpenRouter adds models continuously. A model selected from OpenRouter's live
 * catalog therefore may not exist in pi-ai yet. Build the compatible model
 * descriptor from live metadata instead of passing undefined into pi-agent-core.
 */
export async function resolvePiModel(provider: string, modelId: string): Promise<any> {
    const info = getProviderInfo(provider);
    if (!info) throw new Error(`Unsupported provider: ${provider}`);

    const upstreamProvider = getUpstreamProviderId(provider);

    if (upstreamProvider === 'google' && modelId === GEMINI_ARGON_ID) return geminiArgonModel();

    if (upstreamProvider === "cerebras") {
        const targetModelId = modelId === "gemma-4-31b" ? info.defaultModel : modelId;
        const overridden = CEREBRAS_MODELS[targetModelId];
        if (overridden) return overridden;
    }

    const piMod = await loadPiAi();
    const builtin = (piMod as any).getModel(upstreamProvider, modelId);
    if (builtin) return upstreamProvider === 'openrouter' && isOpenRouterArgon(modelId)
        ? { ...builtin, thinkingLevelMap: argonThinkingLevelMap(false) } : builtin;

    if (upstreamProvider === "openrouter") {
        const catalog = await fetchOpenRouterModels(getEnvProviderApiKey(provider));
        const dynamic = catalog?.find((model) => model.model_id === modelId);
        // Even when the public catalog is temporarily unavailable, return a
        // valid OpenRouter descriptor. OpenRouter remains the source of truth
        // and will return a clear upstream error if the model id is invalid.
        return dynamicOpenRouterModel(modelId, dynamic);
    }

    // A floating alias, or a release the provider added after pi-ai published
    // its catalog, has no descriptor of its own. Synthesize one from the pinned
    // entry (same API family, compat flags and thinking map) so the id can be
    // selected instead of being rejected as unknown.
    const synthesized = synthesizeProviderModel(piMod, info, upstreamProvider, modelId);
    if (synthesized) return synthesized;

    throw new Error(`Unknown model ${modelId} for provider ${provider}`);
}

/**
 * Descriptor for an id the static catalog does not contain. Only ids the
 * provider can plausibly serve qualify: its declared alias, an id its live
 * catalog just reported, or — for an OpenAI-compatible provider — any id,
 * because upstream is the source of truth there (same contract as OpenRouter).
 */
function synthesizeProviderModel(
    piMod: Awaited<ReturnType<typeof loadPiAi>>,
    info: PiProviderInfo,
    upstreamProvider: string,
    modelId: string,
): Record<string, unknown> | null {
    const isKnownAlias = info.floatingModel === modelId;
    const live = cachedDiscoveredModels(info.id)?.find((model) => model.id === modelId);
    if (!isKnownAlias && !live && info.discovery !== "openai") return null;

    const template = (piMod as any).getModel(upstreamProvider, info.defaultModel) as
        | Record<string, any>
        | undefined;
    const baseUrl = template?.baseUrl ?? providerCatalogBaseUrl(piMod, upstreamProvider);
    if (!template && !baseUrl) return null;

    const base = template ?? {
        api: "openai-completions",
        provider: upstreamProvider,
        baseUrl,
        reasoning: info.supportsReasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false },
    };

    return {
        ...base,
        id: modelId,
        name: live?.name || (isKnownAlias ? `${info.name} (latest)` : modelId),
        ...(live?.contextWindow ? { contextWindow: live.contextWindow } : {}),
        ...(live?.maxTokens ? { maxTokens: live.maxTokens } : {}),
    };
}

function formatVerifyError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error);
    } catch {
        return "Provider verification failed";
    }
}

import { resolveBedrockCredentials } from "../../services/bedrockCredentials";

/**
 * Verify a provider's API key by issuing a minimal streamSimple call
 * ("Reply with exactly: OK") and waiting for a "done" event. Returns
 * structured success/failure rather than throwing — the route layer
 * surfaces the result body to the user as-is.
 *
 * Argument shape matches what routes/agent.ts forwards:
 *   { provider, key, model? }
 * — `key` and the alternate `apiKey` field are interchangeable.
 */
export async function verifyPiProviderKey(
    opts: VerifyPiProviderKeyOptions,
): Promise<VerifyPiProviderKeyResult> {
    const provider = opts.provider;
    if (!isSupportedProvider(provider)) {
        return {
            ok: false,
            provider: String(provider ?? ""),
            model: "",
            latencyMs: 0,
            error: `Unsupported provider: ${provider}`,
        };
    }

    // Bedrock: authenticate via AWS credential chain, not a single API key.
    const isAwsCred = providerUsesAwsCredentials(provider);
    const apiKey = isAwsCred ? null : (opts.apiKey ?? opts.key);
    let bedrockOpts: Record<string, unknown> = {};

    if (isAwsCred) {
        const creds = resolveBedrockCredentials();
        if (!creds) {
            return {
                ok: false,
                provider,
                model: "",
                latencyMs: 0,
                error: "Amazon Bedrock credentials not configured — add them in Settings or set AWS_PROFILE + AWS_REGION env vars.",
            };
        }
        bedrockOpts = { region: creds.region };
        if (creds.bearerToken) bedrockOpts.bearerToken = creds.bearerToken;
        if (creds.profile) bedrockOpts.profile = creds.profile;
        if (creds.accessKeyId) {
            bedrockOpts.accessKeyId = creds.accessKeyId;
            bedrockOpts.secretAccessKey = creds.secretAccessKey;
        }
    } else if (!apiKey) {
        return {
            ok: false,
            provider,
            model: "",
            latencyMs: 0,
            error: "No API key to verify",
        };
    }
    let modelId: string;
    try {
        modelId = await resolveProviderModel(provider, opts.model);
    } catch (err) {
        return {
            ok: false,
            provider,
            model: "",
            latencyMs: 0,
            error: formatVerifyError(err),
        };
    }

    const piMod = await loadPiAi();
    const model = await resolvePiModel(provider, modelId);
    const argon = isGeminiArgon(model) || (provider === 'openrouter' && isOpenRouterArgon(modelId));
    const timeoutMs = opts.timeoutMs ?? (argon ? 60_000 : 15_000);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const messages = [
            {
                role: "user",
                content: [{ type: "text", text: "Reply with exactly: OK" }],
                timestamp: Date.now(),
            },
        ];

        for await (const ev of streamPiModel(piMod,
            model,
            { messages, tools: [] },
            {
                ...(apiKey ? { apiKey } : {}),
                ...bedrockOpts,
                reasoning: "low",
                maxTokens: argon ? 32_768 : 16,
                maxRetries: 0,
                timeoutMs,
                signal: controller.signal,
            },
        )) {
            if (ev.type === "done") {
                return {
                    ok: true,
                    provider,
                    model: modelId,
                    latencyMs: Date.now() - started,
                };
            }
            if (ev.type === "error") {
                return {
                    ok: false,
                    provider,
                    model: modelId,
                    latencyMs: Date.now() - started,
                    error:
                        ev.reason === "aborted"
                            ? "Verification timed out"
                            : ev.error?.errorMessage || "Provider returned an error",
                };
            }
        }

        return {
            ok: false,
            provider,
            model: modelId,
            latencyMs: Date.now() - started,
            error: "Provider returned no verification response",
        };
    } catch (err) {
        return {
            ok: false,
            provider,
            model: modelId,
            latencyMs: Date.now() - started,
            error: controller.signal.aborted ? "Verification timed out" : formatVerifyError(err),
        };
    } finally {
        clearTimeout(timer);
    }
}
