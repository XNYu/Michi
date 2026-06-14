/**
 * Probe each provider/model's supported reasoning levels.
 *
 * pi-ai's catalog only flags reasoning: true/false — the actual accepted
 * level set is enforced server-side and surfaces in 400 error messages.
 * This script:
 *   1. Iterates PI_PROVIDERS,
 *   2. For each provider with an env-supplied API key, finds reasoning-capable
 *      models in pi-ai's MODELS catalog,
 *   3. Probes each model by sending a tiny request with reasoning="__probe__"
 *      first (which gives the server's enum-validation error containing the
 *      full supported list), then falls back to individually probing each
 *      candidate level if no list is returned.
 *
 * Run from backend/:
 *   npx ts-node scripts/probe-reasoning-levels.ts          # all providers w/ keys
 *   npx ts-node scripts/probe-reasoning-levels.ts openai   # one provider
 *
 * Output: backend/scripts/reasoning-levels.json
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadPiAi } from "../src/agents/pi/piAi";
import {
    PI_PROVIDERS,
    getEnvProviderApiKey,
    type PiProviderInfo,
} from "../src/agents/pi/piProviders";

const CANDIDATE_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof CANDIDATE_LEVELS)[number];

interface ModelResult {
    model: string;
    supported: Level[];
    errored?: string;
    source: "error-list" | "per-level" | "skipped";
}

interface ProviderResult {
    provider: string;
    keyEnvVar: string | null;
    models: ModelResult[];
}

const OUT_PATH = path.join(__dirname, "reasoning-levels.json");

async function main() {
    const onlyProvider = process.argv[2];
    const piMod: any = await loadPiAi();

    const targets: PiProviderInfo[] = onlyProvider
        ? PI_PROVIDERS.filter((p) => p.id === onlyProvider)
        : PI_PROVIDERS;

    const results: ProviderResult[] = [];

    for (const provider of targets) {
        const apiKey = getEnvProviderApiKey(provider.id);
        const usedEnvVar = provider.envVars.find((v) => process.env[v]) ?? null;

        if (!apiKey) {
            console.log(`[skip] ${provider.id}: no env key (${provider.envVars.join("|")})`);
            results.push({ provider: provider.id, keyEnvVar: null, models: [] });
            continue;
        }

        const catalog = piMod.MODELS?.[provider.id] ?? {};
        const reasoningModels = Object.values(catalog).filter(
            (m: any) => m?.reasoning === true,
        ) as Array<{ id: string; name?: string }>;

        if (reasoningModels.length === 0) {
            console.log(`[skip] ${provider.id}: no reasoning-capable models in catalog`);
            results.push({ provider: provider.id, keyEnvVar: usedEnvVar, models: [] });
            continue;
        }

        console.log(
            `[probe] ${provider.id} via ${usedEnvVar} — ${reasoningModels.length} reasoning model(s)`,
        );

        const modelResults: ModelResult[] = [];
        for (const m of reasoningModels) {
            const res = await probeModel(piMod, provider.id, m.id, apiKey);
            modelResults.push(res);
            console.log(
                `  - ${m.id} → [${res.supported.join(", ")}]${
                    res.source === "error-list" ? " (from validation error)" : ""
                }${res.errored ? `  ⚠ ${res.errored}` : ""}`,
            );
        }
        results.push({ provider: provider.id, keyEnvVar: usedEnvVar, models: modelResults });

        // Write incrementally so partial runs aren't lost.
        fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
    console.log(`\nWrote ${OUT_PATH}`);
}

async function probeModel(
    piMod: any,
    providerId: string,
    modelId: string,
    apiKey: string,
): Promise<ModelResult> {
    // Phase 1: send an obviously-invalid value to coax the supported list out
    // of the server's enum validator.
    const sentinelErr = await singleProbe(piMod, providerId, modelId, apiKey, "__probe__" as any);
    if (sentinelErr) {
        const list = parseSupportedList(sentinelErr);
        if (list && list.length > 0) {
            return { model: modelId, supported: list, source: "error-list" };
        }
    }

    // Phase 2: fall back to probing each candidate level individually.
    const supported: Level[] = [];
    let lastErr: string | undefined;
    for (const level of CANDIDATE_LEVELS) {
        const err = await singleProbe(piMod, providerId, modelId, apiKey, level);
        if (!err) {
            supported.push(level);
        } else {
            // If we ever see a "supported values" list mid-probe, use it.
            const list = parseSupportedList(err);
            if (list && list.length > 0) {
                return { model: modelId, supported: list, source: "error-list" };
            }
            lastErr = err;
        }
    }
    return {
        model: modelId,
        supported,
        source: "per-level",
        errored: supported.length === 0 ? lastErr : undefined,
    };
}

/**
 * Returns the error message string if the call errored, or null on success.
 * Uses streamSimple with maxTokens=8 so the call costs almost nothing when
 * the level IS supported.
 */
async function singleProbe(
    piMod: any,
    providerId: string,
    modelId: string,
    apiKey: string,
    reasoning: string,
): Promise<string | null> {
    const model = piMod.getModel(providerId, modelId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        const messages = [
            { role: "user", content: [{ type: "text", text: "Reply OK." }], timestamp: Date.now() },
        ];
        for await (const ev of piMod.streamSimple(
            model,
            { messages, tools: [] },
            {
                apiKey,
                reasoning,
                maxTokens: 8,
                maxRetries: 0,
                timeoutMs: 15_000,
                signal: controller.signal,
            },
        )) {
            if (ev.type === "done") return null;
            if (ev.type === "error") {
                return ev.error?.errorMessage || ev.reason || "unknown error";
            }
        }
        return "no done event";
    } catch (err: any) {
        return err?.message ?? String(err);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Parses messages like:
 *   "Unsupported value: 'minimal' is not supported with the 'gpt-5.5' model.
 *    Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."
 * Returns the list of values, intersected with CANDIDATE_LEVELS.
 */
function parseSupportedList(msg: string): Level[] | null {
    const m = msg.match(/Supported values are[:\s]*([^.]+)/i);
    if (!m) return null;
    const tokens = m[1]
        .split(/[,\sand]+/)
        .map((s) => s.replace(/['"`]/g, "").trim().toLowerCase())
        .filter(Boolean);
    const out: Level[] = [];
    for (const t of tokens) {
        if ((CANDIDATE_LEVELS as readonly string[]).includes(t)) {
            out.push(t as Level);
        }
    }
    return out.length > 0 ? out : null;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
