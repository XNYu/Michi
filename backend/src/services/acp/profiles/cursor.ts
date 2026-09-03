import { existsSync, readdirSync, statSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { candidateNames, findInDir, isRunnableFile, pathDirs } from "../../../agents/executableLookup";
import type {
    AcpHandlerContext,
    AcpIncomingNotification,
    AcpIncomingRequest,
    AcpProfile,
    AcpUserAnswer,
} from "../types";

const CURSOR_KIND_BY_OPTION_ID: Record<string, string> = {
    "allow-once": "allow_once",
    "allow-always": "allow_always",
    "reject-once": "reject_once",
    "reject-always": "reject_always",
    allow_once: "allow_once",
    allow_always: "allow_always",
    reject_once: "reject_once",
    reject_always: "reject_always",
};

export function mapCursorPermissionKind(optionId: string, kind?: string): string {
    const fromKind = kind ? CURSOR_KIND_BY_OPTION_ID[kind] ?? kind.replace(/-/g, "_") : undefined;
    if (fromKind === "allow_once" || fromKind === "allow_always" || fromKind === "reject_once" || fromKind === "reject_always") {
        return fromKind;
    }
    const fromId = CURSOR_KIND_BY_OPTION_ID[optionId] ?? optionId.replace(/-/g, "_");
    return fromId || optionId;
}

export function mapCursorPermissionOptions(options: unknown[]): unknown[] {
    return (options ?? []).map((raw) => {
        const opt = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
        const optionId = String(opt.optionId ?? opt.id ?? "");
        return {
            ...opt,
            optionId,
            kind: mapCursorPermissionKind(optionId, typeof opt.kind === "string" ? opt.kind : undefined),
        };
    });
}

function isExecutable(filePath: string): boolean {
    return isRunnableFile(filePath);
}

function realPathOrSelf(filePath: string): string {
    try {
        return realpathSync(filePath);
    } catch {
        return filePath;
    }
}

/** Grok CLI also installs `~/.grok/bin/agent` — never treat that as Cursor. */
export function isGrokAgentBinary(filePath: string): boolean {
    const raw = filePath.replace(/\\/g, "/");
    const real = realPathOrSelf(filePath).replace(/\\/g, "/");
    return (
        raw.includes("/.grok/bin/agent")
        || raw.includes("/.grok/bin/")
        || real.includes("/.grok/")
        || /grok-linux/i.test(real)
    );
}

export function resolvesToCursorAgent(filePath: string): boolean {
    const real = realPathOrSelf(filePath).replace(/\\/g, "/");
    const base = (real.split("/").pop() ?? "").replace(/\.(exe|cmd|bat)$/i, "");
    return base === "cursor-agent" || real.includes("cursor-agent");
}

/**
 * Cursor CLI is `~/.local/bin/agent` (symlink to cursor-agent).
 * Prefer CURSOR_CLI_BIN, then ~/.local/bin/agent, then PATH entries that
 * resolve to cursor-agent. Never pick ~/.grok/bin/agent.
 */
export function findCursorCli(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const override = env.CURSOR_CLI_BIN;
    if (override) {
        if (isGrokAgentBinary(override)) {
            throw new Error(
                `CURSOR_CLI_BIN is set to ${override} but that is the Grok CLI. Do not use ~/.grok/bin/agent.`,
            );
        }
        if (existsSync(override)) return override;
        throw new Error(`CURSOR_CLI_BIN is set to ${override} but that file does not exist.`);
    }
    const local = findInDir(join(home, ".local", "bin"), "agent", { env, home });
    if (local && !isGrokAgentBinary(local)) {
        return local;
    }
    for (const name of ["cursor-agent", "agent"]) {
        for (const dir of pathDirs(env.PATH)) {
            for (const fileName of candidateNames(name)) {
                const cand = join(dir, fileName);
                if (!existsSync(cand) || !isExecutable(cand)) continue;
                if (isGrokAgentBinary(cand)) continue;
                if (name === "cursor-agent" || resolvesToCursorAgent(cand)) return cand;
            }
        }
    }
    throw new Error(
        "Cursor CLI binary not found. Install the Cursor CLI (`agent`) or set CURSOR_CLI_BIN to its path. Do not use ~/.grok/bin/agent (that is the Grok CLI).",
    );
}

function looksLikeAuthFile(filePath: string): boolean {
    try {
        const st = statSync(filePath);
        return st.isFile() && st.size > 0;
    } catch {
        return false;
    }
}

/** Existing `agent login` cache. Never spawn interactive `agent login`. */
export function cursorHasLoginCache(home: string = homedir()): boolean {
    const candidates = [
        join(home, ".cursor", "cli-config.json"),
        join(home, ".cursor", "auth.json"),
        join(home, ".cursor", "cli", "auth.json"),
        join(home, ".config", "cursor", "auth.json"),
        join(home, ".config", "cursor", "cli-config.json"),
        join(home, ".local", "share", "cursor", "auth.json"),
    ];
    if (candidates.some(looksLikeAuthFile)) return true;
    const cursorDir = join(home, ".cursor");
    try {
        for (const name of readdirSync(cursorDir)) {
            const lower = name.toLowerCase();
            if ((lower.includes("auth") || lower.includes("token") || lower.includes("login"))
                && looksLikeAuthFile(join(cursorDir, name))) {
                return true;
            }
        }
    } catch {}
    return false;
}

export function cursorHasAuth(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
    if (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) return true;
    return cursorHasLoginCache(home);
}

export function assertCursorAuth(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): void {
    if (cursorHasAuth(env, home)) return;
    throw new Error(
        "Cursor CLI is not authenticated. Set CURSOR_API_KEY or CURSOR_AUTH_TOKEN, or run `agent login` once in a terminal (Michi will not start an interactive login).",
    );
}

interface CursorQuestion {
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
}

export function mapCursorAskQuestions(questions: CursorQuestion[]): Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
}> {
    return (questions ?? []).map((q) => ({
        question: String(q.prompt ?? q.id ?? ""),
        header: q.id ? String(q.id) : undefined,
        options: (q.options ?? []).map((o) => ({
            label: String(o.label ?? o.id ?? ""),
            description: o.id && o.label && o.id !== o.label ? String(o.id) : undefined,
        })),
        multiSelect: !!q.allowMultiple,
    }));
}

