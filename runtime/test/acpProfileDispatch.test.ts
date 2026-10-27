/**
 * What an AcpProfile alone can do with the core's messages: show permission
 * options its own way, answer agent requests (asking the user through
 * AcpHandlerContext), and see notifications and session updates. Ported from
 * the public repository's acpProfiles.test.ts Cursor dispatch cases, with an
 * inline profile instead of the vendor's. Kiro sets none of these hooks.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AcpClient, SessionQueue } from "../src/adapters/acp/client";
import { ACPError } from "../src/adapters/acp/errors";
import type { AcpHandlerContext, AcpProfile, AcpUpdate } from "../src/adapters/acp/types";

type Frame = Record<string, any>;

function rig(overrides: Partial<AcpProfile> = {}) {
    const profile: AcpProfile = {
        runtimeId: "probe-agent",
        logLabel: "probe",
        binaryPath: "/bin/false",
        cwd: "/tmp",
        spawnArgs: [],
        protocolVersion: 1,
        clientInfo: { name: "michi", version: "1.0.0" },
        clientCapabilities: {},
        ...overrides,
    };
    const client = new AcpClient(profile);
    const internals = client as unknown as {
        proc: unknown;
        sessionQueues: Map<string, SessionQueue>;
        sessionInFlight: Map<string, Promise<void>>;
        dispatch(msg: Frame): void;
        failAllPending(error: Error): void;
        handlerContext(): AcpHandlerContext;
    };
    const writes: Frame[] = [];
    internals.proc = {
        pid: 31,
        stdin: { destroyed: false, write: (line: string, cb?: (error?: Error | null) => void) => { writes.push(JSON.parse(line)); cb?.(null); return true; } },
    };
    const queue = (sessionId: string) => {
        const q = new SessionQueue();
        internals.sessionQueues.set(sessionId, q);
        return q;
    };
    const drain = async (q: SessionQueue, count: number) => {
        const out: AcpUpdate[] = [];
        for (let i = 0; i < count; i++) {
            const item = await q.get();
            out.push("update" in item ? item.update : { done: true });
        }
        return out;
    };
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    return { client, internals, writes, queue, drain, tick };
}

const askQuestion = (id: number, sessionId?: string): Frame => ({
    jsonrpc: "2.0", id, method: "probe/ask_question",
    params: { ...(sessionId ? { sessionId } : {}), questions: [{ id: "q1", prompt: "Which mode?", options: [{ id: "agent", label: "Agent" }] }] },
});

describe("ACP core dispatch driven by a profile", () => {
    test("permission options are shown as the profile maps them and answered against the agent's", async () => {
        const kinds: Record<string, string> = { "allow-once": "allow_once", "reject-once": "reject_once" };
        const r = rig({ mapPermissionOptions: (options) => (options as Frame[]).map((o) => ({ ...o, kind: kinds[o.optionId] })) });
        const q = r.queue("sess-1");
        r.internals.dispatch({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {
            sessionId: "sess-1", toolCall: { toolCallId: "t1", title: "Edit" },
            options: [{ optionId: "allow-once", name: "Allow once" }, { optionId: "reject-once", name: "Reject" }],
        } });
        const [shown] = await r.drain(q, 1);
        assert.equal(shown.sessionUpdate, "permission_request");
        assert.equal(shown.requestId, 7, "a numeric agent id is the UI's id");
        assert.deepEqual(shown.options.map((o: Frame) => [o.optionId, o.kind]), [["allow-once", "allow_once"], ["reject-once", "reject_once"]]);
        assert.throws(() => r.client.respondToPermission(7, "allow_once"), /Unknown permission option/);
        r.client.respondToPermission(7, "allow-once");
        assert.deepEqual(r.writes, [{ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }]);
    });

    test("a request the profile handles is answered when it is ready, through the user", async () => {
        const r = rig({
            handleIncomingRequest: async (msg, ctx) => {
                if (msg.method !== "probe/ask_question") return false;
                const sessionId = ctx.inferSessionId(msg.params);
                const requestId = ctx.nextUserInputRequestId();
                if (sessionId) ctx.pushUpdate(sessionId, { sessionUpdate: "user_input_request", requestId, questions: msg.params.questions });
                const answers = await ctx.waitForUserInput(requestId, sessionId);
                ctx.reply(msg.id, answers ? { outcome: { outcome: "answered", answers } } : { outcome: { outcome: "cancelled" } });
                return true;
            },
        });
        const q = r.queue("sess-1");
        r.internals.dispatch(askQuestion(42));
        const [asked] = await r.drain(q, 1);
        assert.deepEqual(asked, { sessionUpdate: "user_input_request", requestId: 1, questions: askQuestion(42).params.questions },
            "with one session, a request without a sessionId belongs to it");
        assert.deepEqual(r.writes, [], "no reply until the user answers");
        assert.equal(r.client.respondToUserInput(1, [{ question: "Which mode?", answer: "Agent" }]), true);
        assert.equal(r.client.respondToUserInput(1, []), false, "answered once");
        await r.tick();
        assert.deepEqual(r.writes, [{ jsonrpc: "2.0", id: 42, result: { outcome: { outcome: "answered", answers: [{ question: "Which mode?", answer: "Agent" }] } } }]);

        r.internals.dispatch(askQuestion(43, "sess-1"));
        await r.drain(q, 1);
        assert.equal(r.client.skipUserInput(2), true);
        await r.tick();
        assert.deepEqual(r.writes.at(-1), { jsonrpc: "2.0", id: 43, result: { outcome: { outcome: "cancelled" } } });
    });

    test("cancelling a session's permissions also drops its questions; failing everything drops all", async () => {
        const r = rig({
            handleIncomingRequest: async (msg, ctx) => {
                const answers = await ctx.waitForUserInput(ctx.nextUserInputRequestId(), msg.params.sessionId);
                ctx.reply(msg.id, { answered: answers !== null });
                return true;
            },
        });
        r.internals.dispatch(askQuestion(1, "a"));
        r.internals.dispatch(askQuestion(2, "b"));
        r.client.cancelPermissionsForSession("a");
        await r.tick();
        assert.deepEqual(r.writes, [{ jsonrpc: "2.0", id: 1, result: { answered: false } }]);
        r.internals.failAllPending(new Error("gone"));
        await r.tick();
        assert.deepEqual(r.writes.at(-1), { jsonrpc: "2.0", id: 2, result: { answered: false } });
    });

    test("a request the profile declines or fails on gets a JSON-RPC error", async () => {
        const r = rig({
            handleIncomingRequest: (msg) => {
                if (msg.method === "probe/explode") throw new Error("handler broke");
                return msg.method === "probe/async-explode" ? Promise.reject(new Error("later")) : false;
            },
        });
        r.internals.dispatch({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file", params: {} });
        r.internals.dispatch({ jsonrpc: "2.0", id: 2, method: "probe/explode", params: {} });
        r.internals.dispatch({ jsonrpc: "2.0", id: 3, method: "probe/async-explode", params: {} });
        assert.deepEqual(r.writes, [], "answered asynchronously");
        await r.tick();
        assert.deepEqual(r.writes, [
            { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Unsupported client method: fs/read_text_file" } },
            { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "handler broke" } },
            { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "later" } },
        ]);
    });

    test("without the hook, an unknown request is refused at once", () => {
        const r = rig();
        r.internals.dispatch({ jsonrpc: "2.0", id: 9, method: "terminal/create", params: {} });
        assert.deepEqual(r.writes, [{ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Unsupported client method: terminal/create" } }]);
    });

    test("notifications and session updates reach the profile with the client's context", async () => {
        const seen: unknown[] = [];
        const r = rig({
            handleNotification: (msg, ctx) => {
                seen.push(["notification", msg.method, ctx.pid, ctx.cwd, ctx.hasSession("sess-1")]);
                if (msg.method === "probe/progress") ctx.pushUpdate(msg.params.sessionId, { sessionUpdate: "progress", pct: msg.params.pct });
                ctx.setLastMetadata("sess-1", { seen: msg.method });
                return true;
            },
            onSessionUpdate: (sessionId, update, ctx) => {
                seen.push(["update", sessionId, update.sessionUpdate, ctx.isSessionInFlight(sessionId), ctx.getLastMetadata(sessionId)]);
            },
        });
        const q = r.queue("sess-1");
        r.internals.dispatch({ jsonrpc: "2.0", method: "probe/progress", params: { sessionId: "sess-1", pct: 50 } });
        r.internals.dispatch({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
        r.internals.dispatch({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "plan" } } });
        assert.deepEqual(await r.drain(q, 2), [
            { sessionUpdate: "progress", pct: 50 },
            { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
        ]);
        assert.deepEqual(seen, [
            ["notification", "probe/progress", 31, "/tmp", true],
            ["update", "sess-1", "agent_message_chunk", false, { seen: "probe/progress" }],
            ["update", "other", "plan", false, undefined],
        ]);
    });

    test("a session is inferred from params, the one in flight, the last prompted, or the only one", async () => {
        const r = rig();
        const ctx = r.internals.handlerContext();
        assert.equal(ctx.inferSessionId({ sessionId: "explicit" }), "explicit");
        assert.equal(ctx.inferSessionId({}), undefined);
        r.queue("a");
        assert.equal(ctx.inferSessionId(), "a");
        r.queue("b");
        assert.equal(ctx.inferSessionId(), undefined, "two sessions, none in flight, none prompted");
        r.internals.sessionInFlight.set("b", Promise.resolve());
        assert.equal(ctx.inferSessionId(), "b");
        r.internals.sessionInFlight.delete("b");

        const turn = r.client.prompt("a", "hi");
        const first = turn.next();
        const sent = r.writes.find((frame) => frame.method === "session/prompt");
        assert.ok(sent, "the prompt went out");
        assert.equal(ctx.inferSessionId(), "a", "in flight");
        r.internals.dispatch({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } });
        assert.deepEqual((await first).value, { sessionUpdate: "turn_end", stopReason: "end_turn" });
        assert.equal((await turn.next()).done, true);
        assert.equal(r.internals.sessionInFlight.size, 0);
        assert.equal(ctx.inferSessionId(), "a", "two sessions, none in flight: the last prompted");
        r.client.destroySession("a");
        assert.equal(ctx.inferSessionId(), "b", "the last prompted is gone: the only one left");
    });

    test("ctx.resetIdleTimers restarts the idle deadline of that session's requests only", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const r = rig();
        r.queue("a");
        r.queue("b");
        const settled: string[] = [];
        const watch = (name: string, request: Promise<unknown>) => void request.then(
            () => settled.push(`${name} resolved`),
            (error: Error) => settled.push(`${name}: ${error.message}`));
        watch("a", r.client.setMode("a", "plan"));
        watch("b", r.client.setMode("b", "plan"));
        t.mock.timers.tick(100_000);
        r.internals.handlerContext().resetIdleTimers("a");
        t.mock.timers.tick(80_000);
        await r.tick();
        assert.deepEqual(settled, ["b: Request session/set_mode idle for 180000ms (no updates from agent)"]);
        t.mock.timers.tick(99_999);
        await r.tick();
        assert.equal(settled.length, 1, "a's deadline moved to 100s + 180s");
        t.mock.timers.tick(1);
        await r.tick();
        assert.deepEqual(settled.slice(1), ["a: Request session/set_mode idle for 180000ms (no updates from agent)"]);
    });

    test("extensionRequest sends a method the core does not define and settles with its reply", async () => {
        const r = rig();
        const ok = r.client.extensionRequest("_probe/status", { sessionId: "sess-1", verbose: true });
        const failed = assert.rejects(r.client.extensionRequest("_probe/missing", {}), (error: unknown) =>
            error instanceof ACPError && error.message === "Method not found"
            && error.rpcCode === -32601 && error.method === "_probe/missing");
        assert.deepEqual(r.writes, [
            { jsonrpc: "2.0", id: 0, method: "_probe/status", params: { sessionId: "sess-1", verbose: true } },
            { jsonrpc: "2.0", id: 1, method: "_probe/missing", params: {} },
        ]);
        r.internals.dispatch({ jsonrpc: "2.0", id: 0, result: { ready: true } });
        r.internals.dispatch({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
        assert.deepEqual(await ok, { ready: true });
        await failed;
    });
});
