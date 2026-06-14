/**
 * Ad-hoc probe: does kiro-cli's session/load work across agent process restarts?
 *
 * ACP spec says loadSession "enables persistence across restarts" but doesn't
 * pin down whether "restarts" means the client or the agent. If kiro-cli keeps
 * session state only in-memory, load will fail after we kill the process —
 * and that means loadSession is useless for our "persist ACP connection"
 * goal. If it works, we can persist sessionIds to SQLite and skip
 * session/new on every reload.
 *
 * Run with: npx ts-node scripts/probe-acp-load.ts
 * (from the backend/ directory)
 *
 * The script is self-contained — it does NOT import the real AcpClient class,
 * because that class tightly couples to ChatManager conventions (MCP slots,
 * queues, etc) that we don't want polluting the probe. Instead it speaks
 * JSON-RPC over stdio directly.
 */

import { spawn, ChildProcess } from "node:child_process";
import { findKiroCli } from "../src/services/acpClient";

interface Pending {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
}

class MiniAcpClient {
    private proc: ChildProcess | null = null;
    private buffer = "";
    private nextId = 0;
    private pending = new Map<number, Pending>();
    /** Raw session/update notifications, appended in order. */
    public updates: any[] = [];
    public exitCode: number | null = null;

    constructor(
        private readonly bin: string,
        private readonly cwd: string,
    ) {}

    start(): void {
        this.proc = spawn(this.bin, ["acp", "-a"], {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
        });
        this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.proc.stderr!.on("data", (chunk: Buffer) => {
            process.stderr.write(`  [kiro stderr] ${chunk.toString()}`);
        });
        this.proc.on("exit", (code) => {
            this.exitCode = code;
            for (const p of this.pending.values()) {
                p.reject(new Error(`process exited with code ${code}`));
            }
            this.pending.clear();
        });
    }

    pid(): number | undefined {
        return this.proc?.pid;
    }

    private onStdout(chunk: Buffer): void {
        this.buffer += chunk.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            this.dispatch(msg);
        }
    }

    private dispatch(msg: any): void {
        if (msg && msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
            else p.resolve(msg.result);
            return;
        }
        if (msg?.method === "session/update") {
            this.updates.push(msg.params);
        }
        // Ignore kiro-private methods, permission requests, etc for this probe.
    }

    send(method: string, params?: any, timeoutMs = 120_000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.proc?.stdin || this.proc.stdin.destroyed) {
                reject(new Error("process not running"));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
            this.proc.stdin.write(payload + "\n");
        });
    }

    async waitForExit(): Promise<void> {
        if (!this.proc) return;
        if (this.exitCode !== null) return;
        await new Promise<void>((resolve) => {
            this.proc!.once("exit", () => resolve());
        });
    }

    killHard(): void {
        if (!this.proc) return;
        const pid = this.proc.pid;
        if (pid) {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {}
            }
        }
    }
}

function summarizeUpdate(u: any): string {
    const kind = u?.update?.sessionUpdate ?? u?.sessionUpdate ?? "?";
    const inner = u?.update ?? u;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
        const text = inner?.content?.text ?? "";
        const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
        return `${kind}: ${JSON.stringify(preview)}`;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
        return `${kind}: ${inner?.title ?? inner?.toolCallId ?? "?"}`;
    }
    return kind;
}

async function runTurn(client: MiniAcpClient, sessionId: string, text: string): Promise<string> {
    const assistantBuf: string[] = [];
    const startIdx = client.updates.length;
    let done = false;
    const promptPromise = client.send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
    });
    // Poll for new updates while the RPC is still pending.
    const collect = (async () => {
        while (true) {
            await new Promise((r) => setTimeout(r, 50));
            for (let i = startIdx; i < client.updates.length; i++) {
                const u = client.updates[i];
                const update = u?.update ?? u;
                if (update?.sessionUpdate === "agent_message_chunk") {
                    const blocks = Array.isArray(update.content) ? update.content : [update.content];
                    for (const b of blocks) {
                        if (b?.type === "text" && b.text) assistantBuf.push(b.text);
                    }
                }
            }
            // Stop when RPC resolves.
            if (done) break;
        }
    })();
    try {
        await promptPromise;
    } finally {
        done = true;
        await collect;
    }
    return assistantBuf.join("");
}

