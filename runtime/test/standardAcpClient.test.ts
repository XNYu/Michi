/**
 * A launch override with `standardAcp` (Antigravity's `agy acp`) speaks
 * standard ACP only. Each behaviour is checked against an in-memory fake agent
 * shaped like agy 1.4.12's recorded wire, next to the unchanged Kiro default.
 */
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as processTree from "../src/core/processTree";
import { AcpClient, ACPError, ACPNativeSessionMissingError, type AcpLaunch, type AcpUpdate } from "../src/adapters/kiro/acpClient";
import { ELICITATION_REQUEST_ID_BASE, KiroAcpProfile } from "../src/adapters/kiro/kiroAcpProfile";
import { KiroSignedOutError } from "../src/adapters/kiro/kiroSignIn";
import { classifyAcpError } from "../src/adapters/kiro/acpErrors";
import { nativeSessionExists, realCwd } from "../src/adapters/kiro/nativeSessionLookup";
import type { AcpHandlerContext, AcpUserAnswer } from "../src/adapters/acp/types";

type Frame = Record<string, any>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await tick();
}

const AGY_CAPS = { loadSession: true, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} } };
const option = (id: string, value: string, values: string[]) => ({ id, name: id, category: id, type: "select", currentValue: value,
    options: values.map((v) => ({ value: v, name: v })) });
const configOptions = (model = "gemini-4-argon", thought = "medium") => [
    option("model", model, ["gemini-4-argon", "gemini-3.8-flash"]),
    option("thought_level", thought, ["low", "medium", "high"]),
];
const USAGE = { inputTokens: 6873, outputTokens: 44, cachedReadTokens: 4822, cachedWriteTokens: 3, thoughtTokens: 18, totalTokens: 6935 };
const AGY_SIGN_IN = {
    matches: (error: { code?: number; message?: string } | string) => typeof error === "string"
        ? /authentication required/i.test(error)
        : error.code === -32000 && /authentication required/i.test(error.message ?? ""),
    message: "Antigravity is not signed in. Run `agy` in a terminal and sign in with Google, then try again.",
};
const HOLD = Symbol("hold");

interface AgentOptions {
    caps?: Record<string, unknown>;
    /** Per-method answer: a result, `{ error }`, or HOLD to answer later with `answer`. */
    answers?: Record<string, (msg: Frame) => unknown>;
}

/** Every fake process by pid, so a test may run several clients. */
const processes = new Map<number, any>();
let nextPid = 5_000;

/** A fake agent process: records what it is sent and answers like agy. */
function fakeAgent(t: TestContext, options: AgentOptions = {}) {
    const sent: Frame[] = [];
    const held = new Map<string, Frame[]>();
    let proc: any;
    const emit = (frame: Frame) => proc.stdout.emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
    const reply = (msg: Frame, answer: unknown) => setImmediate(() => emit(answer && typeof answer === "object" && "error" in answer
        ? { jsonrpc: "2.0", id: msg.id, error: (answer as Frame).error }
        : { jsonrpc: "2.0", id: msg.id, result: answer }));
    const defaults: Record<string, (msg: Frame) => unknown> = {
        initialize: () => ({ protocolVersion: 1, agentCapabilities: options.caps ?? AGY_CAPS }),
        "session/new": () => ({ sessionId: "S1", configOptions: configOptions() }),
        "session/load": () => ({ configOptions: configOptions() }),
        "session/list": () => ({ sessions: [] }),
        "session/set_model": () => ({}),
        "session/set_config_option": (msg) => ({ configOptions: configOptions(
            msg.params.configId === "model" ? msg.params.value : undefined,
            msg.params.configId === "thought_level" ? msg.params.value : undefined) }),
        "session/prompt": () => HOLD,
    };
    t.mock.method(processTree, "spawnAgentProcess", () => {
        proc = Object.assign(new EventEmitter(), {
            pid: ++nextPid, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: {
                destroyed: false,
                write: (line: string, cb?: (error?: Error | null) => void) => {
                    cb?.(null);
                    const msg = JSON.parse(line);
                    sent.push(msg);
                    if (msg.method === undefined || msg.id === undefined) return true;
                    const answer = (options.answers?.[msg.method] ?? defaults[msg.method] ?? (() => ({})))(msg);
                    if (answer === HOLD) held.set(msg.method, [...(held.get(msg.method) ?? []), msg]);
                    else reply(msg, answer);
                    return true;
                },
            },
        });
        processes.set(proc.pid, proc);
        return proc;
    });
    t.mock.method(processTree, "killProcessTree", (pid: number) => setImmediate(() => {
        const killed = processes.get(pid);
        processes.delete(pid);
        killed.signalCode = "SIGTERM";
        killed.emit("exit", null, "SIGTERM");
    }));
    return {
        sent,
        methods: () => sent.map((msg) => msg.method).filter(Boolean) as string[],
        emit,
        stderr: (text: string) => proc.stderr.emit("data", Buffer.from(text)),
        exit: (code: number) => { proc.exitCode = code; proc.emit("exit", code, null); },
        answer: (method: string, result: unknown) => reply(held.get(method)!.shift()!, result),
        /** Our reply to a request the agent sent. */
        replyTo: (id: unknown) => sent.find((msg) => msg.id === id && msg.method === undefined),
    };
}

