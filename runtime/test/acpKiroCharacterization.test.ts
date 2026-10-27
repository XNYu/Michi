/**
 * Characterization record of Kiro's ACP client (adapters/kiro/acpClient.ts),
 * taken before its generic ACP core moved into adapters/acp/.
 *
 * Each scenario drives a real AcpClient against a scripted kiro-cli double
 * (processTree.spawnAgentProcess and killProcessTree are replaced; setTimeout,
 * setInterval and Date are mocked) and records, step by step and per channel:
 *   wire           every JSON-RPC message the client wrote to the agent's stdin
 *   spawn, kill    process launches and the signals sent to them
 *   <label>        what a prompt or an agent-initiated turn yielded, and how it ended
 *   =<label>       what an API call returned or threw
 *   workflow       what reached the workflow router
 *   log, startup, perf, stderr   what reached the observability port
 *   state          public queries taken at chosen points
 * Every agent frame arrives in its own macrotask, as from a pipe, so each one
 * settles before the next. Order is recorded within a channel and between
 * steps, not across channels inside one step: that would pin microtask
 * scheduling, not behavior.
 *
 * Any difference from the golden files is a behavior change: stop and report
 * it; never regenerate the files to absorb one. They were written once, with
 * UPDATE_GOLDEN=1, from the code they characterize.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import * as processTree from "../src/core/processTree";
import { AcpClient, type AcpLaunch, type AcpUpdate, type AcpWorkflowRouter } from "../src/adapters/kiro/acpClient";
import type { KiroEngine } from "../src/adapters/kiro/kiroProtocol";
import type { RuntimeObservability } from "../src/contract/host";

const GOLDEN_DIR = path.join(__dirname, "fixtures", "acpKiroCharacterization");

type Frame = Record<string, any>;
type Step = { step: string } & Record<string, unknown>;
/** Frames to send back for a request, or "hold" to answer it later. */
type Responder = (msg: Frame) => Frame[] | "hold";

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function errorOf(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) return { thrown: String(error) };
    const details = error as Error & Record<string, unknown>;
    const out: Record<string, unknown> = { error: error.name, message: error.message };
    for (const key of ["method", "sessionId", "rpcCode", "rpcData"]) {
        if (details[key] !== undefined) out[key] = details[key];
    }
    return out;
}

/** JSON-safe copy that keeps undefined-valued keys visible and masks clock-derived state versions. */
function normalize(value: unknown, key?: string): unknown {
    if (value === undefined) return "<undefined>";
    if (value instanceof Error) return errorOf(value);
    if (typeof value === "function") return "<function>";
    if (typeof value === "number" && key === "version" && value > 1e9) return "<version>";
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
    }
    return value;
}

class Recorder {
    readonly steps: Step[] = [{ step: "setup" }];

    begin(name: string): void {
        this.steps.push({ step: name });
    }

    add(channel: string, value: unknown): void {
        const step = this.steps[this.steps.length - 1];
        const list = (step[channel] as unknown[] | undefined) ?? [];
        step[channel] = list;
        list.push(normalize(value));
    }
}

function observabilityFor(rec: Recorder, probe = false): RuntimeObservability {
    return {
        log: (level, scope, msg, data) => rec.add("log", data === undefined ? [level, scope, msg] : [level, scope, msg, data]),
        perf: {
            now: () => 0,
            mark: (stage, meta) => rec.add("perf", ["mark", stage, meta]),
            measure: (stage, _start, meta) => rec.add("perf", ["measure", stage, meta]),
        },
        startupMark: (name, extra) => rec.add("startup", [name, extra]),
        childStderr: (runtimeId, chunk) => rec.add("stderr", [runtimeId, chunk]),
        ...(probe ? { streamProbe: { enabled: () => true, write: (row: Record<string, unknown>) => rec.add("probe", row) } } : {}),
    };
}

// ---------------------------------------------------------------------------
// The kiro-cli double
// ---------------------------------------------------------------------------

type FakeProc = EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { destroyed: boolean; write(line: string, cb?: (error?: Error | null) => void): boolean };
};

class FakeAgent {
    readonly procs: FakeProc[] = [];
    private readonly responders = new Map<string, Responder>();
    private readonly held = new Map<string, Frame[]>();
    private inflight = 0;
    /** Signals the current process exits on. */
    exitOn = new Set<string>(["SIGTERM", "SIGKILL"]);

    constructor(private readonly rec: Recorder) {}

    get proc(): FakeProc {
        return this.procs[this.procs.length - 1];
    }

    spawn(): FakeProc {
        const proc = Object.assign(new EventEmitter(), {
            pid: 4242 + this.procs.length,
            exitCode: null as number | null,
            signalCode: null as string | null,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            stdin: {
                destroyed: false,
                write: (line: string, cb?: (error?: Error | null) => void) => {
                    const msg = JSON.parse(line) as Frame;
                    this.rec.add("wire", msg);
                    cb?.(null);
                    this.receive(msg);
                    return true;
                },
            },
        });
        this.procs.push(proc);
        return proc;
    }

    on(method: string, responder: Responder): void {
        this.responders.set(method, responder);
    }

    private receive(msg: Frame): void {
        if (typeof msg.method !== "string") return; // our reply to an agent request
        const responder = this.responders.get(msg.method);
        const isRequest = msg.id !== undefined && msg.id !== null;
        if (!responder) {
            if (isRequest) this.hold(msg);
            return;
        }
        const frames = responder(msg);
        if (frames === "hold") this.hold(msg);
        else this.send(...frames);
    }

    private hold(msg: Frame): void {
        const list = this.held.get(msg.method) ?? [];
        list.push(msg);
        this.held.set(msg.method, list);
    }

    /** Answer the oldest held request of `method`. */
    answer(method: string, frames: (msg: Frame) => Frame[]): void {
        const msg = this.held.get(method)?.shift();
        if (!msg) throw new Error(`no held ${method} request`);
        this.send(...frames(msg));
    }

    /** One stdout chunk per frame, each in its own macrotask. */
    send(...frames: Frame[]): void {
        for (const frame of frames) this.raw(`${JSON.stringify(frame)}\n`);
    }

    /** Several frames in one stdout chunk. */
    burst(...frames: Frame[]): void {
        this.raw(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
    }

    raw(text: string): void {
        const proc = this.proc;
        this.inflight++;
        setImmediate(() => {
            this.inflight--;
            proc.stdout.emit("data", Buffer.from(text));
        });
    }

    exit(code: number | null, signal: string | null): void {
        const proc = this.proc;
        proc.exitCode = code;
        proc.signalCode = signal;
        proc.emit("exit", code, signal);
    }

    kill(pid: number, signal: string): void {
        this.rec.add("kill", [pid, signal]);
        const proc = this.procs.find((candidate) => candidate.pid === pid);
        if (!proc || !this.exitOn.has(signal)) return;
        this.inflight++;
        setImmediate(() => {
            this.inflight--;
            proc.exitCode = null;
            proc.signalCode = signal;
            proc.emit("exit", null, signal);
        });
    }

    async settle(): Promise<void> {
        let quiet = 0;
        while (quiet < 3) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            quiet = this.inflight === 0 ? quiet + 1 : 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const rpc = (msg: Frame, result: unknown): Frame => ({ jsonrpc: "2.0", id: msg.id, result });
const rpcError = (msg: Frame, code: number, message: string, data?: unknown): Frame =>
    ({ jsonrpc: "2.0", id: msg.id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const note = (method: string, params: Frame): Frame => ({ jsonrpc: "2.0", method, params });
const request = (id: number | string, method: string, params: Frame): Frame => ({ jsonrpc: "2.0", id, method, params });
const update = (sessionId: string, body: Frame): Frame => note("session/update", { sessionId, update: body });
const chunk = (sessionId: string, text: string, meta?: Frame): Frame =>
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(meta ? { _meta: meta } : {}) });
const info = (sessionId: string, kiro: Frame): Frame => update(sessionId, { sessionUpdate: "session_info_update", _meta: { kiro } });
const permission = (id: number | string, sessionId: string, options: Frame[], meta?: Frame): Frame =>
    request(id, "session/request_permission", {
        sessionId, toolCall: { toolCallId: `perm-${id}`, title: "Edit file" }, options, ...(meta ? { _meta: meta } : {}),
    });
const ALLOW_REJECT = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
];

const V2_INIT = { protocolVersion: 1, agentInfo: { name: "kiro", version: "2.34.0" },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
const V3_EXTENSIONS = ["_kiro/session/compact", "_kiro/session/context", "_kiro/workflow/pause", "_kiro/workflow/resume", "_kiro/session/history"];
const V3_INIT = { protocolVersion: 1, agentInfo: { name: "kiro", version: "2.34.0" },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true },
        sessionCapabilities: { fork: {}, list: {} }, _meta: { kiro: { extensionMethods: V3_EXTENSIONS } } } };
const V3_CONFIG = [
    { id: "model", type: "select", category: "model", currentValue: "m1", options: [
        { value: "m1", name: "Model one" },
        { value: "m2", name: "Model two", _meta: { kiro: { hasEffort: true, effortLevels: ["low", "high"], defaultEffortLevel: "low" } } },
    ] },
    { id: "mode", type: "select", category: "mode", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "planner", name: "Planner" }] },
    { id: "effortLevel", type: "select", currentValue: "low", options: [{ group: "Effort", options: [{ value: "low" }, { value: "high" }] }] },
];

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

