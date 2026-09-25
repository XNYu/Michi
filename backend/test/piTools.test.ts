// backend/test/piTools.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import { buildPiTools, piToolResultErrorOverride } from "../src/agents/pi/piTools";
import { SUBMIT_AGENT_RESULT_TOOL } from "../src/agents/runs/runWorkerTools";

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
      globalContext: { listThreads: () => ({ status: "ok", text: "" }), searchMessages: () => ({ status: "ok", text: "" }), readNode: () => ({ status: "ok", text: "" }), readNodeOverview: () => ({ status: "ok", text: "" }) } });
    const names = buildPiTools(opts() as any).map((t: any) => t.name);
    for (const n of ["list_threads", "search_messages", "read_node", "read_node_overview"]) assert.ok(names.includes(n), `${n} should be present`);
  });
});

describe("Pi tool result error propagation", () => {
  test("marks Michi errorResult payloads as failed for pi-agent-core", () => {
    assert.deepEqual(piToolResultErrorOverride({
      result: { content: [{ type: "text", text: "access denied" }], isError: true },
      isError: false,
    }), { isError: true });
  });

  test("does not override successful or already-failed tool executions", () => {
    assert.equal(piToolResultErrorOverride({ result: { isError: false }, isError: false }), undefined);
    assert.equal(piToolResultErrorOverride({ result: { isError: true }, isError: true }), undefined);
  });
});

describe("Pi session-bound Agent tools", () => {
  afterEach(() => __resetRuntimeDeps());

  test("registers generic Agent tools only from the supplied session invoker", () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const invoker = { invoke: async () => ({ ok: true }) };
    const enabled = buildPiTools({ ...opts(), agentRunTools: invoker } as any).map((tool: any) => tool.name);
    const disabled = buildPiTools(opts() as any).map((tool: any) => tool.name);
    assert.ok(enabled.includes("spawn_agent"));
    assert.ok(!disabled.includes("spawn_agent"));
  });

  test("submit_agent_result is Run-only and forwards the exact Attempt owner", async () => {
    configureRuntimeDeps({ historyStore: store as any, agentConfig: baseCfg, dataDir: "/tmp/agent-runtime-test" });
    const owner = { kind: "agent_run" as const, runId: "run-a", attemptId: "attempt-a" };
    const submissions: any[] = [];
    const profile = {
      allowedToolNames: [SUBMIT_AGENT_RESULT_TOOL],
      runWorkerTools: { submitAgentResult: (actualOwner: unknown, payload: unknown) => {
        submissions.push([actualOwner, payload]);
        return payload;
      } },
    };
    const runTools = buildPiTools({ ...opts(), owner, toolProfile: profile } as any);
    const chatTools = buildPiTools({ ...opts(), owner: { kind: "chat_node", nodeId: "node-a" }, toolProfile: profile } as any);
    const submit = runTools.find((tool: any) => tool.name === SUBMIT_AGENT_RESULT_TOOL);
    assert.ok(submit);
    assert.equal(chatTools.some((tool: any) => tool.name === SUBMIT_AGENT_RESULT_TOOL), false);
    await submit.execute("tool-call-a", { version: 1, status: "completed" });
    assert.deepEqual(submissions, [[owner, { version: 1, status: "completed" }]]);
  });
});
