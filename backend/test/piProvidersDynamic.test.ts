import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const originalFetch = global.fetch;
const piAiModule = require("../src/agents/pi/piAi") as {
  loadPiAi: () => Promise<unknown>;
};
const originalLoadPiAi = piAiModule.loadPiAi;
const openRouterModels = require("../src/agents/pi/openrouterModels") as typeof import("../src/agents/pi/openrouterModels");
const discovery = require("../src/agents/pi/providerModelDiscovery") as typeof import("../src/agents/pi/providerModelDiscovery");

afterEach(() => {
  global.fetch = originalFetch;
  piAiModule.loadPiAi = originalLoadPiAi;
  openRouterModels.invalidateOpenRouterCache();
  discovery.resetModelDiscoveryForTests();
  delete process.env.MICHI_MODEL_DISCOVERY;
});

test('Pi model catalogs preserve SDK model-specific effort capabilities', async () => {
  const actual = await originalLoadPiAi() as { getSupportedThinkingLevels: (model: unknown) => string[] };
  piAiModule.loadPiAi = async () => ({
    getSupportedThinkingLevels: actual.getSupportedThinkingLevels,
    getModels: () => [
      { id: 'plain', name: 'Plain', reasoning: false },
      { id: 'thinking', name: 'Thinking', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: null } },
    ],
  });
  const { listPiModels } = require('../src/agents/pi/piProviders') as typeof import('../src/agents/pi/piProviders');
  const models = await listPiModels('openai');
  assert.equal(models[0].supportsReasoning, false);
  assert.deepEqual(models[0].supportedReasoningLevels, []);
  assert.deepEqual(models[1].supportedReasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(models[1].defaultReasoning, 'high');
});

test("returns a safe OpenRouter descriptor when the live catalog is unavailable", async () => {
  piAiModule.loadPiAi = async () => ({ getModel: () => undefined });
  global.fetch = async () => {
    throw new Error("offline");
  };

  const { resolvePiModel } = require("../src/agents/pi/piProviders") as typeof import("../src/agents/pi/piProviders");
  const model = await resolvePiModel("openrouter", "vendor/new-model");

  assert.equal(model.id, "vendor/new-model");
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 16_384);
});

test('OpenRouter Argon has only its supported effort levels and retains live limits and pricing', async () => {
  const actual: any = await originalLoadPiAi();
  piAiModule.loadPiAi = async () => ({ getModel: () => undefined, getSupportedThinkingLevels: actual.getSupportedThinkingLevels });
  global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'google/gemini-4-argon', name: 'Google: Gemini 4 Argon', context_length: 1_048_576,
    pricing: { prompt: '0.000002', completion: '0.00001' }, top_provider: { max_completion_tokens: 65_536 }, supported_parameters: ['reasoning'] }] }));
  const { listPiModels, resolvePiModel } = require('../src/agents/pi/piProviders');
  const models = await listPiModels('openrouter');
  assert.deepEqual(models[0].supportedReasoningLevels, ['low', 'medium', 'high']);
  assert.equal(models[0].defaultReasoning, 'medium');
  const model = await resolvePiModel('openrouter', 'google/gemini-4-argon');
  assert.deepEqual(actual.getSupportedThinkingLevels(model), ['low', 'medium', 'high']);
  assert.equal(model.maxTokens, 65_536);
  assert.equal(model.cost.input, 2);
});

test("Cerebras model catalog returns qwen-3.8-27b and gpt-oss-120b, excluding decommissioned gemma-4-31b", async () => {
  const { listPiModels, resolvePiModel, resolveProviderModel, getModelAttemptIds } = require("../src/agents/pi/piProviders") as typeof import("../src/agents/pi/piProviders");

  const models = await listPiModels("cerebras");
  const modelIds = models.map((m) => m.model_id);

  assert.ok(modelIds.includes("qwen-3.8-27b"), "Should include qwen-3.8-27b");
  assert.ok(modelIds.includes("gpt-oss-120b"), "Should include gpt-oss-120b");
  assert.ok(!modelIds.includes("gemma-4-31b"), "Should not include decommissioned gemma-4-31b");

  // Resolving qwen-3.8-27b
  const qwenModel = await resolvePiModel("cerebras", "qwen-3.8-27b");
  assert.equal(qwenModel.id, "qwen-3.8-27b");
  assert.equal(qwenModel.provider, "cerebras");
  assert.equal(qwenModel.api, "openai-completions");

  // Resolving decommissioned gemma-4-31b automatically aliases to defaultModel
  const aliasedModel = await resolvePiModel("cerebras", "gemma-4-31b");
  assert.equal(aliasedModel.id, "gpt-oss-120b");

  // Model resolution and attempt IDs fallback for gemma-4-31b
  const resolved = await resolveProviderModel("cerebras", "gemma-4-31b");
  assert.equal(resolved, "gpt-oss-120b");

  const resolvedQwen = await resolveProviderModel("cerebras", "qwen-3.8-27b");
  assert.equal(resolvedQwen, "qwen-3.8-27b");

  const attemptIds = getModelAttemptIds("cerebras", "gemma-4-31b");
  assert.deepEqual(attemptIds, ["gpt-oss-120b"]);
});