interface Options {
    engine?: KiroEngine;
    model?: string;
    launch?: AcpLaunch;
    runtimeId?: string;
    idle?: number;
    probe?: boolean;
    spawnEnv?: () => NodeJS.ProcessEnv;
    preloadTools?: () => boolean;
}

function scenario(t: TestContext, options: Options = {}) {
    const rec = new Recorder();
    const agent = new FakeAgent(rec);
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
    t.mock.method(processTree, "spawnAgentProcess", (bin: string, args: string[], spawnOptions?: SpawnOptions) => {
        const env = spawnOptions?.env;
        rec.add("spawn", { bin, args, cwd: spawnOptions?.cwd,
            env: env ? { HOST_MARKER: env.HOST_MARKER } : "<inherited>" });
        const proc = agent.spawn();
        queueMicrotask(() => proc.emit('spawn'));
        return proc as never;
    });
    t.mock.method(processTree, "killProcessTree", (pid: number, signal?: NodeJS.Signals | number) => agent.kill(pid, String(signal)));
    const client = new AcpClient("/fake/kiro-cli", "/work", options.model, options.engine ?? "v2", options.launch,
        options.runtimeId ?? "kiro", {
            observability: observabilityFor(rec, options.probe),
            ...(options.idle !== undefined ? { acpIdleTimeoutMs: options.idle } : {}),
            ...(options.spawnEnv ? { spawnEnv: options.spawnEnv } : {}),
            ...(options.preloadTools ? { preloadTools: options.preloadTools } : {}),
        });
    const engine = options.engine ?? "v2";
    agent.on("initialize", (msg) => [rpc(msg, engine === "v3" ? V3_INIT : V2_INIT)]);
    let sessions = 0;
    agent.on("session/new", (msg) => [rpc(msg, engine === "v3"
        ? { sessionId: `S${++sessions}`, configOptions: V3_CONFIG }
        : { sessionId: `S${++sessions}`,
            modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "planner", name: "Planner" }] },
            models: { currentModelId: "claude-x", availableModels: [{ modelId: "claude-x", name: "X" }] } })]);
    agent.on("session/prompt", () => "hold");

    /** Run `action`, then let every reply and its consequences settle. */
    const step = async (name: string, action?: () => void): Promise<void> => {
        rec.begin(name);
        action?.();
        await agent.settle();
    };
    /** Record what a call returns or throws, whenever it settles. */
    const track = (label: string, call: () => unknown, resolvedOnly = false): void => {
        let value: unknown;
        try { value = call(); } catch (error) { rec.add(`=${label}`, errorOf(error)); return; }
        if (value instanceof Promise) {
            value.then((result) => rec.add(`=${label}`, resolvedOnly ? "<resolved>" : result),
                (error) => rec.add(`=${label}`, errorOf(error)));
        } else rec.add(`=${label}`, value);
    };
    /** Record every update a stream yields, then how it ended. */
    const consume = (label: string, updates: AsyncIterable<AcpUpdate>): void => {
        void (async () => {
            try {
                for await (const item of updates) rec.add(label, item);
                rec.add(label, "<end>");
            } catch (error) {
                rec.add(label, errorOf(error));
            }
        })();
    };
    const prompt = (label: string, sessionId: string, text: string, signal?: AbortSignal): void =>
        consume(label, client.prompt(sessionId, text, [], signal));
    const state = (sessionId: string): void => rec.add("state", {
        sessionId,
        alive: client.isAlive(),
        hasSession: client.hasSession(sessionId),
        needsSessionRecovery: client.needsSessionRecovery(sessionId),
        hasHealthyWork: client.hasHealthyWork(),
        hasUnconfirmedExit: client.hasUnconfirmedExit(),
        info: client.getSessionInfo(sessionId),
        sessionState: client.getSessionState(sessionId),
    });
    /** start + initialize + one session/new. */
    const open = async (): Promise<void> => {
        await step("start", () => client.start());
        await step("initialize", () => track("initialize", () => client.initialize(), true));
        await step("session/new", () => track("newSession", () => client.newSession([])));
    };
    return { rec, agent, client, step, track, consume, prompt, state, open };
}