async function main() {
    const bin = findKiroCli();
    const cwd = process.cwd();
    console.log(`[probe] kiro-cli: ${bin}`);
    console.log(`[probe] cwd: ${cwd}\n`);

    // =====================================================================
    // Phase 1: spawn agent #1, create session, send a prompt, record reply.
    // =====================================================================
    console.log("=== Phase 1: spawn agent #1, create + prompt ===");
    const c1 = new MiniAcpClient(bin, cwd);
    c1.start();
    console.log(`[probe] #1 pid=${c1.pid()}`);

    const initResult1 = await c1.send("initialize", {
        protocolVersion: "2025-01-01",
        clientInfo: { name: "probe", version: "0.0.1" },
        clientCapabilities: {},
    });
    console.log(`[probe] loadSession=${initResult1?.agentCapabilities?.loadSession}`);

    const newResult = await c1.send("session/new", { cwd, mcpServers: [] });
    const sessionId: string = newResult.sessionId;
    console.log(`[probe] sessionId=${sessionId}\n`);

    const marker = "BANANA-7392";
    console.log(`[probe] sending prompt: "remember the word ${marker} and nothing else"`);
    const reply1 = await runTurn(
        c1,
        sessionId,
        `Remember the single word "${marker}". Reply with just "ok" — no other words. We'll test whether you remember this later.`,
    );
    console.log(`[probe] agent reply: ${JSON.stringify(reply1.slice(0, 200))}\n`);

    // =====================================================================
    // Phase 2: kill agent #1 hard.
    // =====================================================================
    console.log("=== Phase 2: kill agent #1 ===");
    c1.killHard();
    await c1.waitForExit();
    console.log(`[probe] agent #1 exited with code ${c1.exitCode}\n`);

    // Small pause so nothing races on the old sessionId.
    await new Promise((r) => setTimeout(r, 500));

    // =====================================================================
    // Phase 3: spawn agent #2, initialize, then session/load with old ID.
    // =====================================================================
    console.log("=== Phase 3: spawn agent #2, try session/load ===");
    const c2 = new MiniAcpClient(bin, cwd);
    c2.start();
    console.log(`[probe] #2 pid=${c2.pid()}`);

    const initResult2 = await c2.send("initialize", {
        protocolVersion: "2025-01-01",
        clientInfo: { name: "probe", version: "0.0.1" },
        clientCapabilities: {},
    });
    console.log(`[probe] #2 loadSession=${initResult2?.agentCapabilities?.loadSession}\n`);

    console.log(`[probe] calling session/load { sessionId: "${sessionId}" }`);
    const loadStart = Date.now();
    try {
        const loadResult = await c2.send(
            "session/load",
            { sessionId, cwd, mcpServers: [] },
            60_000,
        );
        const loadMs = Date.now() - loadStart;
        console.log(`[probe] ✅ session/load SUCCEEDED in ${loadMs}ms`);
        console.log(`[probe] result: ${JSON.stringify(loadResult)}`);
        console.log(`[probe] ${c2.updates.length} updates during load:`);
        for (const u of c2.updates) {
            console.log(`  - ${summarizeUpdate(u)}`);
        }

        // Phase 4: does kiro really remember?
        console.log("\n=== Phase 4: probe recall ===");
        const reply2 = await runTurn(
            c2,
            sessionId,
            `What word did I ask you to remember? Reply with just the word.`,
        );
        console.log(`[probe] recall reply: ${JSON.stringify(reply2.slice(0, 200))}`);
        const remembered = reply2.toUpperCase().includes(marker);
        console.log(`[probe] ${remembered ? "✅ REMEMBERED" : "❌ FORGOT"} — marker "${marker}" ${remembered ? "found" : "NOT found"} in reply\n`);

        console.log("=== VERDICT ===");
        console.log(`session/load across process restart: ${remembered ? "FULLY WORKS" : "API works but state lost"}`);
    } catch (err) {
        const loadMs = Date.now() - loadStart;
        console.log(`[probe] ❌ session/load FAILED in ${loadMs}ms`);
        console.log(`[probe] error: ${(err as Error).message}`);
        console.log("\n=== VERDICT ===");
        console.log("session/load does NOT work across agent process restart.");
        console.log("kiro-cli keeps session state in-memory only.");
    } finally {
        c2.killHard();
        await c2.waitForExit();
    }
}

main().catch((err) => {
    console.error("[probe] fatal:", err);
    process.exit(1);
});