const AGY_LAUNCH: AcpLaunch = { bin: "/fake/agy", args: () => ["acp"], standardAcp: true };

async function agyClient(t: TestContext, agent: AgentOptions = {}, extra: { cwd?: string; signIn?: typeof AGY_SIGN_IN } = {}) {
    const fake = fakeAgent(t, agent);
    const c = new AcpClient(undefined, extra.cwd ?? "/work", undefined, "v2", AGY_LAUNCH, "antigravity",
        { displayName: "Antigravity", ...(extra.signIn ? { signIn: extra.signIn } : {}) });
    t.after(() => c.shutdown());
    c.start();
    await c.initialize();
    return { fake, c };
}

/** kiro-cli v2 (or v3) with the same fake: the unchanged default. */
async function kiroClient(t: TestContext, agent: AgentOptions = {}, extra: { engine?: "v2" | "v3"; cwd?: string; launch?: AcpLaunch; signIn?: typeof AGY_SIGN_IN } = {}) {
    const fake = fakeAgent(t, agent);
    const c = new AcpClient("/fake/kiro-cli", extra.cwd ?? "/work", undefined, extra.engine ?? "v2", extra.launch, "kiro",
        { displayName: "Antigravity", ...(extra.signIn ? { signIn: extra.signIn } : {}) });
    t.after(() => c.shutdown());
    c.start();
    await c.initialize();
    return { fake, c };
}

/** Read a prompt's updates in the background. */
function consume(iterator: AsyncIterableIterator<AcpUpdate>) {
    const updates: AcpUpdate[] = [];
    const done = (async () => { for await (const update of iterator) updates.push(update); })();
    return { updates, done, kinds: () => updates.map((u) => u.sessionUpdate).filter((k) => k !== "session_state") };
}

