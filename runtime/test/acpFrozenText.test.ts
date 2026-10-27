/**
 * The ACP client's user-visible texts, log messages, startup marks and perf
 * stages, spelled out. They are frozen: acpErrors.classifyAcpError matches
 * error text, and logs and marks are read by name. Kiro Crew runs the same
 * client and must produce the same texts (its runtime id shows only where the
 * id is reported: child stderr and the raw stream probe).
 */
import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as processTree from "../src/core/processTree";
import { AcpClient, ACPRequestNotSentError, type AcpUpdate } from "../src/adapters/kiro/acpClient";
import type { RuntimeObservability } from "../src/contract/host";

type Frame = Record<string, any>;

function rig(t: TestContext, runtimeId: "kiro" | "crew", options: { idle?: number; cancelTimeoutMs?: number } = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const logs: Array<[string, string, string]> = [];
    const marks: string[] = [];
    const stages: string[] = [];
    const stderr: Array<[string, string]> = [];
    const probes: Frame[] = [];
    const writes: Frame[] = [];
    const replies = new Map<string, (msg: Frame) => Frame | null>();
    let exitOnSignal = true;
    const spawn = () => Object.assign(new EventEmitter(), {
        pid: 777,
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: {
            destroyed: false,
            write: (line: string, cb?: (error?: Error | null) => void) => {
                const msg = JSON.parse(line) as Frame;
                writes.push(msg);
                cb?.(null);
                const reply = typeof msg.method === "string" && msg.id !== undefined ? replies.get(msg.method)?.(msg) : null;
                if (reply) setImmediate(() => feed(reply));
                return true;
            },
        },
    });
    let proc = spawn();
    const feed = (frame: Frame) => proc.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
    t.mock.method(processTree, "spawnAgentProcess", () => { proc = spawn(); const child = proc; queueMicrotask(() => child.emit('spawn')); return proc as never; });
    t.mock.method(processTree, "killProcessTree", (_pid: number, signal?: NodeJS.Signals | number) => {
        const target = proc;
        if (exitOnSignal) setImmediate(() => target.emit("exit", null, String(signal)));
    });
    const observability: RuntimeObservability = {
        log: (level, scope, msg) => logs.push([level, scope, msg]),
        perf: { now: () => 0, mark: (stage) => stages.push(stage), measure: (stage) => stages.push(stage) },
        startupMark: (name) => marks.push(name),
        childStderr: (id, chunk) => stderr.push([id, chunk]),
        streamProbe: { enabled: () => true, write: (row) => probes.push(row) },
    };
    const launch = runtimeId === "crew"
        ? { bin: "/fake/crew-acp", args: () => ["crew-acp"], ...(options.cancelTimeoutMs !== undefined ? { cancelTimeoutMs: options.cancelTimeoutMs } : {}) }
        : undefined;
    const client = new AcpClient("/fake/kiro-cli", "/work", undefined, "v2", launch, runtimeId, {
        observability, ...(options.idle !== undefined ? { acpIdleTimeoutMs: options.idle } : {}),
    });
    replies.set("initialize", (msg) => ({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }));
    replies.set("session/new", (msg) => ({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "S1" } }));
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
    const open = async () => {
        client.start();
        await new Promise<void>(resolve => queueMicrotask(resolve));
        await client.initialize();
        await client.newSession([]);
    };
    const drain = (updates: AsyncIterable<AcpUpdate>) => (async () => { for await (const _ of updates) { /* consume */ } })();
    return {
        client, get proc() { return proc; }, logs, marks, stages, stderr, probes, writes, replies, feed, settle, open, drain,
        ignoreSignals: () => { exitOnSignal = false; },
    };
}

