// backend/test/sessionRegistry.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import {
    HISTORY_STUB_MAX_ENTRIES,
    HISTORY_STUB_TTL_MS,
    clearAllSessions,
    ensureAncestorChainLoaded,
    evictHistoryStubs,
    getAncestors,
    getSession,
    registerSession,
} from "../src/agents/sessionRegistry";
import type { AgentSession } from "../src/agents/types";
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

    test("evicts expired history stubs but never live runtime sessions", () => {
        configureRuntimeDeps({
            historyStore: storeWith({
                child: { parent: "root", msgs: [{ role: "assistant", content: "child-a" }] },
                root: { parent: null, msgs: [{ role: "user", content: "root-u" }] },
            }),
            agentConfig: fakeConfig, dataDir: "/tmp/agent-runtime-test",
        });
        ensureAncestorChainLoaded("child");
        const live: AgentSession = {
            id: "live-session", runtimeId: "pi", getHistory: () => [],
            getPendingAssistant: () => undefined,
            async *send() {}, cancel: () => {},
        };
        registerSession(live, "owner-1");

        const removed = evictHistoryStubs({ now: Date.now() + HISTORY_STUB_TTL_MS + 1 });

        assert.equal(removed, 2);
        assert.equal(getSession("child"), undefined);
        assert.equal(getSession("root"), undefined);
        assert.equal(getSession("live-session"), live);

        ensureAncestorChainLoaded("child");
        assert.equal(getSession("root")?.getHistory()[0]?.content, "root-u");
        assert.equal(getSession("child")?.parentChatId, "root");
    });

    test("uses least-recently-used order when the stub count exceeds its cap", () => {
        const realNow = Date.now;
        let now = 1_000;
        Date.now = () => now;
        try {
            configureRuntimeDeps({
                historyStore: storeWith({
                    first: { parent: null, msgs: [{ role: "user", content: "first" }] },
                    second: { parent: null, msgs: [{ role: "user", content: "second" }] },
                    third: { parent: null, msgs: [{ role: "user", content: "third" }] },
                }),
                agentConfig: fakeConfig, dataDir: "/tmp/agent-runtime-test",
            });
            ensureAncestorChainLoaded("first");
            now += 1;
            ensureAncestorChainLoaded("second");
            now += 1;
            ensureAncestorChainLoaded("third");
            now += 1;
            assert.ok(getSession("first"), "reading a stub refreshes its LRU position");
            now += 1;

            assert.equal(evictHistoryStubs({ now, maxEntries: 2 }), 1);
            assert.ok(getSession("first"));
            assert.equal(getSession("second"), undefined);
            assert.ok(getSession("third"));
        } finally {
            Date.now = realNow;
        }
    });

    test("returns a chain deeper than the cache cap, then trims resident stubs", () => {
        const nodes: Record<string, { parent: string | null; msgs: Array<{ role: string; content: string }> }> = {
            unrelated: { parent: null, msgs: [{ role: "user", content: "unrelated" }] },
        };
        const chainLength = HISTORY_STUB_MAX_ENTRIES + 2;
        for (let index = 0; index < chainLength; index += 1) {
            nodes[`chain-${index}`] = {
                parent: index === 0 ? null : `chain-${index - 1}`,
                msgs: [{ role: "assistant", content: `message-${index}` }],
            };
        }
        configureRuntimeDeps({
            historyStore: storeWith(nodes),
            agentConfig: fakeConfig,
            dataDir: "/tmp/agent-runtime-test",
        });

        ensureAncestorChainLoaded("unrelated");
        const leafId = `chain-${chainLength - 1}`;
        ensureAncestorChainLoaded(leafId);
        const ancestors = getAncestors(leafId);

        assert.equal(ancestors.length, chainLength - 1, "the active chain must not be truncated");
        assert.equal(getSession("unrelated"), undefined, "inactive stubs are trimmed first");
        const residentChainEntries = Array.from({ length: chainLength }, (_, index) => `chain-${index}`)
            .filter((id) => getSession(id) !== undefined);
        assert.equal(residentChainEntries.length, HISTORY_STUB_MAX_ENTRIES);
    });
});