describe("standardAcp: no Kiro extension is sent", () => {
    test("extensions are unsupported; commands, steering and steer clearing answer without an RPC", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        assert.equal(c.supportsExtension("_session/steer"), false);
        assert.equal(c.supportsExtension("_kiro.dev/commands/execute"), false);
        assert.deepEqual(await c.executeCommand("S1", "context"), { success: false, message: "Antigravity does not support /context" });
        const turn = consume(c.prompt("S1", "work"));
        await settle();
        assert.deepEqual(await c.steer("S1", "also this"), { queued: false });
        assert.deepEqual(await c.clearSteer("S1"), { cleared: false });
        fake.answer("session/prompt", { stopReason: "end_turn" });
        await turn.done;
        assert.ok(!fake.methods().some((method) => method.startsWith("_")), fake.methods().join(","));
    });

    test("Kiro v2 still sends its extensions", async (t) => {
        const { fake, c } = await kiroClient(t, { answers: { "_kiro.dev/commands/execute": () => ({ success: true }) } });
        await c.newSession([]);
        assert.equal(c.supportsExtension("_session/steer"), true);
        assert.deepEqual(await c.executeCommand("S1", "context"), { success: true });
        assert.deepEqual(await c.clearSteer("S1"), { cleared: false });
        assert.deepEqual(fake.methods().slice(-2), ["_kiro.dev/commands/execute", "_session/steer/clear"]);
    });

    test("compaction is refused before the session is reserved, and never quarantines it", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        const turn = consume(c.prompt("S1", "work"));
        await settle();
        // A running prompt would make Kiro answer "Cannot compact an active Kiro session".
        assert.deepEqual(await c.compact("S1"), { success: false, message: "Antigravity does not support compaction" });
        fake.answer("session/prompt", { stopReason: "end_turn" });
        await turn.done;
        assert.deepEqual(await c.compact("S1", "keep the plan"), { success: false, message: "Antigravity does not support compaction" });
        assert.equal(c.needsSessionRecovery("S1"), false);
        assert.ok(!fake.methods().some((method) => method.startsWith("_")));
        const next = consume(c.prompt("S1", "again"));
        await settle();
        assert.equal(fake.methods().filter((method) => method === "session/prompt").length, 2, "the session is free for the next prompt");
        fake.answer("session/prompt", { stopReason: "end_turn" });
        await next.done;
    });

    test("Kiro v2 compacts through its command extension", async (t) => {
        const { fake, c } = await kiroClient(t, { answers: { "_kiro.dev/commands/execute": () => ({ success: false, message: "nothing to compact" }) } });
        await c.newSession([]);
        assert.deepEqual(await c.compact("S1"), { success: false, message: "nothing to compact" });
        const command = fake.sent.find((msg) => msg.method === "_kiro.dev/commands/execute")!;
        assert.equal(command.params.command.command, "compact");
    });
});

describe("standardAcp: model and config options", () => {
    test("setModel goes through the session's model config option", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        await c.setModel("S1", "gemini-3.8-flash");
        const set = fake.sent.filter((msg) => msg.method?.startsWith("session/set_"));
        assert.deepEqual(set.map((msg) => [msg.method, msg.params]), [
            ["session/set_config_option", { sessionId: "S1", configId: "model", value: "gemini-3.8-flash" }],
        ]);
        assert.equal(c.getSessionInfo("S1")?.models?.currentModelId, "gemini-3.8-flash");
    });

    test("setConfigOption works on v2 and still checks the applied value", async (t) => {
        const { c } = await agyClient(t, { answers: {
            "session/set_config_option": (msg) => ({ configOptions: configOptions(undefined, msg.params.value === "xhigh" ? "medium" : msg.params.value) }),
        } });
        await c.newSession([]);
        const options = await c.setConfigOption("S1", "thought_level", "high");
        assert.equal(options.find((o) => o.id === "thought_level")?.currentValue, "high");
        await assert.rejects(c.setConfigOption("S1", "thought_level", "xhigh"), { message: "Antigravity did not apply config option thought_level" });
    });

    test("without a model config option, setModel falls back to session/set_model", async (t) => {
        const { fake, c } = await agyClient(t, { answers: { "session/new": () => ({ sessionId: "S1" }) } });
        await c.newSession([]);
        await c.setModel("S1", "gemini-3.8-flash");
        assert.ok(fake.methods().includes("session/set_model"));
    });

    test("Kiro v2 sets the model with session/set_model and has no generic config options", async (t) => {
        const { fake, c } = await kiroClient(t);
        await c.newSession([]);
        await c.setModel("S1", "claude-sonnet");
        assert.ok(fake.methods().includes("session/set_model"));
        assert.ok(!fake.methods().includes("session/set_config_option"));
        await assert.rejects(c.setConfigOption("S1", "thought_level", "high"), { message: "Generic config options require Kiro v3" });
    });
});