for (const runtimeId of ["kiro", "crew"] as const) {
    describe(`frozen ACP texts (${runtimeId})`, () => {
        test("spawn, handshake and session marks", async (t) => {
            const r = rig(t, runtimeId);
            await r.open();
            assert.deepEqual(r.marks, ["kiro_spawn_start", "kiro_spawn_done", "kiro_initialize_start", "kiro_initialize_done",
                "kiro_session_new_start", "kiro_session_new_done"]);
            assert.deepEqual(r.stages, ["acp:spawn_requested", "acp:initialize", "acp:session_new"]);
            assert.deepEqual(r.logs, [["info", "acp", "kiro process spawned"]]);
            const prompt = r.drain(r.client.prompt("S1", "hi"));
            r.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
            await r.settle();
            r.feed({ jsonrpc: "2.0", id: r.writes.at(-1)!.id, result: { stopReason: "end_turn" } });
            await prompt;
            assert.deepEqual(r.stages.slice(3), ["acp:prompt_entered", "acp:prompt_to_first_update", "acp:prompt_to_first_chunk"]);
            assert.equal(r.probes[0].layer, "acp");
            assert.equal(r.probes[0].phase, "raw_update");
            assert.equal(r.probes[0].runtimeId, runtimeId);
            await r.client.shutdown();
            assert.deepEqual(r.logs.at(-1), ["info", "acp", "kiro process exited"]);
        });

        test("child stderr", async (t) => {
            const r = rig(t, runtimeId);
            r.client.start();
            const written: string[] = [];
            const original = process.stderr.write;
            process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
            try {
                r.proc.stderr.emit("data", Buffer.from("boom\n"));
            } finally {
                process.stderr.write = original;
            }
            assert.deepEqual(written, ["[acp stderr] boom\n"]);
            assert.deepEqual(r.stderr, [[runtimeId, "boom\n"]]);
        });

        test("handshake and session errors", async (t) => {
            const r = rig(t, runtimeId);
            r.client.start();
            r.replies.set("initialize", (msg) => ({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 2 } }));
            await assert.rejects(r.client.initialize(), { message: "Unsupported ACP protocol version" });
            r.replies.set("session/new", (msg) => ({ jsonrpc: "2.0", id: msg.id, result: {} }));
            await assert.rejects(r.client.newSession([]), { message: "session/new returned no sessionId" });
            await assert.rejects(r.drain(r.client.prompt("nope", "hi")), { message: "unknown session: nope" });
            r.replies.set("session/new", (msg) => ({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "S1" } }));
            await r.client.newSession([]);
            r.replies.set("session/set_mode", (msg) => ({ jsonrpc: "2.0", id: msg.id, result: { modes: { currentModeId: "other" } } }));
            await assert.rejects(r.client.setMode("S1", "planner"), { message: "Kiro did not select requested agent planner" });
            r.replies.set("session/set_model", (msg) => ({ jsonrpc: "2.0", id: msg.id, error: { code: -32000 } }));
            await assert.rejects(r.client.setModel("S1", "m"), { message: "unknown ACP error" });
            assert.deepEqual(r.logs.at(-1), ["error", "acp", "rpc request failed"]);
        });

        test("permissions and agent requests", async (t) => {
            const r = rig(t, runtimeId);
            await r.open();
            r.feed({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { sessionId: "S1", options: [{ optionId: "allow", kind: "allow_once" }] } });
            assert.throws(() => r.client.respondToPermission(5, "maybe"), { message: "Unknown permission option" });
            r.feed({ jsonrpc: "2.0", id: 6, method: "fs/read_text_file", params: {} });
            assert.deepEqual(r.writes.at(-1), { jsonrpc: "2.0", id: 6, error: { code: -32601, message: "Unsupported client method: fs/read_text_file" } });
        });

        test("RPC deadlines", async (t) => {
            const r = rig(t, runtimeId, { idle: 100 });
            r.client.start();
            r.replies.set("initialize", () => null);
            const init = assert.rejects(r.client.initialize(50), { message: "Request initialize exceeded its 50ms recovery deadline" });
            t.mock.timers.tick(50);
            await init;
            const idle = assert.rejects(r.client.setMode("S1", "planner"), { message: "Request session/set_mode idle for 100ms (no updates from agent)" });
            t.mock.timers.tick(100);
            await idle;
        });

        test("cancel deadline and the quarantined session", async (t) => {
            const r = rig(t, runtimeId, { cancelTimeoutMs: 10 });
            await r.open();
            const prompt = assert.rejects(r.drain(r.client.prompt("S1", "hi")),
                { message: "Kiro did not finish cancellation. The original session has been retained for recovery." });
            await r.settle();
            await r.client.cancel("S1");
            t.mock.timers.tick(runtimeId === "crew" ? 10 : 5_000);
            await prompt;
            assert.deepEqual(r.logs.at(-1), ["warn", "acp", "cancel deadline exceeded; native session quarantined"]);
            await assert.rejects(r.drain(r.client.prompt("S1", "again")), {
                message: "The previous Kiro turn did not stop. The original session needs recovery before another message can be sent.",
            });
        });

        test("process exit, error and shutdown", async (t) => {
            const r = rig(t, runtimeId);
            await r.open();
            r.replies.set("session/set_mode", () => null);
            const prompt = assert.rejects(r.drain(r.client.prompt("S1", "hi")), { message: "ACP process exited mid-prompt" });
            const pending = assert.rejects(r.client.setMode("S1", "planner"), { message: "ACP process exited with code 3" });
            await r.settle();
            r.proc.emit("exit", 3, null);
            await prompt;
            await pending;
            assert.deepEqual(r.logs.at(-1), ["error", "acp", "kiro process exited unexpectedly"]);
            await assert.rejects(r.client.setMode("S1", "planner"), (error: unknown) =>
                error instanceof ACPRequestNotSentError && error.message === "ACP process exited with code 3");

            r.client.start();
            r.proc.stdin.destroyed = true;
            await assert.rejects(r.client.initialize(), { message: "ACP process is not running" });
            r.proc.stdin.destroyed = false;
            r.proc.emit("error", new Error("spawn EACCES"));
            assert.deepEqual(r.logs.at(-1), ["error", "acp", "kiro process error"]);
        });

        test("a stopped client sends nothing", async (t) => {
            const r = rig(t, runtimeId);
            await r.client.shutdown();
            await assert.rejects(r.client.initialize(), { message: "ACP process stopped" });
        });

        test("shutdown fails requests whose exit was never reported", async (t) => {
            const r = rig(t, runtimeId);
            r.client.start();
            r.replies.set("initialize", () => null);
            const pending = assert.rejects(r.client.initialize(), { message: "client shut down" });
            r.proc.exitCode = 0; // exited, but its exit event never arrived
            await r.client.shutdown();
            await pending;
        });

        test("shutdown of a process that will not exit", async (t) => {
            const r = rig(t, runtimeId);
            r.client.start();
            r.ignoreSignals();
            const shutdown = assert.rejects(r.client.shutdown(), { message: "Kiro process exit could not be confirmed; native recovery was stopped." });
            t.mock.timers.tick(5_000);
            await r.settle();
            t.mock.timers.tick(1_000);
            await shutdown;
        });
    });
}