function assertGolden(name: string, rec: Recorder): void {
    const file = path.join(GOLDEN_DIR, `${name}.json`);
    // Channels sorted by name: which one a step touched first is scheduling, not behavior.
    const steps = rec.steps.map(({ step, ...channels }) =>
        ({ step, ...Object.fromEntries(Object.keys(channels).sort().map((key) => [key, channels[key]])) }));
    const text = `${JSON.stringify(steps, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(file, text);
    }
    assert.equal(text, fs.readFileSync(file, "utf8"), `${name}.json`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test("S01 v2 process and session lifecycle", async (t) => {
    const s = scenario(t, { model: "claude-x" });
    s.agent.on("session/set_mode", (msg) => [rpc(msg, msg.params.modeId === "planner"
        ? { modes: { currentModeId: "planner" } } : { modes: { currentModeId: "default" } })]);
    s.agent.on("session/set_model", (msg) => [rpc(msg, {})]);
    s.agent.on("_kiro.dev/commands/execute", (msg) => [rpc(msg, { success: true, message: "usage shown", data: { credits: 3 } })]);

    await s.step("start", () => s.client.start());
    await s.step("start twice is a no-op", () => s.client.start());
    await s.step("initialize", () => s.track("initialize", () => s.client.initialize(), true));
    await s.step("capabilities", () => s.rec.add("capabilities", s.client.capabilities));
    await s.step("session/new with an MCP server", () => s.track("newSession", () => s.client.newSession([
        { name: "michi", type: "http", url: "http://127.0.0.1:1/api/mcp/slot", headers: [] },
    ])));
    await s.step("session/new with metadata and a model", () => s.track("newSession2", () =>
        s.client.newSession([], { metadata: { chatId: "c1" }, modelId: "claude-y", modeId: "planner" })));
    await s.step("state", () => { s.state("S1"); s.state("S2"); s.state("missing"); });
    await s.step("set_mode", () => s.track("setMode", () => s.client.setMode("S1", "planner")));
    await s.step("set_mode the agent did not apply", () => s.track("setMode2", () => s.client.setMode("S1", "absent")));
    await s.step("set_model", () => s.track("setModel", () => s.client.setModel("S1", "claude-z", 2_000)));
    await s.step("state after configuration", () => s.state("S1"));
    await s.step("commands/execute", () => s.track("executeCommand", () => s.client.executeCommand("S1", "usage")));
    await s.step("set_config_option needs v3", () => s.track("setConfigOption", () => s.client.setConfigOption("S1", "x", "y")));
    await s.step("unknown session prompt", () => s.prompt("p0", "nope", "hi"));
    await s.step("shutdown", () => s.track("shutdown", () => s.client.shutdown()));
    await s.step("state after shutdown", () => s.state("S1"));
    await s.step("calls after shutdown", () => {
        s.track("setModeAfter", () => s.client.setMode("S1", "planner"));
        s.track("cancelAfter", () => s.client.cancel("S1"));
    });
    await s.step("shutdown without a process", () => s.track("shutdown2", () => s.client.shutdown()));
    await s.step("restart", () => s.client.start());
    await s.step("state after restart", () => s.state("S1"));
    assertGolden("S01-v2-lifecycle", s.rec);
});

test("S02 v2 prompt: metadata, subagent routing, MCP failures, usage", async (t) => {
    const s = scenario(t, { model: "claude-x" });
    await s.open();
    await s.step("between-turn context usage is buffered", () => s.agent.send(
        note("_kiro.dev/metadata", { sessionId: "S1", contextUsagePercentage: 12 })));
    await s.step("prompt", () => s.prompt("p1", "S1", "hello"));
    await s.step("delegations and a subagent roster", () => s.agent.send(
        update("S1", { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Agent", kind: "other", status: "in_progress" }),
        update("S1", { sessionUpdate: "tool_call", toolCallId: "tc-read", title: "Read file", kind: "read", status: "in_progress" }),
        note("_kiro.dev/subagent/list_update", { subagents: [{ sessionId: "C1", name: "coder", status: "Running" }, { name: "anonymous" }] }),
    ));
    await s.step("child narration and tools reach the parent", () => s.agent.send(
        chunk("C1", "child says hi"),
        chunk("C1", ""),
        update("C1", { sessionUpdate: "tool_call", toolCallId: "ct1", title: "grep", kind: "search", status: "in_progress" }),
        update("C1", { sessionUpdate: "tool_call_update", toolCallId: "ct1", status: "completed", rawOutput: { matches: 2 } }),
    ));
    await s.step("a second concurrent delegation from another session", () => s.agent.send(
        update("S9", { sessionUpdate: "tool_call", toolCallId: "tc9", title: "spawn helper" }),
        note("_kiro.dev/subagent/list_update", { subagents: [{ sessionId: "C1", name: "coder" }, { sessionId: "C2", name: "helper" }] }),
    ));
    await s.step("Kiro extension updates and metadata", () => s.agent.send(
        note("_kiro.dev/session/update", { sessionId: "S1", update: { sessionUpdate: "tool_call_chunk", toolCallId: "tc1", chunk: "x" } }),
        note("_kiro.dev/metadata", { sessionId: "S1", contextUsagePercentage: 30 }),
        note("_kiro.dev/mcp/server_init_failure", { sessionId: "S1", serverName: "broken", error: { code: 1, message: "no binary" } }),
        note("_kiro.dev/mcp/server_init_failure", { serverName: "sessionless" }),
        note("_kiro.dev/session/inbox_notification", { sessionId: "S1", messageCount: 2, senders: ["alice", "bob"] }),
        note("_kiro.dev/session/inbox_notification", { messageCount: 1 }),
        note("_kiro.dev/mcp/server_initialized", { sessionId: "S1", serverName: "michi" }),
        note("_kiro.dev/commands/available", { sessionId: "S1", commands: [] }),
        update("S1", { sessionUpdate: "plan", entries: [{ content: "do it", priority: "high", status: "pending" }] }),
        update("S1", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }),
        update("S1", { sessionUpdate: "config_option_update", configOptions: [{ id: "x", type: "boolean", currentValue: true }] }),
        update("S1", { sessionUpdate: "current_mode_update", currentModeId: "planner" }),
    ));
    await s.step("the delegation completes", () => s.agent.send(
        update("S1", { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" }),
        update("S9", { sessionUpdate: "tool_call_update", toolCallId: "tc9", status: "error" }),
        note("_kiro.dev/subagent/list_update", { subagents: [] }),
    ));
    await s.step("turn-end metadata", () => s.agent.send(
        note("_kiro.dev/metadata", { sessionId: "S1", contextUsagePercentage: 31, meteringUsage: [{ unit: "credit", value: 1.5 }], turnDurationMs: 1234 })));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("state", () => s.state("S1"));
    await s.step("next prompt starts clean", () => s.prompt("p2", "S1", "again"));
    await s.step("an empty roster with no owner is discarded", () => s.agent.send(
        note("_kiro.dev/subagent/list_update", { subagents: [] }),
        note("_kiro.dev/subagent/list_update", { subagents: [{ sessionId: "C3" }] }),
    ));
    await s.step("prompt result without metadata", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "max_tokens" })]));
    await s.step("prompt the agent rejects", () => s.prompt("p3", "S1", "fail"));
    await s.step("rejection", () => s.agent.answer("session/prompt", (msg) => [rpcError(msg, -32603, "Internal error", { reason: "x".repeat(5000) })]));
    await s.step("prompt with image blocks", () => s.consume("p4", s.client.prompt("S1", "look", [{ type: "image", mimeType: "image/png", data: "AAAA" }])));
    await s.step("an error without a message", () => s.agent.answer("session/prompt", (msg) => [{ jsonrpc: "2.0", id: msg.id, error: { code: 1 } }]));
    assertGolden("S02-v2-prompt-routing", s.rec);
});

test("S03 v2 compaction, clear, rewind fork and command errors", async (t) => {
    const s = scenario(t);
    const points = { success: true, data: { turns: [{ logIndex: 0, label: "first" }, { logIndex: 2, label: "second" }, { logIndex: -1 }, { logIndex: "3" }] } };
    s.agent.on("_kiro.dev/commands/execute", (msg) => {
        const { command, args } = msg.params.command;
        if (command === "compact" && args.instructions === "fail") {
            return [rpc(msg, { success: true }), note("_kiro.dev/compaction/status", { sessionId: msg.params.sessionId, status: { type: "failed", message: "compaction broke" } })];
        }
        if (command === "compact" && args.instructions === "refuse") return [rpc(msg, { success: false, message: "busy" })];
        if (command === "compact") {
            return [rpc(msg, { success: true }),
                note("_kiro.dev/compaction/status", { sessionId: msg.params.sessionId, status: { type: "started" } }),
                note("_kiro.dev/compaction/status", { sessionId: msg.params.sessionId, status: { type: "completed" }, summary: "short" })];
        }
        if (command === "rewind" && args.value === undefined) return [rpc(msg, points)];
        if (command === "rewind") return [rpc(msg, { success: true, data: { sessionId: args.value === "2" ? "S2" : "F1" } })];
        return [rpcError(msg, -32000, `unknown command ${command}`)];
    });
    await s.open();
    await s.step("second session", () => s.track("newSession2", () => s.client.newSession([])));
    await s.step("compact", () => s.track("compact", () => s.client.compact("S1", "  keep decisions  ")));
    await s.step("compaction notifications during a prompt", () => {
        s.prompt("p1", "S1", "go");
        s.agent.send(
            note("_kiro.dev/compaction/status", { sessionId: "S1", status: { type: "started" } }),
            note("_kiro.dev/compaction/status", { sessionId: "S1", status: { type: "completed" }, summary: 42 }),
            note("_kiro.dev/compaction/status", { sessionId: "S1", status: { type: "error" } }),
            note("_kiro.dev/clear/status", { sessionId: "S1" }),
            note("_kiro.dev/clear/status", {}),
        );
    });
    await s.step("compact refused while prompting", () => s.track("compactBusy", () => s.client.compact("S1")));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("compaction the agent declines", () => s.track("compactRefused", () => s.client.compact("S1", "refuse")));
    await s.step("compaction that fails", () => s.track("compactFailed", () => s.client.compact("S1", "fail")));
    await s.step("state after a failed compaction", () => s.state("S1"));
    await s.step("rewind fork", () => s.track("fork", () => s.client.forkSession("S2")));
    await s.step("rewind fork to a named point", () => s.track("fork2", () => s.client.forkSession("S2", { logIndex: 2 })));
    await s.step("rewind fork to a missing point", () => s.track("fork3", () => s.client.forkSession("S2", { logIndex: 7 })));
    await s.step("command error", () => s.track("command", () => s.client.executeCommand("S2", "mystery", { a: 1 }, 500)));
    await s.step("compaction completion timeout", () => {
        s.agent.on("_kiro.dev/commands/execute", (msg) => [rpc(msg, { success: true })]);
        s.track("newSession3", () => s.client.newSession([]));
    });
    await s.step("compact waits", () => s.track("compactTimeout", () => s.client.compact("S3", undefined, 300)));
    await s.step("deadline", () => t.mock.timers.tick(300));
    await s.step("state after the deadline", () => s.state("S3"));
    await s.step("compaction cut short by release", () => {
        s.track("newSession4", () => s.client.newSession([]));
    });
    await s.step("compact then release", () => {
        s.track("compactReleased", () => s.client.compact("S4"));
    });
    await s.step("release", () => s.client.destroySession("S4"));
    await s.step("state after release", () => s.state("S4"));
    assertGolden("S03-v2-compact-fork", s.rec);
});

test("S04 v3 handshake, session state, commands and extension discovery", async (t) => {
    const s = scenario(t, { engine: "v3", model: "m1", spawnEnv: () => ({ HOST_MARKER: "host" }) });
    s.agent.on("session/set_config_option", (msg) => {
        const configOptions = V3_CONFIG.map((option) => option.id === msg.params.configId
            ? { ...option, currentValue: msg.params.value === "refuse" ? option.currentValue : msg.params.value } : option);
        return [rpc(msg, msg.params.value === "none" ? {} : { configOptions })];
    });
    s.agent.on("_kiro/session/context", (msg) => [rpc(msg, { success: true, message: "ctx", files: 3 })]);
    s.agent.on("_kiro/session/history", (msg) => [rpcError(msg, -32601, "Method not found")]);
    s.agent.on("_kiro/session/compact", (msg) => [rpc(msg, { success: false, message: "nothing to compact" })]);
    await s.step("start", () => s.client.start());
    await s.step("initialize", () => s.track("initialize", () => s.client.initialize(10_000), true));
    await s.step("capabilities", () => s.rec.add("capabilities", s.client.capabilities));
    await s.step("session/new with options", () => s.track("newSession", () => s.client.newSession([
        { name: "michi", type: "http", url: "http://127.0.0.1:1/api/mcp/slot", headers: [], _meta: { kiro: { waitForReady: true, versionNegotiation: "legacy" } } },
    ], { modelId: "m2", modeId: "planner", workflowsEnabled: true, metadata: { chatId: "c1" } })));
    await s.step("session/new without options", () => s.track("newSession2", () => s.client.newSession()));
    const seen: string[] = [];
    await s.step("subscribe", () => { s.rec.add("unsubscribe", typeof s.client.onSessionState("S1", () => seen.push("S1"))); });
    await s.step("commands, MCP status and tools", () => s.agent.send(
        update("S1", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }, { name: "context" }] }),
        note("_kiro/mcp/status", { sessionId: "S1", servers: [{ name: "michi", status: "connected" }, { name: "broken", status: "failed", errorMessage: "boom" }, { name: "other", status: "error" }] }),
        note("_kiro/mcp/status", { sessionId: "S1" }),
        note("_kiro/tools/didChange", { sessionId: "S1", tools: [{ name: "read" }, { name: "write" }] }),
        note("_kiro/tools/didChange", { sessionId: 7, tools: [] }),
    ));
    await s.step("state", () => { s.state("S1"); s.rec.add("notified", [...seen]); });
    await s.step("command catalog", () => {
        s.track("mcp", () => s.client.executeCommand("S1", "mcp"));
        s.track("tools", () => s.client.executeCommand("S1", "tools"));
        s.track("toolsUnknown", () => s.client.executeCommand("S2", "tools"));
        s.track("effortList", () => s.client.executeCommand("S1", "effort"));
        s.track("effortBad", () => s.client.executeCommand("S1", "effort", { value: "max" }));
        s.track("unsupported", () => s.client.executeCommand("S1", "doctor"));
    });
    await s.step("effort", () => s.track("effort", () => s.client.executeCommand("S1", "effort", { value: "high" })));
    await s.step("advertised command", () => s.track("context", () => s.client.executeCommand("S1", "context", { verbose: true })));
    await s.step("command the server declines", () => s.track("compactCommand", () => s.client.executeCommand("S1", "compact")));
    await s.step("unadvertised command", () => s.track("export", () => s.client.executeCommand("S1", "export")));
    await s.step("advertised method that is missing", () => s.track("history", () => s.client.executeCommand("S1", "history")));
    await s.step("after -32601", () => {
        s.rec.add("supports", ["_kiro/session/history", s.client.supportsExtension("_kiro/session/history")]);
        s.rec.add("supports", ["_session/steer", s.client.supportsExtension("_session/steer")]);
        s.rec.add("supports", ["_kiro/account/getUsage", s.client.supportsExtension("_kiro/account/getUsage")]);
        s.rec.add("supports", ["_kiro/other", s.client.supportsExtension("_kiro/other")]);
        s.state("S1");
        s.rec.add("notified", [...seen]);
    });
    await s.step("set_model through config", () => s.track("setModel", () => s.client.setModel("S1", "m2", 1_000)));
    await s.step("set_config_option", () => s.track("setConfigOption", () => s.client.setConfigOption("S1", "mode", "planner")));
    await s.step("set_config_option not applied", () => s.track("setConfigRefused", () => s.client.setConfigOption("S1", "mode", "refuse")));
    await s.step("set_config_option without options", () => s.track("setConfigNone", () => s.client.setConfigOption("S1", "mode", "none")));
    await s.step("set_mode", () => {
        s.agent.on("session/set_mode", (msg) => [rpc(msg, { configOptions: V3_CONFIG.map((o) => o.id === "mode" ? { ...o, currentValue: msg.params.modeId } : o) })]);
        s.track("setMode", () => s.client.setMode("S1", "planner"));
    });
    await s.step("state after configuration", () => s.state("S1"));
    await s.step("set_model without a model option", () => {
        s.agent.on("session/new", (msg) => [rpc(msg, { sessionId: "S3" })]);
        s.track("newSession3", () => s.client.newSession([]));
    });
    await s.step("set_model refused", () => s.track("setModelMissing", () => s.client.setModel("S3", "m2")));
    await s.step("session/new without a sessionId", () => {
        s.agent.on("session/new", (msg) => [rpc(msg, { modes: {} })]);
        s.track("newSessionBad", () => s.client.newSession([]));
    });
    assertGolden("S04-v3-handshake-state", s.rec);
});

test("S05 v3 prompt: session info kinds, usage and heartbeats", async (t) => {
    const s = scenario(t, { engine: "v3", probe: true });
    await s.open();
    await s.step("between-turn info", () => s.agent.send(
        update("S1", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }),
        info("S1", { kind: "context_update", contextUsage: { usagePercentage: 18.5 } }),
    ));
    await s.step("prompt", () => s.prompt("p1", "S1", "hello"));
    await s.step("turn frames", () => s.agent.send(
        info("S1", { kind: "turn_start" }),
        chunk("S1", "Hel"),
        update("S1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } }),
        info("S1", { kind: "focus_update", contextUsage: { usagePercentage: 22 } }),
        info("S1", { kind: "display_error", displayError: { message: "tool blew up" } }),
        info("S1", { kind: "display_error", displayError: { errorType: "mcp_connection_error", message: "mcp down" } }),
        info("S1", { kind: "display_error" }),
        update("S1", { sessionUpdate: "config_option_update", configOptions: V3_CONFIG.map((o) => o.id === "model" ? { ...o, currentValue: "m2" } : o) }),
        update("S1", { sessionUpdate: "current_mode_update", currentModeId: "planner" }),
        chunk("S1", "lo"),
    ));
    await s.step("heartbeat", () => t.mock.timers.tick(10_000));
    await s.step("turn completion", () => s.agent.send(
        info("S1", { kind: "turn_completion", elapsedTime: 4321, promptTurnSummaries: [{ unit: "credit", usage: 0.25 }, { unitPlural: "credits", usage: 0.5 }, { unit: "token", usage: 99 }] }),
        info("S1", { kind: "turn_end", stopReason: "end_turn" }),
    ));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("state", () => s.state("S1"));
    await s.step("prompt without usage", () => s.prompt("p2", "S1", "short"));
    await s.step("turn completion without credits", () => s.agent.send(
        info("S1", { kind: "turn_completion" }),
        info("S1", { kind: "context_update", contextUsage: { usagePercentage: "n/a" } }),
    ));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S05-v3-prompt-info", s.rec);
});

test("S06 permission requests, answers and consent", async (t) => {
    const s = scenario(t, { engine: "v3" });
    await s.open();
    await s.step("prompt", () => s.prompt("p1", "S1", "edit"));
    await s.step("requests", () => s.agent.send(
        permission(5, "S1", ALLOW_REJECT),
        permission("abc", "S1", ALLOW_REJECT),
        permission(5, "S1", ALLOW_REJECT),
        permission(6, "S1", ALLOW_REJECT, { kiro: { consent: { capability: "fs.write", resource: "/work/a", triggeringResource: "/work/a.ts", workspaceRoot: "/work" } } }),
        permission(7, "S1", ALLOW_REJECT, { kiro: { consent: { capability: "shell", resource: "ls" } } }),
        permission(8, "unknown-session", ALLOW_REJECT),
        request(9, "session/request_permission", { toolCall: { title: "no session" }, options: ALLOW_REJECT }),
        permission(1.5, "S1", ALLOW_REJECT),
    ));
    await s.step("answers", () => {
        s.track("respond5", () => s.client.respondToPermission(5, "allow"));
        s.track("respond5again", () => s.client.respondToPermission(5, "allow"));
        s.track("respondUnknownOption", () => s.client.respondToPermission(-1, "maybe"));
        s.track("respondKindReject", () => s.client.respondToPermissionKind(-1, "reject_once"));
        s.track("respondAlwaysWithConsent", () => s.client.respondToPermission(6, "always"));
        s.track("respondAlwaysNoTrigger", () => s.client.respondToPermission(7, "always"));
        s.track("respondKindMissing", () => s.client.respondToPermissionKind(-2, "allow_once"));
    });
    await s.step("resolved elsewhere", () => s.agent.send(
        note("_michi/permission_resolved", { sessionId: "other", requestId: 1.5 }),
        note("_michi/permission_resolved", { sessionId: "S1", requestId: 1.5 }),
        note("_michi/permission_resolved", { sessionId: "S1", requestId: 404 }),
    ));
    await s.step("more requests, cancelled with the session's", () => {
        s.agent.send(permission(10, "S1", ALLOW_REJECT), permission(11, "S1", [{ optionId: "only", name: "Only" }]));
    });
    await s.step("cancel the session's permissions", () => s.client.cancelPermissionsForSession("S1"));
    await s.step("answer after cancellation", () => s.track("respondLate", () => s.client.respondToPermission(10, "allow")));
    await s.step("an option-less request accepts any option", () => s.agent.send(request(12, "session/request_permission", { sessionId: "S1", toolCall: {} })));
    await s.step("answer it", () => s.track("respondFree", () => s.client.respondToPermission(12, "whatever")));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S06-permissions", s.rec);
});

test("S06b v2 permission consent is not forwarded", async (t) => {
    const s = scenario(t);
    await s.open();
    await s.step("prompt", () => s.prompt("p1", "S1", "edit"));
    await s.step("request", () => s.agent.send(permission(3, "S1", ALLOW_REJECT, { kiro: { consent: { capability: "fs.write", resource: "/a" } } })));
    await s.step("answer", () => s.track("respond", () => s.client.respondToPermission(3, "always")));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S06b-v2-permission", s.rec);
});

test("S07 cancellation, late chunks and queued prompts", async (t) => {
    const s = scenario(t);
    let cancels = 0;
    s.agent.on("session/cancel", () => ++cancels === 1 ? [permission(20, "S1", ALLOW_REJECT)] : []);
    await s.open();
    await s.step("prompt", () => s.prompt("p1", "S1", "first"));
    await s.step("first chunk and a permission", () => s.agent.send(chunk("S1", "a"), permission(19, "S1", ALLOW_REJECT)));
    await s.step("cancel", () => s.track("cancel", () => s.client.cancel("S1")));
    await s.step("cancel again", () => s.track("cancel2", () => s.client.cancel("S1")));
    await s.step("result, then a late chunk", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "cancelled" }), chunk("S1", "stale")]));
    await s.step("next prompt drains the stale chunk", () => s.prompt("p2", "S1", "second"));
    await s.step("a third prompt queues behind it", () => s.prompt("p3", "S1", "third"));
    const abort = new AbortController();
    await s.step("a fourth prompt queues and is aborted", () => s.prompt("p4", "S1", "fourth", abort.signal));
    await s.step("abort", () => abort.abort());
    await s.step("p2 result with a chunk in the same read", () => s.agent.answer("session/prompt", (msg) => {
        s.agent.burst(chunk("S1", "p2 says"), rpc(msg, { stopReason: "end_turn" }), chunk("S1", "after-result"));
        return [];
    }));
    await s.step("p3 result", () => s.agent.answer("session/prompt", (msg) => [chunk("S1", "p3 says"), rpc(msg, { stopReason: "end_turn" })]));
    const aborted = new AbortController();
    aborted.abort();
    await s.step("an already-aborted prompt", () => s.prompt("p5", "S1", "never", aborted.signal));
    await s.step("cancel with nothing running", () => s.track("cancelIdle", () => s.client.cancel("S1")));
    await s.step("cancel an unknown session", () => s.track("cancelUnknown", () => s.client.cancel("nope")));
    await s.step("cancel that spares a wake with no prompt out", () => s.track("cancelSpare", () => s.client.cancel("S1", { spareOvertakenWake: true })));
    await s.step("state", () => s.state("S1"));
    assertGolden("S07-cancel-drain", s.rec);
});

test("S08 cancel deadline quarantines the native session (Crew launch)", async (t) => {
    const launch: AcpLaunch = { bin: "/fake/crew-acp", args: (model) => ["crew-acp", ...(model ? ["--model", model] : [])], cancelTimeoutMs: 25 };
    const s = scenario(t, { launch, runtimeId: "crew", model: "crew-model", spawnEnv: () => ({ HOST_MARKER: "host" }) });
    await s.open();
    await s.step("second session", () => s.track("newSession2", () => s.client.newSession([])));
    await s.step("prompt", () => s.prompt("p1", "S1", "work"));
    await s.step("a pending permission", () => s.agent.send(permission(30, "S1", ALLOW_REJECT)));
    await s.step("an RPC of another session", () => {
        s.agent.on("session/set_mode", () => "hold");
        s.track("setModeOther", () => s.client.setMode("S2", "planner"));
    });
    await s.step("cancel", () => s.track("cancel", () => s.client.cancel("S1")));
    await s.step("state while cancelling", () => s.state("S1"));
    await s.step("deadline", () => t.mock.timers.tick(25));
    await s.step("state after the deadline", () => { s.state("S1"); s.state("S2"); });
    await s.step("frames of the quarantined session are discarded", () => s.agent.send(
        chunk("S1", "zombie"),
        permission(31, "S1", ALLOW_REJECT),
        note("_kiro.dev/metadata", { sessionId: "S1", contextUsagePercentage: 50 }),
    ));
    await s.step("the late result finds no request", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "cancelled" })]));
    await s.step("calls on the quarantined session", () => {
        s.prompt("p2", "S1", "again");
        s.track("setMode", () => s.client.setMode("S1", "planner"));
        s.track("load", () => s.client.loadSession("S1", "/work"));
        s.track("compact", () => s.client.compact("S1"));
        s.track("inject", () => s.client.injectUpdate("S1", { sessionUpdate: "x" }));
    });
    await s.step("other session answers", () => s.agent.answer("session/set_mode", (msg) => [rpc(msg, {})]));
    await s.step("state", () => s.state("S2"));
    assertGolden("S08-crew-cancel-deadline", s.rec);
});

test("S09 session/load: replay, recovery and native lookup", async (t) => {
    const s = scenario(t);
    s.agent.on("session/load", (msg) => {
        if (msg.params.sessionId === "gone") return [rpcError(msg, -32002, "Session not found")];
        return [
            chunk(msg.params.sessionId, "replayed text"),
            update(msg.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" }, _meta: { kiro: { userMessageId: "u-7" } } }),
            update(msg.params.sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "clear" }] }),
            update(msg.params.sessionId, { sessionUpdate: "config_option_update", configOptions: [{ id: "x", type: "boolean", currentValue: false }] }),
            rpc(msg, { modes: { currentModeId: "default", availableModes: [] } }),
        ];
    });
    await s.step("start", () => s.client.start());
    await s.step("initialize", () => s.track("initialize", () => s.client.initialize(), true));
    await s.step("load", () => s.track("load", () => s.client.loadSession("L1", "/elsewhere", [], undefined, { metadata: { chatId: "c" } })));
    await s.step("state", () => { s.state("L1"); s.rec.add("lastUserMessageId", s.client.getLastUserMessageId("L1")); });
    await s.step("a replay frame after load is not shown", () => s.prompt("p1", "L1", "next"));
    await s.step("tagged replay", () => s.agent.send(
        update("L1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tagged replay" }, _meta: { kiro: { replay: true, userMessageId: "u-8" } } }),
        chunk("L1", "live"),
    ));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("load again keeps the queue", () => s.track("load2", () => s.client.loadSession("L1", "/elsewhere", [], 5_000)));
    await s.step("failed load removes only the queue it allocated", () => s.track("loadGone", () => s.client.loadSession("gone", "/work")));
    await s.step("state", () => { s.state("gone"); s.state("L1"); });
    await s.step("destroy", () => s.client.destroySession("L1"));
    await s.step("state after destroy", () => { s.state("L1"); s.rec.add("lastUserMessageId", s.client.getLastUserMessageId("L1")); });
    assertGolden("S09-v2-load", s.rec);
});

test("S09b v3 session/load checks the native session list first", async (t) => {
    const s = scenario(t, { engine: "v3" });
    s.agent.on("session/list", (msg) => {
        if (msg.params.cursor === undefined) return [rpc(msg, { sessions: [{ sessionId: "other", cwd: "/work" }], nextCursor: "page2" })];
        return [rpc(msg, { sessions: [{ sessionId: "L3", cwd: "/work", _meta: { kiro: { source: "local" } } }], nextCursor: null })];
    });
    s.agent.on("session/load", (msg) => [rpc(msg, { configOptions: V3_CONFIG })]);
    await s.step("start", () => s.client.start());
    await s.step("load before initialize", () => s.track("loadEarly", () => s.client.loadSession("L3", "/work")));
    await s.step("initialize", () => s.track("initialize", () => s.client.initialize(), true));
    await s.step("load", () => s.track("load", () => s.client.loadSession("L3", "/work", [], 4_000, { modelId: "m2", workflowsEnabled: true, metadata: { chatId: "c" } })));
    await s.step("state", () => s.state("L3"));
    await s.step("missing session", () => s.track("loadMissing", () => s.client.loadSession("L4", "/work")));
    await s.step("state", () => s.state("L4"));
    await s.step("incomplete catalog", () => {
        s.agent.on("session/list", (msg) => [rpc(msg, { nextCursor: null })]);
        s.track("loadIncomplete", () => s.client.loadSession("L5", "/work"));
    });
    assertGolden("S09b-v3-load", s.rec);
});

test("S10 v3 workflows: notifications, step sessions and controls", async (t) => {
    const s = scenario(t, { engine: "v3" });
    const steps = new Set(["W1"]);
    let openRuns = false;
    let failEvents = false;
    const router: AcpWorkflowRouter = {
        onEvent: (method, params) => {
            s.rec.add("workflow", ["event", method, params]);
            if (failEvents) throw new Error("router down");
        },
        isStepSession: (sessionId) => steps.has(sessionId),
        hasOpenRuns: () => openRuns,
        requestPermission: (req) => {
            s.rec.add("workflow", ["permission", req]);
            return req.sessionId === "W1";
        },
    };
    s.agent.on("_kiro/workflow/pause", (msg) => [rpc(msg, {})]);
    await s.open();
    await s.step("router", () => s.client.setWorkflowRouter(router));
    await s.step("workflow notifications", () => s.agent.send(
        note("_kiro/workflow/run_started", { workflowId: "wf1", parentSessionId: "S1" }),
        note("_kiro/session/notify", { sessionId: "S1", text: "step done" }),
        request(40, "_kiro/workflow/question", { workflowId: "wf1" }),
    ));
    await s.step("prompt", () => s.prompt("p1", "S1", "run it"));
    await s.step("step session frames", () => s.agent.send(
        chunk("W1", "step chatter"),
        update("W1", { sessionUpdate: "tool_call", toolCallId: "wt1", title: "Read", _meta: { kiro: { workflow: { workflowId: "wf1", stepId: "a" } } } }),
        update("W2", { sessionUpdate: "tool_call", toolCallId: "wt2", title: "Read", _meta: { kiro: { workflow: { workflowId: "wf1", stepId: "b" } } } }),
        update("S1", { sessionUpdate: "tool_call", toolCallId: "own", title: "Read", _meta: { kiro: { workflow: { workflowId: "wf1" } } } }),
        update("W1", { sessionUpdate: "config_option_update", configOptions: [] }),
    ));
    await s.step("step approvals", () => s.agent.send(
        permission(41, "W1", ALLOW_REJECT),
        permission(42, "W9", ALLOW_REJECT),
        request(43, "session/request_permission", { sessionId: "W1", options: "not-a-list" }),
    ));
    await s.step("approve the step", () => s.track("respondStep", () => s.client.respondToPermission(41, "allow")));
    await s.step("launch result", () => s.agent.send(
        update("S1", { sessionUpdate: "tool_call_update", toolCallId: "run", status: "completed", rawOutput: { workflowId: "wf1" } }),
        update("S1", { sessionUpdate: "tool_call_update", toolCallId: "run2", status: "completed", rawOutput: { workflowId: "" } }),
    ));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("open runs keep the process", () => {
        s.state("S1");
        openRuns = true;
        s.state("S1");
        s.rec.add("hasOpenWorkflowRuns", s.client.hasOpenWorkflowRuns());
    });
    await s.step("controls", () => {
        s.rec.add("supports", ["pause", s.client.supportsWorkflowControl("pause")]);
        s.rec.add("supports", ["retry", s.client.supportsWorkflowControl("retry")]);
        s.track("pause", () => s.client.workflowControl("pause", "wf1", "S1"));
        s.track("retry", () => s.client.workflowControl("retry", "wf1", "S1"));
    });
    await s.step("a failing router is logged", () => {
        failEvents = true;
        s.agent.send(note("_kiro/workflow/run_complete", { workflowId: "wf1" }));
    });
    await s.step("no router", () => {
        s.client.setWorkflowRouter(null);
        s.agent.send(note("_kiro/workflow/run_complete", { workflowId: "wf1" }), permission(44, "W1", ALLOW_REJECT));
        s.rec.add("hasOpenWorkflowRuns", s.client.hasOpenWorkflowRuns());
    });
    assertGolden("S10-v3-workflows", s.rec);
});

test("S11 v3 turns Kiro starts on its own", async (t) => {
    const s = scenario(t, { engine: "v3" });
    await s.open();
    await s.step("handler", () => s.client.setAgentTurnHandler((sessionId) => (updates) => s.consume(`turn:${sessionId}`, updates)));
    await s.step("an idle wake", () => s.agent.send(
        info("S1", { kind: "turn_start" }),
        info("S1", { kind: "context_update", contextUsage: { usagePercentage: 40 } }),
        chunk("S1", "workflow finished", { kiro: { agentInitiated: true } }),
        permission(50, "S1", ALLOW_REJECT),
    ));
    await s.step("state during the wake", () => { s.state("S1"); s.rec.add("hasAgentTurn", s.client.hasAgentTurn("S1")); });
    await s.step("inject during the wake", () => s.track("inject", () => s.client.injectUpdate("S1", { sessionUpdate: "tool_call_update", toolCallId: "mcp" })));
    await s.step("answer and end", () => {
        s.client.respondToPermission(50, "allow");
        s.agent.send(
            info("S1", { kind: "turn_completion", promptTurnSummaries: [{ unit: "credit", usage: 1 }] }),
            info("S1", { kind: "turn_end", turnEnd: { stopReason: "end_turn" } }),
        );
    });
    await s.step("state after the wake", () => { s.state("S1"); s.rec.add("hasAgentTurn", s.client.hasAgentTurn("S1")); });
    let release!: () => void;
    await s.step("an announced prompt overtakes a silent wake", () => {
        release = s.client.announcePrompt("S1");
        s.agent.send(info("S1", { kind: "turn_start" }), chunk("S1", "lost wake text"));
    });
    await s.step("the prompt goes out at once", () => s.prompt("p1", "S1", "mine"));
    await s.step("overtaken frames and the prompt's own turn", () => s.agent.send(
        chunk("S1", "still the wake", { kiro: { agentInitiated: true } }),
        info("S1", { kind: "turn_start" }),
        chunk("S1", "prompt reply"),
        info("S1", { kind: "turn_end", stopReason: "end_turn" }),
    ));
    await s.step("a wake after our turn ended", () => s.agent.send(
        info("S1", { kind: "turn_start" }),
        chunk("S1", "untagged, still ours"),
        chunk("S1", "tagged wake", { kiro: { agentInitiated: true } }),
    ));
    await s.step("inject while the prompt runs", () => s.track("inject2", () => s.client.injectUpdate("S1", { sessionUpdate: "session_state", state: {} })));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("wake ends", () => s.agent.send(info("S1", { kind: "turn_end", stopReason: "end_turn" })));
    await s.step("released announcement is a no-op", () => release());
    await s.step("a wake the handler declines is cancelled", () => {
        s.client.setAgentTurnHandler(() => null);
        s.agent.send(info("S1", { kind: "turn_start" }), chunk("S1", "nobody listens"));
    });
    await s.step("its end", () => s.agent.send(info("S1", { kind: "turn_end", stopReason: "cancelled" })));
    await s.step("a wake between the result and its turn", () => {
        s.client.setAgentTurnHandler((sessionId) => (updates) => s.consume(`turn2:${sessionId}`, updates));
        s.prompt("p2", "S1", "two");
    });
    await s.step("our turn ends, then another starts untagged", () => s.agent.send(
        info("S1", { kind: "turn_start" }),
        info("S1", { kind: "turn_end", stopReason: "end_turn" }),
        info("S1", { kind: "turn_start" }),
    ));
    await s.step("the result makes it a wake", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("its frames", () => s.agent.send(chunk("S1", "late wake"), info("S1", { kind: "turn_end", stopReason: "end_turn" })));
    await s.step("a wake that never ends", () => {
        s.client.setAgentTurnHandler((sessionId) => (updates) => s.consume(`turn3:${sessionId}`, updates));
        s.agent.send(info("S1", { kind: "turn_start" }), chunk("S1", "stuck"));
    });
    await s.step("stop it", () => s.track("cancelAgentTurn", () => s.client.cancelAgentTurn("S1")));
    await s.step("cancel deadline", () => t.mock.timers.tick(5_000));
    await s.step("quarantine deadline", () => t.mock.timers.tick(30_000));
    await s.step("state", () => { s.state("S1"); s.rec.add("hasAgentTurn", s.client.hasAgentTurn("S1")); });
    assertGolden("S11-v3-agent-turns", s.rec);
});

test("S12 stdout framing and unsupported agent requests", async (t) => {
    const s = scenario(t);
    await s.open();
    await s.step("prompt", () => s.prompt("p1", "S1", "frames"));
    await s.step("split, blank, malformed and CRLF lines", () => {
        const frame = JSON.stringify(chunk("S1", "split across reads"));
        s.agent.raw(frame.slice(0, 20));
        s.agent.raw(`${frame.slice(20)}\n\n   \nnot json\n`);
        s.agent.raw(`${JSON.stringify(chunk("S1", "crlf"))}\r\n${JSON.stringify(chunk("S1", "second"))}\n${JSON.stringify(chunk("S1", "unterminated"))}`);
    });
    await s.step("terminate the last line", () => s.agent.raw("\n"));
    await s.step("agent requests the client does not serve", () => s.agent.send(
        request(60, "fs/read_text_file", { sessionId: "S1", path: "/etc/hosts" }),
        request("str", "terminal/create", { sessionId: "S1" }),
        { jsonrpc: "2.0", id: null, method: "session/update", params: { sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "null id" } } } },
    ));
    await s.step("responses for unknown requests and stray frames", () => s.agent.send(
        { jsonrpc: "2.0", id: 999, result: {} },
        { jsonrpc: "2.0", id: 998, error: { code: 1, message: "x" } },
        { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "S1" } },
        { jsonrpc: "2.0", method: "mystery/notification", params: { sessionId: "S1" } },
        { jsonrpc: "2.0" },
    ));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S12-framing", s.rec);
});

test("S13 process exit, process error and unconfirmed shutdown", async (t) => {
    const s = scenario(t, { spawnEnv: () => ({ HOST_MARKER: "host" }) });
    const exits: unknown[] = [];
    await s.open();
    await s.step("exit listener", () => s.client.onExit((error) => exits.push(error)));
    await s.step("prompt and a pending RPC", () => {
        s.prompt("p1", "S1", "work");
        s.agent.on("session/set_mode", () => "hold");
        s.track("setMode", () => s.client.setMode("S1", "planner"));
    });
    await s.step("stderr", () => { s.agent.proc.stderr.emit("data", Buffer.from("warning: something\n")); });
    await s.step("exit", () => s.agent.exit(1, null));
    await s.step("after exit", () => {
        s.rec.add("exits", exits);
        s.state("S1");
        s.track("send", () => s.client.setMode("S1", "planner"));
        s.track("inject", () => s.client.injectUpdate("S1", { sessionUpdate: "x" }));
    });
    await s.step("respawn", () => s.client.start());
    await s.step("initialize", () => s.track("initialize", () => s.client.initialize(), true));
    await s.step("process error", () => {
        s.track("pendingOnError", () => s.client.newSession([]));
        s.agent.proc.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    });
    await s.step("after error", () => {
        s.state("S1");
        s.track("sendAfterError", () => s.client.newSession([]));
    });
    await s.step("exit after the error", () => s.agent.exit(null, "SIGSEGV"));
    await s.step("respawn again", () => s.client.start());
    await s.step("stdin gone", () => {
        s.agent.proc.stdin.destroyed = true;
        s.track("sendNoStdin", () => s.client.newSession([]));
        s.track("cancelNoStdin", () => s.client.cancel("S1"));
        s.agent.proc.stdin.destroyed = false;
    });
    await s.step("a process that ignores signals", () => {
        s.agent.exitOn = new Set();
        s.track("shutdown", () => s.client.shutdown());
    });
    await s.step("SIGTERM deadline", () => t.mock.timers.tick(5_000));
    await s.step("SIGKILL deadline", () => t.mock.timers.tick(1_000));
    await s.step("state", () => s.state("S1"));
    await s.step("the process exits at last", () => s.agent.exit(null, "SIGKILL"));
    await s.step("state after exit", () => s.state("S1"));
    assertGolden("S13-exit-error", s.rec);
});

test("S14 RPC idle and recovery deadlines", async (t) => {
    const s = scenario(t, { idle: 1_000 });
    s.agent.on("session/set_mode", () => "hold");
    s.agent.on("_kiro.dev/commands/execute", () => "hold");
    s.agent.on("session/load", () => "hold");
    s.agent.on("initialize", () => "hold");
    await s.step("start", () => s.client.start());
    await s.step("initialize with a deadline", () => s.track("initialize", () => s.client.initialize(800), true));
    await s.step("initialize deadline", () => t.mock.timers.tick(800));
    await s.step("initialize again", () => {
        s.agent.on("initialize", (msg) => [rpc(msg, V2_INIT)]);
        s.track("initialize2", () => s.client.initialize(), true);
    });
    await s.step("session", () => s.track("newSession", () => s.client.newSession([])));
    await s.step("idle RPC", () => s.track("setMode", () => s.client.setMode("S1", "planner")));
    await s.step("600ms", () => t.mock.timers.tick(600));
    await s.step("progress resets it", () => s.agent.send(chunk("S1", "progress")));
    await s.step("600ms more", () => t.mock.timers.tick(600));
    await s.step("400ms more: idle", () => t.mock.timers.tick(400));
    await s.step("recovery deadline", () => s.track("command", () => s.client.executeCommand("S1", "usage", {}, 1_000)));
    await s.step("600ms", () => t.mock.timers.tick(600));
    await s.step("session/update does not extend it", () => s.agent.send(chunk("S1", "progress")));
    await s.step("400ms more: deadline", () => t.mock.timers.tick(400));
    await s.step("recovery deadline and Kiro's extension update", () => s.track("command2", () => s.client.executeCommand("S1", "usage", {}, 1_000)));
    await s.step("600ms", () => t.mock.timers.tick(600));
    await s.step("_kiro.dev/session/update extends it", () => s.agent.send(note("_kiro.dev/session/update", { sessionId: "S1", update: { sessionUpdate: "tool_call_chunk" } })));
    await s.step("600ms more", () => t.mock.timers.tick(600));
    await s.step("_kiro.dev/metadata extends it", () => s.agent.send(note("_kiro.dev/metadata", { sessionId: "S1", contextUsagePercentage: 3 })));
    await s.step("999ms more", () => t.mock.timers.tick(999));
    await s.step("1ms more: deadline", () => t.mock.timers.tick(1));
    await s.step("load replay", () => s.track("load", () => s.client.loadSession("L1", "/work")));
    await s.step("600ms", () => t.mock.timers.tick(600));
    await s.step("a replayed frame does not reset the idle timer", () => s.agent.send(chunk("L1", "replay")));
    await s.step("400ms more: idle", () => t.mock.timers.tick(400));
    await s.step("state", () => s.state("L1"));
    await s.step("a prompt never idles out", () => s.prompt("p1", "S1", "long"));
    await s.step("25s of silence", () => t.mock.timers.tick(25_000));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S14-deadlines", s.rec);
});

test("S14b idle timeout 0 disables RPC deadlines", async (t) => {
    const s = scenario(t, { idle: 0 });
    s.agent.on("session/set_mode", () => "hold");
    await s.open();
    await s.step("idle RPC", () => s.track("setMode", () => s.client.setMode("S1", "planner")));
    await s.step("a day", () => t.mock.timers.tick(86_400_000));
    await s.step("answer", () => s.agent.answer("session/set_mode", (msg) => [rpc(msg, {})]));
    assertGolden("S14b-no-deadline", s.rec);
});

test("S15 injected updates and released sessions", async (t) => {
    const s = scenario(t);
    await s.open();
    await s.step("inject between turns", () => {
        s.track("inject", () => s.client.injectUpdate("S1", { sessionUpdate: "spawn_branches", count: 2 }));
        s.track("injectUnknown", () => s.client.injectUpdate("nope", { sessionUpdate: "spawn_branches" }));
    });
    await s.step("prompt drains it", () => s.prompt("p1", "S1", "x"));
    await s.step("inject during the prompt", () => s.track("inject2", () => s.client.injectUpdate("S1", { sessionUpdate: "spawn_branches", count: 3 })));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("destroy", () => s.client.destroySession("S1"));
    await s.step("after destroy", () => {
        s.state("S1");
        s.prompt("p2", "S1", "y");
        s.track("cancel", () => s.client.cancel("S1"));
        s.track("inject3", () => s.client.injectUpdate("S1", { sessionUpdate: "x" }));
    });
    await s.step("fork an active session", () => {
        s.track("newSession2", () => s.client.newSession([]));
    });
    await s.step("prompt on it", () => s.prompt("p3", "S2", "busy"));
    await s.step("fork refused", () => s.track("fork", () => s.client.forkSession("S2")));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S15-inject-destroy", s.rec);
});

test("S16 v3 steering and its cleanup", async (t) => {
    const s = scenario(t, { engine: "v3" });
    let clearResult: Record<string, unknown> = { cleared: true, messageIds: ["m1", 7] };
    s.agent.on("_session/steer", (msg) => [rpc(msg, msg.params.message === "no" ? { queued: false } : { queued: true, messageId: "m1" })]);
    s.agent.on("_session/steer/clear", (msg) => [rpc(msg, clearResult)]);
    await s.open();
    await s.step("steer with no prompt", () => s.track("steerIdle", () => s.client.steer("S1", "hello")));
    await s.step("prompt", () => s.prompt("p1", "S1", "work"));
    await s.step("steer", () => {
        s.track("steerBlank", () => s.client.steer("S1", "   "));
        s.track("steer", () => s.client.steer("S1", "also do this"));
        s.track("steerDeclined", () => s.client.steer("S1", "no"));
    });
    await s.step("prompt result clears the steer", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    await s.step("state", () => s.state("S1"));
    await s.step("a cancelled prompt's steer is not queued", () => {
        s.prompt("p2", "S1", "again");
        s.agent.on("_session/steer", () => "hold");
    });
    await s.step("steer in flight", () => s.track("steerInFlight", () => s.client.steer("S1", "late")));
    await s.step("cancel", () => s.track("cancel", () => s.client.cancel("S1")));
    await s.step("steer answered", () => s.agent.answer("_session/steer", (msg) => [rpc(msg, { queued: true, messageId: "m2" })]));
    await s.step("prompt result; clear refused", () => {
        clearResult = { cleared: false };
        s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "cancelled" })]);
    });
    await s.step("state after a refused clear", () => s.state("S1"));
    await s.step("clearSteer directly", () => {
        s.agent.on("session/new", (msg) => [rpc(msg, { sessionId: "S2", configOptions: V3_CONFIG })]);
        s.track("newSession2", () => s.client.newSession([]));
    });
    await s.step("clear", () => {
        clearResult = { cleared: true };
        s.track("clearSteer", () => s.client.clearSteer("S2"));
    });
    await s.step("steering unsupported", () => {
        s.agent.on("_session/steer", (msg) => [rpcError(msg, -32601, "Method not found")]);
        s.prompt("p3", "S2", "third");
    });
    await s.step("steer", () => s.track("steerUnsupported", () => s.client.steer("S2", "x")));
    await s.step("steer after -32601", () => s.track("steerAfter", () => s.client.steer("S2", "y")));
    await s.step("prompt result", () => s.agent.answer("session/prompt", (msg) => [rpc(msg, { stopReason: "end_turn" })]));
    assertGolden("S16-v3-steer", s.rec);
});

test("S17 forks: Crew's standard fork and Kiro v3's", async (t) => {
    const crew = scenario(t, { launch: { bin: "/fake/crew-acp", args: () => ["crew-acp"], standardFork: true }, runtimeId: "crew" });
    crew.agent.on("session/fork", (msg) => [rpc(msg, { sessionId: msg.params._meta?.kiro?.messageId === "same" ? msg.params.sessionId : "F1" })]);
    await crew.open();
    await crew.step("fork before capabilities", () => crew.track("forkNoCap", () => crew.client.forkSession("S1")));
    await crew.step("advertise fork", () => {
        crew.agent.on("initialize", (msg) => [rpc(msg, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { fork: {} } } })]);
        crew.track("initialize2", () => crew.client.initialize(), true);
    });
    await crew.step("fork", () => crew.track("fork", () => crew.client.forkSession("S1", { messageId: "msg-1", logIndex: 4 })));
    await crew.step("fork to the same session", () => crew.track("forkSame", () => crew.client.forkSession("S1", { messageId: "same" })));
    await crew.step("state", () => crew.state("S1"));
    assertGolden("S17-crew-fork", crew.rec);
});

test("S17b Kiro v3 fork", async (t) => {
    const s = scenario(t, { engine: "v3" });
    s.agent.on("session/fork", (msg) => [rpc(msg, { sessionId: "F3" })]);
    await s.open();
    await s.step("fork", () => s.track("fork", () => s.client.forkSession("S1", { messageId: "msg-9" })));
    await s.step("fork without a point", () => s.track("fork2", () => s.client.forkSession("S1")));
    await s.step("fork without the capability", () => {
        s.agent.on("initialize", (msg) => [rpc(msg, { protocolVersion: 1, agentCapabilities: {} })]);
        s.track("initialize2", () => s.client.initialize(), true);
    });
    await s.step("refused", () => s.track("fork3", () => s.client.forkSession("S1")));
    assertGolden("S17b-v3-fork", s.rec);
});

test("S18 initialize rejects other protocol versions", async (t) => {
    const s = scenario(t);
    s.agent.on("initialize", (msg) => [rpc(msg, { protocolVersion: 2, agentCapabilities: { loadSession: true } })]);
    await s.step("start", () => s.client.start());
    await s.step("initialize", () => s.track("initialize", () => s.client.initialize(), true));
    await s.step("capabilities", () => s.rec.add("capabilities", s.client.capabilities ?? "<none>"));
    await s.step("no result", () => {
        s.agent.on("initialize", (msg) => [rpc(msg, null)]);
        s.track("initialize2", () => s.client.initialize(), true);
    });
    await s.step("string version", () => {
        s.agent.on("initialize", (msg) => [rpc(msg, { protocolVersion: "1" })]);
        s.track("initialize3", () => s.client.initialize(), true);
    });
    await s.step("error", () => {
        s.agent.on("initialize", (msg) => [rpcError(msg, -32600, "bad request")]);
        s.track("initialize4", () => s.client.initialize(), true);
    });
    await s.step("capabilities", () => s.rec.add("capabilities", s.client.capabilities ?? "<none>"));
    assertGolden("S18-protocol-version", s.rec);
});

test("S19 v3 spawn environment and preload switch", async (t) => {
    let reads = 0;
    const s = scenario(t, { engine: "v3", model: "m1", spawnEnv: () => ({ HOST_MARKER: `read-${++reads}` }), preloadTools: () => reads < 2 });
    await s.step("first spawn", () => s.client.start());
    await s.step("exit", () => s.agent.exit(0, null));
    await s.step("second spawn reads the host again", () => s.client.start());
    assertGolden("S19-v3-spawn-env", s.rec);
});