describe("standardAcp: native sessions", () => {
    test("loading an id the agent's catalog does not list fails as missing, without session/load", async (t) => {
        const { fake, c } = await agyClient(t, { answers: { "session/list": () => ({ sessions: [{ sessionId: "other", cwd: "/elsewhere" }] }) } });
        await assert.rejects(c.loadSession("gone", "/work"), (error) => error instanceof ACPNativeSessionMissingError
            && error.method === "session/load" && error.sessionId === "gone");
        assert.ok(!fake.methods().includes("session/load"));
        const list = fake.sent.find((msg) => msg.method === "session/list")!;
        assert.deepEqual(list.params, { cwd: "/work" }, "no Kiro _meta");
    });

    test("cwds are compared with symlinks resolved; the catalog is paged", async (t) => {
        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "standard-acp-cwd-")));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        const real = path.join(tmp, "real");
        const link = path.join(tmp, "link");
        fs.mkdirSync(real);
        fs.symlinkSync(real, link);
        const { fake, c } = await agyClient(t, { answers: { "session/list": (msg) => msg.params.cursor
            ? { sessions: [{ sessionId: "kept", cwd: real }] }
            : { sessions: [{ sessionId: "x", cwd: "/elsewhere" }], nextCursor: "p2" } } }, { cwd: link });
        await c.loadSession("kept", link);
        assert.deepEqual(fake.methods().filter((m) => m.startsWith("session/")), ["session/list", "session/list", "session/load"]);
        assert.equal(c.hasSession("kept"), true);
    });

    test("a session listed under another cwd is refused", async (t) => {
        const { fake, c } = await agyClient(t, { answers: { "session/list": () => ({ sessions: [{ sessionId: "kept", cwd: "/other-workspace" }] }) } });
        await assert.rejects(c.loadSession("kept", "/work"), /belongs to another workspace/);
        assert.ok(!fake.methods().includes("session/load"));
    });

    test("without session/list advertised the load goes ahead", async (t) => {
        const { fake, c } = await agyClient(t, { caps: { loadSession: true, sessionCapabilities: {} } });
        await c.loadSession("kept", "/work");
        assert.deepEqual(fake.methods().filter((m) => m.startsWith("session/")), ["session/load"]);
    });

    test("Kiro v2 loads without a catalog check; v3 keeps its _meta scope and path.resolve comparison", async (t) => {
        const v2 = await kiroClient(t, { answers: { "session/list": () => ({ sessions: [] }) } });
        await v2.c.loadSession("kept", "/work");
        assert.ok(!v2.fake.methods().includes("session/list"));

        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "standard-acp-kiro-cwd-")));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        const real = path.join(tmp, "real");
        const link = path.join(tmp, "link");
        fs.mkdirSync(real);
        fs.symlinkSync(real, link);
        const v3 = await kiroClient(t, { answers: { "session/list": () => ({ sessions: [{ sessionId: "kept", cwd: real }] }) } }, { engine: "v3", cwd: link });
        await assert.rejects(v3.c.loadSession("kept", link), /belongs to another workspace/);
        const list = v3.fake.sent.find((msg) => msg.method === "session/list")!;
        assert.deepEqual(list.params, { cwd: link, _meta: { kiro: { scope: "workspace", source: "local" } } });
    });

    test("a released session gets a best-effort session/close when advertised", async (t) => {
        const { fake, c } = await agyClient(t, { answers: { "session/close": () => ({ error: { code: -32603, message: "boom" } }) } });
        await c.newSession([]);
        c.destroySession("S1");
        await settle();
        const close = fake.sent.find((msg) => msg.method === "session/close");
        assert.deepEqual(close?.params, { sessionId: "S1" });
        assert.equal(c.hasSession("S1"), false, "local cleanup ran even though close failed");
        c.destroySession("S1");
        assert.equal(fake.methods().filter((m) => m === "session/close").length, 1, "an unknown session is not closed");
    });

    test("no session/close when the agent does not advertise it, nor for Kiro", async (t) => {
        const agy = await agyClient(t, { caps: { loadSession: true, sessionCapabilities: { list: {} } } });
        await agy.c.newSession([]);
        agy.c.destroySession("S1");
        const kiro = await kiroClient(t);
        await kiro.c.newSession([]);
        kiro.c.destroySession("S1");
        await settle();
        assert.ok(!agy.fake.methods().includes("session/close"));
        assert.ok(!kiro.fake.methods().includes("session/close"));
    });

    test("nativeSessionExists: Kiro's defaults, or no _meta and a caller's cwd form", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const list = async (params: Record<string, unknown>) => { calls.push(params); return { sessions: [{ sessionId: "s", cwd: "/a/./b" }] }; };
        assert.equal(await nativeSessionExists("s", "/a/b", list), true);
        assert.deepEqual(calls[0], { cwd: "/a/b", _meta: { kiro: { scope: "workspace", source: "local" } } });
        assert.equal(await nativeSessionExists("s", "/A/B", list, 1_000, { meta: null, canonicalCwd: (cwd) => path.resolve(cwd).toLowerCase() }), true);
        assert.deepEqual(calls[1], { cwd: "/A/B" });
        assert.equal(realCwd("/definitely/not/here/../x"), "/definitely/not/x", "unresolvable: path.resolve's form");
    });
});

