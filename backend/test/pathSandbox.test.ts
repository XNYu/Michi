// backend/test/pathSandbox.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import {
  assertWithinCwd,
  getUserSandboxRoot,
  deriveSandboxCwd,
  normalizeWorkspaceCwd,
  NotFoundError,
  PathSandboxError,
} from "../src/agents/tools/pathSandbox";
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

describe("pathSandbox cwd normalization", () => {
  test("removes trailing separators and accepts canonical/aliased cwd spellings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "michi-path-sandbox-"));
    const realRoot = path.join(root, "real-workspace");
    const aliasRoot = path.join(root, "workspace-alias");
    fs.mkdirSync(path.join(realRoot, "src"), { recursive: true });
    fs.symlinkSync(realRoot, aliasRoot, "dir");

    try {
      assert.equal(normalizeWorkspaceCwd(`${aliasRoot}${path.sep}`), fs.realpathSync.native(realRoot));
      assert.doesNotThrow(() => assertWithinCwd(path.join(realRoot, "src", "file.ts"), `${aliasRoot}${path.sep}`));
      assert.doesNotThrow(() => assertWithinCwd(path.join(aliasRoot, "src", "missing.ts"), realRoot));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("still rejects paths outside every lexical/canonical workspace root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "michi-path-sandbox-outside-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside", "secret.txt");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(outside), { recursive: true });

    try {
      assert.throws(() => assertWithinCwd(outside, `${workspace}${path.sep}`), PathSandboxError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves the existing lexical allowance for a symlink placed inside cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "michi-path-sandbox-link-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, "linked"), "dir");

    try {
      assert.doesNotThrow(() => assertWithinCwd(path.join(workspace, "linked", "file.txt"), workspace));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
