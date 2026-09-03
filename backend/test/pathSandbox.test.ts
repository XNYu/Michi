// backend/test/pathSandbox.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import { getUserSandboxRoot, deriveSandboxCwd, expandPath, NotFoundError } from "../src/agents/tools/pathSandbox";
import type { HistoryStore } from "../src/agents/ports";

const store: HistoryStore = {
  getNode: () => null, listMessages: () => [],
  getWorkspace: (id, userId) => (id === "ws1" ? { owner_user_id: userId ?? "u1" } : null),
  getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {},
};
const cfg = { getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => "", resolveReasoning: () => undefined };

describe("pathSandbox with injected deps", () => {
  afterEach(() => __resetRuntimeDeps());

  test("getUserSandboxRoot uses injected dataDir", () => {
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir: "/tmp/agent-runtime-sbx" });
    assert.equal(getUserSandboxRoot("u1"), path.join("/tmp/agent-runtime-sbx", "user-cwds", "u1"));
  });

  test("deriveSandboxCwd throws NotFoundError on unknown workspace", () => {
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir: "/tmp/agent-runtime-sbx" });
    assert.throws(() => deriveSandboxCwd("u1", "nope"), NotFoundError);
  });

  test("expandPath joins ~ and ~\\ onto the home directory", () => {
    const home = os.homedir();
    assert.equal(expandPath("~/docs"), path.join(home, "docs"));
    assert.equal(expandPath("~\\docs"), path.join(home, "docs"));
    assert.equal(expandPath("~"), home);
  });
});
