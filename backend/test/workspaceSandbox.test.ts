// backend/test/workspaceSandbox.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import {
  assertCwdAllowed,
  deriveSandboxCwd,
  getUserSandboxRoot,
  NotFoundError,
} from "../src/services/workspaceSandbox";
import * as pathSandbox from "../src/agents/tools/pathSandbox";
import type { HistoryStore } from "../src/agents/ports";

const store: HistoryStore = {
  getNode: () => null, listMessages: () => [],
  getWorkspace: (id, userId) => (id === "ws1" ? { owner_user_id: userId ?? "u1" } : null),
  getWorkspaceInstructions: () => null,
};
const cfg = { getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => "", resolveReasoning: () => undefined };

describe("workspaceSandbox with injected deps", () => {
  afterEach(() => __resetRuntimeDeps());

  test("deriveSandboxCwd throws NotFoundError on unknown workspace", () => {
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir: "/tmp/agent-runtime-sbx" });
    assert.throws(() => deriveSandboxCwd("u1", "nope"), NotFoundError);
  });

  test("deriveSandboxCwd creates ws-<id> under the user's sandbox root", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "michi-workspace-sandbox-"));
    try {
      configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir });
      const root = getUserSandboxRoot("u1");
      assert.equal(root, path.join(dataDir, "user-cwds", "u1"));
      const cwd = deriveSandboxCwd("u1", "ws1");
      assert.equal(cwd, path.join(root, "ws-ws1"));
      assert.ok(fs.statSync(cwd).isDirectory());
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("assertCwdAllowed accepts the sandbox root and its children only", () => {
    configureRuntimeDeps({ historyStore: store, agentConfig: cfg, dataDir: "/tmp/agent-runtime-sbx" });
    const root = getUserSandboxRoot("u1");
    assert.doesNotThrow(() => assertCwdAllowed(root, "u1"));
    assert.doesNotThrow(() => assertCwdAllowed(path.join(root, "ws-ws1", "sub"), "u1"));
    assert.throws(() => assertCwdAllowed(`${root}x`, "u1"), pathSandbox.PathSandboxError);
    assert.throws(() => assertCwdAllowed(getUserSandboxRoot("u2"), "u1"), pathSandbox.PathSandboxError);
  });

  test("agents/tools/pathSandbox keeps only the path containment helpers", () => {
    for (const name of ["getUserSandboxRoot", "assertCwdAllowed", "deriveSandboxCwd", "NotFoundError"]) {
      assert.equal(name in pathSandbox, false, `${name} belongs to services/workspaceSandbox`);
    }
  });
});