export function cursorAskQuestionResult(
    questions: CursorQuestion[],
    answers: AcpUserAnswer[] | null,
): Record<string, unknown> {
    if (!answers) return { outcome: { outcome: "skipped" } };
    const mapped = (questions ?? []).map((q) => {
        const prompt = String(q.prompt ?? q.id ?? "");
        const user = answers.find((a) => a.question === prompt || a.question === q.id);
        const selected: string[] = [];
        if (user) {
            const labels = user.answer.split(",").map((s) => s.trim()).filter(Boolean);
            for (const opt of q.options ?? []) {
                if (labels.includes(opt.label) || labels.includes(opt.id)) selected.push(opt.id);
            }
            if (selected.length === 0) {
                const opt = (q.options ?? []).find((o) => o.label === user.answer || o.id === user.answer);
                if (opt) selected.push(opt.id);
            }
        }
        return { questionId: q.id, selectedOptionIds: selected };
    });
    return { outcome: { outcome: "answered", answers: mapped } };
}

export interface CursorProfileOptions {
    binaryPath?: string;
    cwd?: string;
    model?: string;
    /** Test hook: skip binary/auth preflight (handshake fixtures). */
    skipPreflight?: boolean;
}

export class CursorAcpProfile implements AcpProfile {
    readonly runtimeId = "cursor";
    readonly logLabel = "cursor";
    readonly protocolVersion = 1;
    readonly clientInfo = { name: "michi", version: "1.0.0" };
    readonly mcpAttach = "always" as const;
    readonly clientCapabilities = {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
    };
    readonly spawnArgs = ["acp"];
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    private readonly skipPreflight: boolean;

