import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
    exeName,
    findInDir,
    findOnPath,
    isRunnableFile,
} from "../../../agents/executableLookup";
import { log } from "../../logger";
import type {
    AcpHandlerContext,
    AcpIncomingNotification,
    AcpProfile,
    AcpUpdate,
} from "../types";

function newestVersionDirs(toolsDir: string): string[] {
    try {
        return readdirSync(toolsDir)
            .map((name) => ({
                name,
                parts: name.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : 0)),
            }))
            .sort((a, b) => {
                for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
                    const av = a.parts[i] ?? 0;
                    const bv = b.parts[i] ?? 0;
                    if (av !== bv) return bv - av;
                }
                return 0;
            })
            .map((v) => v.name);
    } catch {
        return [];
    }
}

export function findKiroCli(): string {
    const env = process.env.KIRO_CLI_BIN;
    if (env && existsSync(env)) return env;

    const home = homedir();
    const local = findInDir(join(home, ".local", "bin"), "kiro-cli");
    if (local) return local;

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
        const toolboxBin = findInDir(join(localAppData, "Toolbox", "bin"), "kiro-cli");
        if (toolboxBin) return toolboxBin;
        const kiroCliDir = findInDir(join(localAppData, "Kiro-Cli"), "kiro-cli");
        if (kiroCliDir) return kiroCliDir;
    }

    if (process.platform === "darwin") {
        const toolsDir = join(home, ".toolbox", "tools", "kiro-cli");
        for (const version of newestVersionDirs(toolsDir)) {
            const cand = join(toolsDir, version, "Kiro CLI.app", "Contents", "MacOS", "kiro-cli");
            if (isRunnableFile(cand)) return cand;
        }
    }

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
        const toolsDir = join(localAppData, "Toolbox", "tools", "kiro-cli");
        for (const version of newestVersionDirs(toolsDir)) {
            const cand = findInDir(join(toolsDir, version), "kiro-cli");
            if (cand) return cand;
        }
    }

    const onPath = findOnPath("kiro-cli");
    if (onPath) return onPath;

    // Historical fallback: return the conventional toolbox path even if missing
    // so callers can surface a concrete path in error messages.
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
        return join(localAppData, "Toolbox", "bin", exeName("kiro-cli"));
    }
    return join(home, ".toolbox", "bin", "kiro-cli");
}

function rpcErrorDataForLog(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    let serialized: string;
    try {
        serialized = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        serialized = String(value);
    }
    if (serialized.length <= 4 * 1024) return serialized;
    return `${serialized.slice(0, 4 * 1024)}…[truncated]`;
}

/**
 * Kiro ACP personality. Spawn/auth/protocol must stay bit-identical to the
 * pre-extraction client: `kiro-cli acp -a`, protocolVersion "2025-01-01",
 * no authenticate step, `_kiro.dev/*` extensions.
 */
export class KiroAcpProfile implements AcpProfile {
    readonly runtimeId = "kiro";
    readonly logLabel = "kiro";
    readonly protocolVersion = "2025-01-01";
    readonly clientInfo = { name: "michi", version: "1.0.0" };
    readonly clientCapabilities = {};
    readonly mcpAttach = "always" as const;
    readonly spawnArgs: string[];

    private subagentOwnerSession: string | null = null;
    private subagentOwnerToolCallId: string | null = null;
    private subagentParentMap = new Map<string, string>();

    constructor(
        readonly binaryPath: string,
        readonly cwd: string,
        readonly model?: string,
    ) {
        const args = ["acp", "-a"];
        if (model) args.push("--model", model);
        this.spawnArgs = args;
    }