describe("standardAcp: usage from the prompt result", () => {
    const TOKENS = { sessionUpdate: "usage_summary", source: "acp", inputTokens: 6873, outputTokens: 44,
        cachedInputTokens: 4822, reasoningOutputTokens: 18, totalTokens: 6935 };

    test("an ended prompt yields its token usage before turn_end", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        const turn = consume(c.prompt("S1", "hi"));
        await settle();
        fake.answer("session/prompt", { stopReason: "end_turn", usage: USAGE });
        await turn.done;
        assert.deepEqual(turn.kinds(), ["usage_summary", "turn_end"]);
        assert.deepEqual(turn.updates.find((u) => u.sessionUpdate === "usage_summary"), TOKENS);
    });

    test("a cancelled prompt yields its usage too", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        const turn = consume(c.prompt("S1", "hi"));
        await settle();
        await c.cancel("S1");
        assert.ok(fake.methods().includes("session/cancel"));
        fake.answer("session/prompt", { stopReason: "cancelled", usage: USAGE });
        await turn.done;
        assert.deepEqual(turn.updates.filter((u) => u.sessionUpdate !== "session_state"), [TOKENS, { sessionUpdate: "turn_end", stopReason: "cancelled" }]);
    });

    test("only finite numbers are mapped; no usage, no summary", () => {
        const profile = new KiroAcpProfile({ binaryPath: "/fake/agy", cwd: "/work", launch: AGY_LAUNCH });
        assert.deepEqual(profile.usageSummary(undefined, { usage: { inputTokens: 5, outputTokens: Number.NaN, thoughtTokens: "7" } }),
            { sessionUpdate: "usage_summary", source: "acp", inputTokens: 5 });
        assert.equal(profile.usageSummary(undefined, { stopReason: "end_turn" }), undefined);
        assert.equal(profile.usageSummary(undefined, { usage: {} }), undefined);
        assert.equal(profile.usageSummary(undefined, undefined), undefined);
    });

    test("Kiro ignores a prompt result's usage", async (t) => {
        const { fake, c } = await kiroClient(t);
        await c.newSession([]);
        const turn = consume(c.prompt("S1", "hi"));
        await settle();
        fake.answer("session/prompt", { stopReason: "end_turn", usage: USAGE });
        await turn.done;
        assert.deepEqual(turn.kinds(), ["turn_end"]);
        const v3 = new KiroAcpProfile({ binaryPath: "/k", cwd: "/w", engine: "v3" });
        assert.equal(v3.usageSummary(undefined, { usage: USAGE }), undefined);
        assert.deepEqual(v3.usageSummary({ source: "kiro-v3", totalCredits: 1 }, { usage: USAGE }),
            { source: "kiro-v3", totalCredits: 1, sessionUpdate: "usage_summary" });
    });
});