    constructor(opts: CursorProfileOptions = {}) {
        this.cwd = opts.cwd ?? process.cwd();
        this.model = opts.model;
        this.skipPreflight = !!opts.skipPreflight;
        this.binaryPath = opts.binaryPath ?? (this.skipPreflight ? "agent" : findCursorCli());
    }

    preflight(): void {
        if (this.skipPreflight) return;
        if (!existsSync(this.binaryPath)) {
            throw new Error(
                `Cursor CLI binary not found at ${this.binaryPath}. Install the Cursor CLI (\`agent\`) or set CURSOR_CLI_BIN.`,
            );
        }
        assertCursorAuth();
    }

    buildAuthenticate(_init?: unknown): Record<string, unknown> {
        return { methodId: "cursor_login" };
    }

    mapPermissionOptions(options: unknown[]): unknown[] {
        return mapCursorPermissionOptions(options);
    }

    handleIncomingRequest(msg: AcpIncomingRequest, ctx: AcpHandlerContext): boolean {
        if (msg.method === "cursor/ask_question") {
            void this.handleAskQuestion(msg, ctx);
            return true;
        }
        if (msg.method === "cursor/create_plan") {
            this.handleCreatePlan(msg, ctx);
            return true;
        }
        return false;
    }

    handleNotification(msg: AcpIncomingNotification, ctx: AcpHandlerContext): boolean {
        if (msg.method === "cursor/update_todos") {
            const sid = ctx.inferSessionId(msg.params);
            const todos = Array.isArray(msg.params?.todos) ? msg.params.todos : [];
            if (sid) {
                ctx.pushUpdate(sid, {
                    sessionUpdate: "plan",
                    entries: todos.map((t: any) => ({
                        content: String(t?.content ?? ""),
                        status: t?.status === "in_progress" || t?.status === "completed" ? t.status : "pending",
                        priority: "medium",
                    })),
                });
            }
            return true;
        }
        if (msg.method === "cursor/task" || msg.method === "cursor/generate_image") {
            return true;
        }
        return false;
    }

    private async handleAskQuestion(msg: AcpIncomingRequest, ctx: AcpHandlerContext): Promise<void> {
        const params = msg.params ?? {};
        const sid = ctx.inferSessionId(params);
        const questions: CursorQuestion[] = Array.isArray(params.questions) ? params.questions : [];
        if (!sid) {
            ctx.reply(msg.id, { outcome: { outcome: "cancelled" } });
            return;
        }
        const requestId = ctx.nextUserInputRequestId();
        ctx.pushUpdate(sid, {
            sessionUpdate: "user_input_request",
            requestId,
            questions: mapCursorAskQuestions(questions),
        });
        try {
            const answers = await ctx.waitForUserInput(requestId, sid);
            ctx.pushUpdate(sid, {
                sessionUpdate: "user_input_resolved",
                requestId,
                answers: answers ?? [],
            });
            ctx.reply(msg.id, cursorAskQuestionResult(questions, answers));
        } catch {
            ctx.reply(msg.id, { outcome: { outcome: "cancelled" } });
        }
    }

    private handleCreatePlan(msg: AcpIncomingRequest, ctx: AcpHandlerContext): void {
        const params = msg.params ?? {};
        const sid = ctx.inferSessionId(params);
        const todos = Array.isArray(params.todos) ? params.todos : [];
        if (sid) {
            ctx.pushUpdate(sid, {
                sessionUpdate: "plan",
                entries: todos.map((t: any) => ({
                    content: String(t?.content ?? ""),
                    status: t?.status === "in_progress" || t?.status === "completed" ? t.status : "pending",
                    priority: "medium",
                })),
            });
        }
        // Auto-accept so the agent does not hang. Plan is already visible in the UI.
        ctx.reply(msg.id, { outcome: { outcome: "accepted" } });
    }
}

export function createCursorProfile(opts: CursorProfileOptions = {}): CursorAcpProfile {
    return new CursorAcpProfile(opts);
}
