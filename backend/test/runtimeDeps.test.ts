// backend/test/runtimeDeps.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeDeps, getRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import type { HistoryStore } from "../src/agents/ports";

const fakeStore: HistoryStore = {
  getNode: () => null,
  listMessages: () => [],
  getWorkspace: () => null,
  getWorkspaceInstructions: () => null,
  hasGrant: () => false,
  grantPermission: () => {},
};
const fakeConfig = {
  getAgentConfig: () => ({ runtime: "pi", provider: "openrouter-free", modelByRuntime: {}, reasoningByRuntime: {} }),
  resolveModel: () => "",
  resolveReasoning: () => undefined,
};

describe("runtimeDeps", () => {
  afterEach(() => __resetRuntimeDeps());

  test("getRuntimeDeps throws before configuration", () => {
    assert.throws(() => getRuntimeDeps(), /not configured/);
  });

  test("returns the injected store and a default provider-key resolver", () => {
    configureRuntimeDeps({ historyStore: fakeStore, agentConfig: fakeConfig, dataDir: "/tmp/agent-runtime-test" });
    const d = getRuntimeDeps();
    assert.equal(d.historyStore, fakeStore);
    assert.equal(typeof d.providerKeys.getProviderApiKey, "function");
  });
});
