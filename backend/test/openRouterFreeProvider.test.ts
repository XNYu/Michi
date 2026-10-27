// Must stay first: /agent/options would otherwise persist runtime/model to ~/.michi/config.json.
import "./isolatedConfigDir";
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";

import { setupAgentRoutes } from "../src/routes/agent";

function registerRuntimeForOptions(id: string, providerModels: boolean): void {
  const { registerRuntime } = require("../src/agents/registry");
  registerRuntime({
    id,
    label: id,
    capabilities: {
      modes: false,
      permissions: false,
      models: true,
      providerModels,
      reasoning: false,
      supportedReasoningLevels: [],
      apiKeys: false,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
      nativeResume: false,
    },
    newSession: async () => {
      throw new Error("not used");
    },
    shutdown: async () => {},
  });
}

describe("OpenRouter free trial provider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("advertises a built-in provider with the primary model locked as the visible model", async () => {
    const {
      getProviderInfo,
      listPiModels,
      OPENROUTER_FREE_PROVIDER_ID,
      OPENROUTER_FREE_PRIMARY_MODEL,
    } = require("../src/agents/pi/piProviders");

    const info = getProviderInfo(OPENROUTER_FREE_PROVIDER_ID);
    assert.ok(info);
    assert.equal(info.requiresUserKey, false);
    assert.equal(info.modelLocked, true);
    assert.equal(info.defaultModel, OPENROUTER_FREE_PRIMARY_MODEL);

    const models = await listPiModels(OPENROUTER_FREE_PROVIDER_ID);
    assert.deepEqual(models.map((m: { model_id: string }) => m.model_id), [
      OPENROUTER_FREE_PRIMARY_MODEL,
    ]);
  });

  test("maps the trial provider to OpenRouter with free-router fallback attempts", () => {
    const {
      getUpstreamProviderId,
      getModelAttemptIds,
      OPENROUTER_FREE_PROVIDER_ID,
      OPENROUTER_FREE_PRIMARY_MODEL,
      OPENROUTER_FREE_FALLBACK_MODEL,
    } = require("../src/agents/pi/piProviders");

    assert.equal(getUpstreamProviderId(OPENROUTER_FREE_PROVIDER_ID), "openrouter");
    assert.deepEqual(getModelAttemptIds(OPENROUTER_FREE_PROVIDER_ID), [
      OPENROUTER_FREE_PRIMARY_MODEL,
      OPENROUTER_FREE_FALLBACK_MODEL,
    ]);
  });

  test("resolves the built-in provider key from server env even for cloud users", () => {
    const {
      getProviderEnvBindings,
      OPENROUTER_FREE_PROVIDER_ID,
    } = require("../src/agents/pi/piProviders");
    const { getProviderApiKey, setProviderEnvBindings } = require("../src/services/secrets");

    process.env.OPENROUTER_FREE_API_KEY = "trial-key";
    process.env.OPENROUTER_API_KEY = "regular-key";
    setProviderEnvBindings(getProviderEnvBindings());

    assert.equal(getProviderApiKey(OPENROUTER_FREE_PROVIDER_ID, "user-123"), "trial-key");
  });

  test("rejects attempts to save a user key for the built-in provider", async () => {
    const { OPENROUTER_FREE_PROVIDER_ID } = require("../src/agents/pi/piProviders");
    const app = express();
    app.use(express.json());
    app.use("/api", setupAgentRoutes());
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/agent/provider-key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: OPENROUTER_FREE_PROVIDER_ID, key: "user-key" }),
      });
      const body = await res.json() as { ok: boolean; error?: string };
      assert.equal(res.status, 400);
      assert.equal(body.ok, false);
      assert.match(body.error ?? "", /built-in server key/);
    } finally {
      server.close();
    }
  });

  test("rejects attempts to override the built-in provider model", async () => {
    const {
      OPENROUTER_FREE_PROVIDER_ID,
      OPENROUTER_FREE_PRIMARY_MODEL,
    } = require("../src/agents/pi/piProviders");
    registerRuntimeForOptions("pi", true);
    const app = express();
    app.use(express.json());
    app.use("/api", setupAgentRoutes());
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/agent/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: "pi",
          provider: OPENROUTER_FREE_PROVIDER_ID,
          model: "openrouter/some-other-free-model",
        }),
      });
      const body = await res.json() as { ok: boolean; error?: string; model?: string };
      assert.equal(res.status, 400);
      assert.equal(body.ok, false);
      assert.match(body.error ?? "", /model is locked/i);

      const ok = await fetch(`http://127.0.0.1:${port}/api/agent/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: "pi",
          provider: OPENROUTER_FREE_PROVIDER_ID,
          model: OPENROUTER_FREE_PRIMARY_MODEL,
        }),
      });
      assert.equal(ok.status, 200);
    } finally {
      server.close();
    }
  });
});