describe("standardAcp: client capabilities, display name", () => {
    test("initialize advertises form elicitation only for standardAcp", async (t) => {
        const agy = await agyClient(t);
        const kiro = await kiroClient(t);
        const crew = await kiroClient(t, {}, { launch: { bin: "/crew", args: () => [] } });
        const init = (fake: ReturnType<typeof fakeAgent>) => fake.sent.find((msg) => msg.method === "initialize")!.params.clientCapabilities;
        assert.deepEqual(init(agy.fake), { elicitation: { form: {} } });
        assert.deepEqual(init(kiro.fake), {});
        assert.deepEqual(init(crew.fake), {});
    });

    test("the display name applies to a standardAcp launch only", () => {
        const base = { binaryPath: "/b", cwd: "/w", displayName: "Antigravity" };
        assert.equal(new KiroAcpProfile({ ...base, launch: AGY_LAUNCH }).displayName, "Antigravity");
        assert.equal(new KiroAcpProfile({ ...base, launch: { bin: "/crew", args: () => [] } }).displayName, "Kiro");
        assert.equal(new KiroAcpProfile(base).displayName, "Kiro");
        assert.equal(new KiroAcpProfile({ binaryPath: "/b", cwd: "/w", launch: AGY_LAUNCH }).displayName, "Kiro");
    });
});

/** agy 1.4.12's ask_question form (recorded), with a string JSON-RPC id. */
const ELICITATION = (id = "1", sessionId = "S1") => ({
    jsonrpc: "2.0", id, method: "elicitation/create",
    params: { sessionId, toolCallId: "call_726171", mode: "form", message: "The agent has a question.",
        requestedSchema: { type: "object", properties: {
            q1: { type: "string", title: "Which of these two colours do you prefer?",
                oneOf: [{ const: "1", title: "(Recommended) Blue" }, { const: "2", title: "Red" }] },
            q1_other: { type: "string", title: "Other", description: "Optional free-form answer to: Which of these two colours do you prefer?" },
        } } },
});

describe("standardAcp: elicitation/create", () => {
    test("asked as a user-input card during the prompt and answered with the chosen value and typed text", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        const turn = consume(c.prompt("S1", "ask me"));
        await settle();
        fake.emit(ELICITATION());
        await settle();
        const asked = turn.updates.find((u) => u.sessionUpdate === "user_input_request")!;
        assert.ok(asked.requestId > ELICITATION_REQUEST_ID_BASE, "outside the runtime's own ask_user ids");
        assert.deepEqual(asked.questions, [{ question: "Which of these two colours do you prefer?",
            options: [{ label: "(Recommended) Blue" }, { label: "Red" }], multiSelect: false }]);
        assert.equal(fake.replyTo("1"), undefined, "waits for the user");
        assert.equal(c.respondToUserInput(asked.requestId, [{ question: asked.questions[0].question, answer: "Red, with stripes" }]), true);
        await settle();
        assert.deepEqual(fake.replyTo("1")!.result, { action: "accept", content: { q1: "2", q1_other: "with stripes" } });
        assert.deepEqual(turn.updates.find((u) => u.sessionUpdate === "user_input_resolved"),
            { sessionUpdate: "user_input_resolved", requestId: asked.requestId, answers: [{ question: asked.questions[0].question, answer: "Red, with stripes" }] });
        fake.answer("session/prompt", { stopReason: "end_turn" });
        await turn.done;
    });

    test("skipping, or cancelling the turn, answers cancel", async (t) => {
        const { fake, c } = await agyClient(t);
        await c.newSession([]);
        const turn = consume(c.prompt("S1", "ask me"));
        await settle();
        fake.emit(ELICITATION("1"));
        await settle();
        const first = turn.updates.find((u) => u.sessionUpdate === "user_input_request")!;
        assert.equal(c.skipUserInput(first.requestId), true);
        await settle();
        assert.deepEqual(fake.replyTo("1")!.result, { action: "cancel" });

        fake.emit(ELICITATION("2"));
        await settle();
        const second = turn.updates.filter((u) => u.sessionUpdate === "user_input_request")[1];
        assert.notEqual(second.requestId, first.requestId);
        await c.cancel("S1");
        await settle();
        assert.deepEqual(fake.replyTo("2")!.result, { action: "cancel" });
        fake.answer("session/prompt", { stopReason: "cancelled" });
        await turn.done;
    });

    test("a form for a session nobody shows is cancelled at once", async (t) => {
        const { fake } = await agyClient(t);
        fake.emit(ELICITATION("7", "unknown"));
        await settle();
        assert.deepEqual(fake.replyTo("7")!.result, { action: "cancel" });
    });

    test("Kiro refuses the request at once, as before", async (t) => {
        const { fake, c } = await kiroClient(t);
        await c.newSession([]);
        fake.emit(ELICITATION("1"));
        assert.deepEqual(fake.replyTo("1")!.error, { code: -32601, message: "Unsupported client method: elicitation/create" });
        assert.equal(new KiroAcpProfile({ binaryPath: "/k", cwd: "/w" }).handleIncomingRequest, undefined);
    });
});

