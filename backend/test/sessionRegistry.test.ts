// backend/test/sessionRegistry.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import { ensureAncestorChainLoaded, getSession, clearAllSessions } from "../src/agents/sessionRegistry";
import type { HistoryStore } from "../src/agents/ports";

const fakeConfig = {
  getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }),
  resolveModel: () => "", resolveReasoning: () => undefined,
};

function storeWith(nodes: Record<string, { parent: string | null; msgs: Array<{ role: string; content: string }> }>): HistoryStore {
  return {
    getNode: (id) => (nodes[id] ? { parent_node_id: nodes[id].parent, workspace_id: null } : null),
    listMessages: (id) => (nodes[id]?.msgs ?? []).map((m) => ({ role: m.role, content: m.content, created_at: 0 })),
    getWorkspace: () => null, getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {},
  };
}

describe("sessionRegistry.ensureAncestorChainLoaded", () => {
  afterEach(() => { clearAllSessions(); __resetRuntimeDeps(); });

  test("loads ancestor stubs from the injected HistoryStore, not the DB", () => {
    configureRuntimeDeps({
      historyStore: storeWith({
        child: { parent: "root", msgs: [{ role: "assistant", content: "child-a" }] },
        root: { parent: null, msgs: [{ role: "user", content: "root-u" }] },
      }),
      agentConfig: fakeConfig, dataDir: "/tmp/agent-runtime-test",
    });
    ensureAncestorChainLoaded("child");
    assert.equal(getSession("root")?.getHistory()[0]?.content, "root-u");
    assert.equal(getSession("child")?.parentChatId, "root");
  });
});