test("DeepSeek's default is its floating alias and survives an offline catalog", async () => {
  global.fetch = async () => { throw new Error("offline"); };
  const { getProviderInfo, listPiModels, resolvePiModel, resolveProviderModel, selectDefaultModelId } =
    require("../src/agents/pi/piProviders") as typeof import("../src/agents/pi/piProviders");

  assert.equal(selectDefaultModelId(getProviderInfo("deepseek")!), "deepseek-chat");

  const models = await listPiModels("deepseek");
  assert.equal(models[0].model_id, "deepseek-chat", "the default must be in the catalog or /agent/models sanitizes it away");
  assert.ok(models.some((m) => m.model_id === "deepseek-v4-pro"), "the pinned entry stays selectable");

  assert.equal(await resolveProviderModel("deepseek"), "deepseek-chat");
  assert.equal(await resolveProviderModel("deepseek", "deepseek-v4-pro"), "deepseek-v4-pro", "an explicit pin wins");

  const alias = await resolvePiModel("deepseek", "deepseek-chat");
  assert.equal(alias.id, "deepseek-chat");
  assert.equal(alias.api, "openai-completions");
  assert.equal(alias.baseUrl, "https://api.deepseek.com");
  assert.equal(alias.contextWindow, 1_000_000, "descriptor comes from the pinned template");
});

test("a model released after pi-ai published its catalog is listed, selectable and resolvable", async () => {
  global.fetch = async (url: unknown) => {
    assert.equal(String(url), "https://api.deepseek.com/models");
    return new Response(JSON.stringify({ data: [{ id: "deepseek-v4.1", created: 1_760_000_000 }] }));
  };
  const { listPiModels, resolvePiModel, resolveProviderModel } =
    require("../src/agents/pi/piProviders") as typeof import("../src/agents/pi/piProviders");

  const models = await listPiModels("deepseek");
  assert.ok(models.some((m) => m.model_id === "deepseek-v4.1"), "live catalog adds the new id");
  assert.equal(await resolveProviderModel("deepseek", "deepseek-v4.1"), "deepseek-v4.1");

  const resolved = await resolvePiModel("deepseek", "deepseek-v4.1");
  assert.equal(resolved.id, "deepseek-v4.1");
  assert.equal(resolved.baseUrl, "https://api.deepseek.com");
});

test("discovery speaks each provider dialect, caches the answer and names the secret in a header", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  global.fetch = async (url: unknown, init: any) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      models: [
        { name: "models/gemini-3.9-pro", displayName: "Gemini 3.9 Pro", inputTokenLimit: 2_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-9", supportedGenerationMethods: ["embedContent"] },
      ],
    }));
  };

  const models = await discovery.discoverProviderModels({
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    dialect: "gemini",
    apiKey: "test-key",
  });

  assert.deepEqual(models?.map((m) => m.id), ["gemini-3.9-pro"], "non-generating models are dropped");
  assert.equal(models?.[0].contextWindow, 2_000_000);
  assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(seen[0].headers["x-goog-api-key"], "test-key");

  await discovery.discoverProviderModels({
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    dialect: "gemini",
    apiKey: "test-key",
  });
  assert.equal(seen.length, 1, "the second read is served from cache");
});

test("a provider without a live catalog leaves the static list alone", async () => {
  global.fetch = async () => new Response("nope", { status: 404 });
  assert.equal(await discovery.discoverProviderModels({
    provider: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    dialect: "openai",
  }), null);

  const models = await listPiModelsForTest("deepseek");
  assert.ok(models.some((m) => m.model_id === "deepseek-v4-pro"));
  assert.ok(models.some((m) => m.model_id === "deepseek-chat"));
});

test("a hanging live endpoint cannot block the catalog read", async () => {
  global.fetch = () => new Promise<Response>(() => { /* never settles */ });
  const started = Date.now();
  const models = await listPiModelsForTest("deepseek");
  assert.ok(Date.now() - started < 5_000, "the read answers within the discovery budget");
  assert.equal(models[0].model_id, "deepseek-chat");
  assert.ok(models.some((m) => m.model_id === "deepseek-v4-pro"));
});

test("MICHI_MODEL_DISCOVERY=0 keeps the catalog static and offline", async () => {
  process.env.MICHI_MODEL_DISCOVERY = "0";
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("must not be called"); };

  const models = await listPiModelsForTest("deepseek");

  assert.equal(calls, 0);
  assert.ok(models.some((m) => m.model_id === "deepseek-chat"));
  assert.equal(models[0].model_id, "deepseek-chat");
});

function listPiModelsForTest(provider: string) {
  const { listPiModels } = require("../src/agents/pi/piProviders") as typeof import("../src/agents/pi/piProviders");
  return listPiModels(provider);
}