describe("elicitation answers map back to the form's values", () => {
    function ask(schema: Record<string, unknown>, answer: (questions: any[]) => AcpUserAnswer[] | null) {
        const profile = new KiroAcpProfile({ binaryPath: "/fake/agy", cwd: "/work", launch: AGY_LAUNCH });
        const pushed: Array<Record<string, any>> = [];
        let replied: unknown;
        let next = 0;
        const ctx = {
            hasSession: () => true,
            pushUpdate: (_sid: string, update: Record<string, any>) => pushed.push(update),
            nextUserInputRequestId: () => ++next,
            waitForUserInput: async () => answer(pushed[0].questions),
            reply: (_id: unknown, result: unknown) => { replied = result; },
        } as unknown as AcpHandlerContext;
        return profile.handleIncomingRequest!({ id: "1", method: "elicitation/create",
            params: { sessionId: "S1", mode: "form", message: "The agent has a question.", requestedSchema: { type: "object", properties: schema } } }, ctx)
            .then((handled) => ({ handled, pushed, replied }));
    }

    test("labels containing ', ', multi-select arrays, booleans, numbers and free text", async () => {
        const { handled, pushed, replied } = await ask({
            colour: { type: "string", title: "Colour?", oneOf: [{ const: "a", title: "Red, dark" }, { const: "b", title: "Blue" }] },
            colour_other: { type: "string" },
            tools: { type: "array", title: "Tools?", items: { anyOf: [{ const: "git", title: "Git" }, { const: "npm", title: "npm" }] } },
            sure: { type: "boolean", title: "Sure?" },
            count: { type: "integer", title: "How many?" },
            note: { type: "string", description: "Anything else?" },
            size: { type: "string", title: "Size?", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
        }, (questions) => [
            { question: questions[0].question, answer: "Red, dark" },
            { question: questions[1].question, answer: "Git, npm" },
            { question: questions[2].question, answer: "No" },
            { question: questions[3].question, answer: "3" },
            { question: questions[4].question, answer: "ship it" },
            { question: questions[5].question, answer: "" },
        ]);
        assert.equal(handled, true);
        assert.deepEqual(pushed[0].questions.map((q: any) => [q.question, q.options.map((o: any) => o.label), q.multiSelect]), [
            ["Colour?", ["Red, dark", "Blue"], false],
            ["Tools?", ["Git", "npm"], true],
            ["Sure?", ["Yes", "No"], false],
            ["How many?", [], false],
            ["Anything else?", [], false],
            ["Size?", ["Small", "Medium"], false],
        ]);
        assert.equal(pushed[0].requestId, ELICITATION_REQUEST_ID_BASE + 1);
        assert.deepEqual(replied, { action: "accept", content: { colour: "a", tools: ["git", "npm"], sure: false, count: 3, note: "ship it" } });
    });

    test("typed text without a matching option goes to the question itself when it has no _other field", async () => {
        const { replied } = await ask({ pick: { type: "string", title: "Pick", oneOf: [{ const: "1", title: "One" }] } },
            (questions) => [{ question: questions[0].question, answer: "something else" }]);
        assert.deepEqual(replied, { action: "accept", content: { pick: "something else" } });
    });

    test("a form with no questions, or another mode, is cancelled", async () => {
        assert.deepEqual((await ask({}, () => [])).replied, { action: "cancel" });
        const profile = new KiroAcpProfile({ binaryPath: "/fake/agy", cwd: "/work", launch: AGY_LAUNCH });
        let replied: unknown;
        const ctx = { hasSession: () => true, reply: (_id: unknown, result: unknown) => { replied = result; } } as unknown as AcpHandlerContext;
        await profile.handleIncomingRequest!({ id: "2", method: "elicitation/create", params: { sessionId: "S1", mode: "url", url: "https://example.com" } }, ctx);
        assert.deepEqual(replied, { action: "cancel" });
        assert.equal(await profile.handleIncomingRequest!({ id: "3", method: "fs/read_text_file", params: {} }, ctx), false);
    });
});

describe("standardAcp: signed out", () => {
    const AUTH = { error: { code: -32000, message: "Authentication required" } };

    test("a matching RPC error fails as KiroSignedOutError with the flavor's message, classified auth", async (t) => {
        let signedOut = 0;
        const fake = fakeAgent(t, { answers: { "session/new": () => AUTH } });
        const c = new AcpClient(undefined, "/work", undefined, "v2", AGY_LAUNCH, "antigravity",
            { displayName: "Antigravity", signIn: AGY_SIGN_IN, onSignedOut: () => { signedOut++; } });
        t.after(() => c.shutdown());
        c.start();
        await c.initialize();
        const error = await c.newSession([]).catch((e) => e);
        assert.ok(error instanceof KiroSignedOutError);
        assert.equal(error.message, AGY_SIGN_IN.message);
        assert.equal(classifyAcpError(error), "auth");
        assert.equal(signedOut, 0, "kiro-cli's sign-in tracking is not told");
        assert.ok(fake.methods().includes("session/new"));
    });

    test("a matching stderr line makes the process exit a sign-out", async (t) => {
        const { fake, c } = await agyClient(t, { answers: { "session/new": () => HOLD } }, { signIn: AGY_SIGN_IN });
        const opening = c.newSession([]).catch((e) => e);
        await settle();
        fake.stderr("E1102 Authentication required\n");
        fake.exit(1);
        const error = await opening;
        assert.ok(error instanceof KiroSignedOutError);
        assert.equal(error.message, AGY_SIGN_IN.message);
    });

    test("any KiroSignedOutError classifies as auth, whatever its message", () => {
        assert.equal(classifyAcpError(new KiroSignedOutError("Sign in with Google first.")), "auth");
        assert.equal(classifyAcpError(new KiroSignedOutError()), "auth");
    });

    test("without signIn, or without a launch override, the same error stays an ordinary ACPError", async (t) => {
        const agy = await agyClient(t, { answers: { "session/new": () => AUTH } });
        const plain = await agy.c.newSession([]).catch((e) => e);
        assert.ok(plain instanceof ACPError && !(plain instanceof KiroSignedOutError));
        assert.equal(plain.rpcCode, -32000);

        const kiro = await kiroClient(t, { answers: { "session/new": () => AUTH } }, { signIn: AGY_SIGN_IN });
        const kiroError = await kiro.c.newSession([]).catch((e) => e);
        assert.ok(kiroError instanceof ACPError && !(kiroError instanceof KiroSignedOutError), "kiro-cli keeps its own detection");
        assert.equal(classifyAcpError(kiroError), "generic");
    });

    test("kiro-cli's own sign-in errors keep Kiro's message", async (t) => {
        const { c } = await kiroClient(t, { answers: { "session/new": () => ({ error: { code: -32603, message: "Internal error", data: "ExpiredTokenException" } }) } });
        const error = await c.newSession([]).catch((e) => e);
        assert.ok(error instanceof KiroSignedOutError);
        assert.match(error.message, /^Kiro is not signed in\. Run kiro-cli login/);
    });
});
