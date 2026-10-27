// backend/test/runtimeDeps.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
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
  getAgentConfig: () => ({ runtime: "pi", provider: "anthropic", modelByRuntime: {}, reasoningByRuntime: {} }),
  resolveModel: () => "",
  resolveReasoning: () => undefined,
};

describe("runtimeDeps", () => {
  afterEach(() => __resetRuntimeDeps());

  test("getRuntimeDeps throws before configuration", () => {
    assert.throws(() => getRuntimeDeps(), /not configured/);
  });
});
