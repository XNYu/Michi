// backend/test/sessionRegistry.test.ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeDeps, __resetRuntimeDeps } from "../src/agents/runtimeDeps";
import { HISTORY_STUB_TTL_MS, clearAllSessions, dropSessionForOwner, ensureAncestorChainLoaded, evictHistoryStubs, getSession, getSessionForOwner, registerSession } from "../src/agents/sessionRegistry";
import type { AgentSession } from "../src/agents/types";
import type { HistoryStore } from "../src/agents/ports";
import { chatOwner, runOwner } from "./helpers/owners";

const fakeConfig = {
  getAgentConfig: () => ({ runtime: "pi", provider: "x", modelByRuntime: {}, reasoningByRuntime: {} }),
  resolveModel: () => "", resolveReasoning: () => undefined,
};

function storeWith(nodes: Record<string, { parent: string | null; msgs: Array<{ role: string; content: string }> }>): HistoryStore {
  return {
    getNode: (id) => (nodes[id] ? { parent_node_id: nodes[id].parent, workspace_id: null } : null),
    listMessages: (id) => (nodes[id]?.msgs ?? []).map((m) => ({ role: m.role, content: m.content, created_at: 0 })),
    getWorkspace: () => null, getWorkspaceInstructions: () => null,
  };
}

describe("sessionRegistry.ensureAncestorChainLoaded", () => {
  afterEach(() => { clearAllSessions(); __resetRuntimeDeps(); });

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
});

test('owner-scoped lookup and release require the same Attempt and the correct owner mode', () => {
    const owner = runOwner('run-1', 'attempt-1');
    const session: AgentSession = {
        id: 'attempt-1', owner, runtimeId: 'pi', getHistory: () => [],
        getPendingAssistant: () => undefined, async *send() {}, cancel: () => {},
    };
    registerSession(session, 'user-1', owner);
    try {
        for (const wrongOwner of [
            runOwner('run-1', 'attempt-2'),
            chatOwner('attempt-1'),
        ]) {
            assert.equal(getSessionForOwner(session.id, wrongOwner, 'user-1'), null);
            assert.equal(dropSessionForOwner(session.id, wrongOwner), false);
            assert.equal(getSession(session.id), session);
        }
        assert.equal(getSessionForOwner(session.id, { ...owner }, 'user-1'), session);
        assert.equal(dropSessionForOwner(session.id, { ...owner }), true);
    } finally {
        clearAllSessions();
    }
});
