import { loadPiAi } from "./piAi";
import { DEFAULT_MODELS } from "../agentConfig";

export interface PiProviderInfo {
    id: string;
    name: string;
    apiKeyLabel: string;
    envVars: string[];
    defaultModel: string;
    supportsReasoning: boolean;
    keyUrl?: string;
}

export interface PiModelInfo {
    model_id: string;
    model_name: string;
    description?: string;
    context_window_tokens?: number;
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

export const PI_PROVIDERS: PiProviderInfo[] = [
    {
        id: "deepseek",
        name: "DeepSeek",
        apiKeyLabel: "DeepSeek API key",
        envVars: ["DEEPSEEK_API_KEY"],
        defaultModel: "deepseek-v4-pro",
        supportsReasoning: true,
        keyUrl: "https://platform.deepseek.com",
    },
    {
        id: "openai",
        name: "OpenAI",
        apiKeyLabel: "OpenAI API key",
        envVars: ["OPENAI_API_KEY"],
        defaultModel: "gpt-5.5",
        supportsReasoning: true,
        keyUrl: "https://platform.openai.com/api-keys",
    },
    {
        id: "anthropic",
        name: "Anthropic",
        apiKeyLabel: "Anthropic API key",
        envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
        defaultModel: DEFAULT_MODELS.pi,
        supportsReasoning: true,
        keyUrl: "https://console.anthropic.com/settings/keys",
    },
    {
        id: "google",
        name: "Google AI",
        apiKeyLabel: "Gemini API key",
        envVars: ["GEMINI_API_KEY"],
        defaultModel: "gemini-3-pro-preview",
        supportsReasoning: true,
        keyUrl: "https://aistudio.google.com/app/apikey",
    },
    {
        id: "xai",
        name: "xAI",
        apiKeyLabel: "xAI API key",
        envVars: ["XAI_API_KEY"],
        defaultModel: "grok-4",
        supportsReasoning: true,
        keyUrl: "https://console.x.ai",
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        apiKeyLabel: "OpenRouter API key",
        envVars: ["OPENROUTER_API_KEY"],
        defaultModel: "~anthropic/claude-sonnet-latest",
        supportsReasoning: true,
        keyUrl: "https://openrouter.ai/settings/keys",
    },
    {
        id: "mistral",
        name: "Mistral",
        apiKeyLabel: "Mistral API key",
        envVars: ["MISTRAL_API_KEY"],
        defaultModel: "mistral-large-latest",
        supportsReasoning: true,
        keyUrl: "https://console.mistral.ai/api-keys",
    },
    {
        id: "groq",
        name: "Groq",
        apiKeyLabel: "Groq API key",
        envVars: ["GROQ_API_KEY"],
        defaultModel: "llama-3.3-70b-versatile",
        supportsReasoning: true,
        keyUrl: "https://console.groq.com/keys",
    },
    {
        id: "cerebras",
        name: "Cerebras",
        apiKeyLabel: "Cerebras API key",
        envVars: ["CEREBRAS_API_KEY"],
        defaultModel: "gpt-oss-120b",
        supportsReasoning: true,
        keyUrl: "https://cloud.cerebras.ai",
    },
    {
        id: "moonshotai",
        name: "Moonshot AI",
        apiKeyLabel: "Moonshot API key",
        envVars: ["MOONSHOT_API_KEY"],
        defaultModel: "kimi-k2.6",
        supportsReasoning: true,
        keyUrl: "https://platform.moonshot.ai",
    },
    {
        id: "zai",
        name: "Z.ai",
        apiKeyLabel: "Z.ai API key",
        envVars: ["ZAI_API_KEY"],
        defaultModel: "glm-4.7",
        supportsReasoning: true,
        keyUrl: "https://z.ai",
    },
    {
        id: "fireworks",
        name: "Fireworks",
        apiKeyLabel: "Fireworks API key",
        envVars: ["FIREWORKS_API_KEY"],
        defaultModel: "accounts/fireworks/models/deepseek-v4-pro",
        supportsReasoning: true,
        keyUrl: "https://fireworks.ai/account/api-keys",
    },
    {
        id: "huggingface",
        name: "Hugging Face",
        apiKeyLabel: "Hugging Face token",
        envVars: ["HF_TOKEN"],
        defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        supportsReasoning: true,
        keyUrl: "https://huggingface.co/settings/tokens",
    },
];

export function listProviderInfos(): PiProviderInfo[] {
    return PI_PROVIDERS;
}

export function getProviderInfo(provider: string): PiProviderInfo | undefined {
    return PI_PROVIDERS.find((p) => p.id === provider);
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
    const piMod = await loadPiAi();
    const models = (piMod as any).getModels(provider) as Array<Record<string, any>>;
    return models.map((m) => ({
        model_id: String(m.id),
        model_name: String(m.name || m.id),
        description: typeof m.description === "string" ? m.description : undefined,
        context_window_tokens:
            typeof m.contextWindow === "number" ? m.contextWindow : undefined,
    }));
}

export async function resolveProviderModel(provider: string, requested?: string): Promise<string> {
    const info = getProviderInfo(provider);
    if (!info) {
        throw new Error(`Unsupported provider: ${provider}`);
    }
    const models = await listPiModels(provider);
    if (requested && models.some((m) => m.model_id === requested)) return requested;
    if (models.some((m) => m.model_id === info.defaultModel)) return info.defaultModel;
    return models[0]?.model_id ?? info.defaultModel;
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
    const apiKey = opts.apiKey ?? opts.key;
    if (!apiKey) {
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
    const model = (piMod as any).getModel(provider, modelId);
    const timeoutMs = opts.timeoutMs ?? 15_000;
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

        for await (const ev of (piMod as any).streamSimple(
            model,
            { messages, tools: [] },
            {
                apiKey,
                reasoning: "low",
                maxTokens: 16,
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
