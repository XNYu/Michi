import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { spawnSync } from "node:child_process";
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
    const server = app.listen(0);
    try {
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
    const server = app.listen(0);
    try {
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

  test("does not apply the built-in provider model lock to non-provider runtimes", async () => {
    const { OPENROUTER_FREE_PROVIDER_ID } = require("../src/agents/pi/piProviders");
    registerRuntimeForOptions("claude", false);
    const app = express();
    app.use(express.json());
    app.use("/api", setupAgentRoutes());
    const server = app.listen(0);
    try {
      const port = (server.address() as any).port;
      const selectClaude = await fetch(`http://127.0.0.1:${port}/api/agent/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: "claude",
          provider: OPENROUTER_FREE_PROVIDER_ID,
        }),
      });
      assert.equal(selectClaude.status, 200);

      const res = await fetch(`http://127.0.0.1:${port}/api/agent/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet" }),
      });
      const body = await res.json() as { ok: boolean; error?: string };
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
    } finally {
      server.close();
    }
  });

  test("uses anthropic as the default provider for fresh local config", () => {
    const script = `
      const { getAgentConfig } = require("./src/services/agentConfig");
      process.stdout.write(getAgentConfig().provider);
    `;
    const result = spawnSync(process.execPath, ["--require", "ts-node/register", "-e", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: "/tmp/michi-openrouter-free-default-test",
        MICHI_DATA_DIR: "/tmp/michi-openrouter-free-default-test/data",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "anthropic");
  });
});
