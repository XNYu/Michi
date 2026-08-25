/**
 * Dynamic model fetcher for OpenRouter.
 *
 * The upstream pi-ai package ships a static model list that is generated
 * at publish time. This module fetches the live catalog from
 * https://openrouter.ai/api/v1/models (public, no key required) and
 * caches it in memory with a TTL. Falls back to the pi-ai static list
 * when the network call fails.
 */

import type { PiModelInfo } from "./piProviders";

interface OpenRouterApiModel {
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    pricing?: { prompt: string; completion: string };
    architecture?: {
        modality?: string;
        input_modalities?: string[];
        output_modalities?: string[];
    };
    top_provider?: {
        context_length?: number;
        max_completion_tokens?: number;
    };
    supported_parameters?: string[];
    reasoning?: unknown;
}

export interface OpenRouterModelInfo extends PiModelInfo {
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    max_tokens: number;
}

let cachedModels: OpenRouterModelInfo[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function pricePerMillion(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
}

/**
 * Fetch the live OpenRouter model catalog.
 * Returns null on failure so the caller can fall back to the static list.
 */
export async function fetchOpenRouterModels(
    apiKey?: string | null,
): Promise<OpenRouterModelInfo[] | null> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
        return cachedModels;
    }

    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);

        const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers,
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            console.warn(
                `[openrouterModels] /api/v1/models returned ${res.status}`,
            );
            return cachedModels; // stale cache or null
        }

        const body = (await res.json()) as { data?: OpenRouterApiModel[] };
        const data = body.data;
        if (!Array.isArray(data)) {
            console.warn("[openrouterModels] unexpected response shape");
            return cachedModels;
        }

        cachedModels = data
            .filter(
                (m) =>
                    m.id &&
                    // Exclude image-generation-only models
                    !m.architecture?.modality?.includes("image->") &&
                    !m.id.includes("/images/"),
            )
            .map((m) => ({
                model_id: m.id,
                model_name: m.name || m.id,
                description: m.description,
                context_window_tokens:
                    m.top_provider?.context_length ?? m.context_length,
                reasoning:
                    !!m.reasoning ||
                    !!m.supported_parameters?.some((parameter) =>
                        parameter === "reasoning" ||
                        parameter === "reasoning_effort" ||
                        parameter === "include_reasoning"
                    ),
                input: [
                    "text" as const,
                    ...(m.architecture?.input_modalities?.includes("image")
                        ? ["image" as const]
                        : []),
                ],
                cost: {
                    input: pricePerMillion(m.pricing?.prompt),
                    output: pricePerMillion(m.pricing?.completion),
                    cacheRead: 0,
                    cacheWrite: 0,
                },
                max_tokens: m.top_provider?.max_completion_tokens ?? 16_384,
            }));

        lastFetchTime = now;
        return cachedModels;
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            console.warn("[openrouterModels] fetch timed out");
        } else {
            console.warn("[openrouterModels] fetch failed:", err);
        }
        return cachedModels; // stale cache or null
    }
}

/** Force-invalidate the cache (e.g. after a manual refresh). */
export function invalidateOpenRouterCache(): void {
    cachedModels = null;
    lastFetchTime = 0;
}
