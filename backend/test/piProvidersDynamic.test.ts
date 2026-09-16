import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const originalFetch = global.fetch;
const piAiModule = require("../src/agents/pi/piAi") as {
  loadPiAi: () => Promise<unknown>;
};
const originalLoadPiAi = piAiModule.loadPiAi;
const openRouterModels = require("../src/agents/pi/openrouterModels") as typeof import("../src/agents/pi/openrouterModels");

afterEach(() => {
  global.fetch = originalFetch;
  piAiModule.loadPiAi = originalLoadPiAi;
  openRouterModels.invalidateOpenRouterCache();
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

test("resolves an OpenRouter live-catalog model missing from pi-ai's static catalog", async () => {
  piAiModule.loadPiAi = async () => ({ getModel: () => undefined });
  global.fetch = async () => new Response(JSON.stringify({
    data: [{
      id: "stealth/ox-alpha",
      name: "Ox Alpha",
      description: "Reasoning model for coding",
      context_length: 1_048_576,
      architecture: {
        modality: "text+image+video->text",
        input_modalities: ["text", "image", "video"],
        output_modalities: ["text"],
      },
      pricing: { prompt: "0", completion: "0" },
      top_provider: {
        context_length: 1_048_576,
        max_completion_tokens: 131_072,
      },
      supported_parameters: ["reasoning", "reasoning_effort", "tools"],
      reasoning: { mandatory: true },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  const { resolvePiModel } = require("../src/agents/pi/piProviders") as typeof import("../src/agents/pi/piProviders");
  const model = await resolvePiModel("openrouter", "stealth/ox-alpha");

  assert.equal(model.id, "stealth/ox-alpha");
  assert.equal(model.name, "Ox Alpha");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "openrouter");
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.maxTokens, 131_072);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
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
