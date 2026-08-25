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