    onSessionUpdate(sessionId: string, update: AcpUpdate, ctx: AcpHandlerContext): void {
        const updateKind = update?.sessionUpdate;
        if (updateKind === "tool_call") {
            const title = String(update?.title ?? "").trim().toLowerCase();
            if (
                title === "agent" ||
                title === "task" ||
                title.includes("subagent") ||
                title.includes("agent crew") ||
                title.includes("spawn")
            ) {
                this.subagentOwnerSession = sessionId;
                this.subagentOwnerToolCallId = update?.toolCallId ?? null;
            }
        }
        if (updateKind === "tool_call_update" && sessionId === this.subagentOwnerSession) {
            const status = update?.status;
            const toolCallId = update?.toolCallId;
            if (
                toolCallId === this.subagentOwnerToolCallId &&
                (status === "completed" || status === "error")
            ) {
                this.subagentOwnerSession = null;
                this.subagentOwnerToolCallId = null;
                this.subagentParentMap.clear();
            }
        }
        if (updateKind === "tool_call" || updateKind === "tool_call_update") {
            const parentSid = this.subagentParentMap.get(sessionId);
            if (parentSid) {
                ctx.pushUpdate(parentSid, {
                    sessionUpdate: "subagent_tool_activity",
                    subagentSessionId: sessionId,
                    toolCallId: update.toolCallId ?? "",
                    title: update.title ?? "",
                    status: update.status ?? "",
                    kind: update.kind ?? "",
                });
            }
        }
    }

    handleNotification(msg: AcpIncomingNotification, ctx: AcpHandlerContext): boolean {
        if (msg?.method === "_kiro.dev/session/update") {
            const sid: string | undefined = msg.params?.sessionId;
            if (sid) ctx.resetIdleTimers(sid);
            if (sid) ctx.pushUpdate(sid, msg.params);
            return true;
        }

        if (msg?.method === "_kiro.dev/subagent/list_update") {
            const params = msg.params ?? {};
            const targetSid = this.subagentOwnerSession;
            if (targetSid) {
                const subagents = params.subagents ?? [];
                for (const sa of subagents) {
                    if (sa.sessionId) this.subagentParentMap.set(sa.sessionId, targetSid);
                }
                ctx.pushUpdate(targetSid, {
                    sessionUpdate: "subagent_list_update",
                    subagents,
                });
            }
            if ((params.subagents ?? []).length === 0) {
                this.subagentOwnerSession = null;
                this.subagentParentMap.clear();
            }
            return true;
        }

        if (msg?.method === "_kiro.dev/mcp/server_init_failure") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            log.error("mcp", "kiro mcp server initialization failed", {
                pid: ctx.pid,
                cwd: ctx.cwd,
                model: ctx.model,
                sessionId: sid,
                serverName: params.serverName ?? "",
                error: rpcErrorDataForLog(params.error),
            });
            if (sid) {
                ctx.pushUpdate(sid, {
                    sessionUpdate: "mcp_server_error",
                    serverName: params.serverName ?? "",
                    error: params.error ?? "",
                });
            }
            return true;
        }

        if (msg?.method === "_kiro.dev/session/inbox_notification") {
            const params = msg.params ?? {};
            const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) {
                console.log(`[acp] inbox notification for session ${sid}: ${params.messageCount ?? 0} message(s) from ${(params.senders ?? []).join(", ")}`);
            }
            return true;
        }

        if (msg?.method === "_kiro.dev/metadata") {
            const params = msg.params ?? {};
            const sid: string | undefined = typeof params.sessionId === "string" ? params.sessionId : undefined;
            if (sid) ctx.resetIdleTimers(sid);
            if (sid && params.meteringUsage) {
                ctx.setLastMetadata(sid, params);
            } else if (sid) {
                ctx.setLastMetadata(sid, params);
                if (ctx.isSessionInFlight(sid)) {
                    ctx.pushUpdate(sid, {
                        sessionUpdate: "context_usage",
                        contextUsagePercentage: params.contextUsagePercentage,
                    });
                }
            }
            return true;
        }

        // _kiro.dev/mcp/server_initialized — skipped, noisy
        // _kiro.dev/commands/available — skipped, future command palette feature
        if (typeof msg?.method === "string" && msg.method.startsWith("_kiro.dev/")) {
            return true;
        }
        return false;
    }
}

export function createKiroProfile(opts: {
    binaryPath?: string;
    cwd?: string;
    model?: string;
} = {}): KiroAcpProfile {
    return new KiroAcpProfile(
        opts.binaryPath ?? findKiroCli(),
        opts.cwd ?? process.cwd(),
        opts.model,
    );
}
