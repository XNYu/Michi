// backend/test/piTools.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import { buildPiTools } from "../src/agents/pi/piTools";

const baseCfg = { getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => "", resolveReasoning: () => undefined };
const store = { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {} };
// Minimal typebox stand-in: every builder returns a plain object.
const Type: any = new Proxy({}, { get: () => (..._a: any[]) => ({}) });
function opts() {
  return { bridge: {} as any, cwd: "/tmp", parentChatId: "p", workspaceId: null, enableFollowUps: true,
    imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type };
}

describe("buildPiTools global-context gating", () => {
  afterEach(() => __resetRuntimeDeps());

  test("omits list_threads/search_messages/read_node when no provider injected", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const names = buildPiTools(opts() as any).map((t: any) => t.name);
    for (const n of ["list_threads", "search_messages", "read_node"]) assert.ok(!names.includes(n), `${n} should be absent`);
  });

  test("includes them when a provider is injected", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test",
      globalContext: { listThreads: () => ({ status: "ok", text: "" }), searchMessages: () => ({ status: "ok", text: "" }), readNode: () => ({ status: "ok", text: "" }) } });
    const names = buildPiTools(opts() as any).map((t: any) => t.name);
    for (const n of ["list_threads", "search_messages", "read_node"]) assert.ok(names.includes(n), `${n} should be present`);
  });
});
