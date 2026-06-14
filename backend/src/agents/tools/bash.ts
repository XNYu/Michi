/**
 * bash — run a shell command in the workspace.
 *
 * **Important sandbox caveat**: cwd is only the *starting* directory.
 * The command itself can `cd ..` or call any binary the user has
 * installed and read/write anywhere on disk the user can. This is
 * intentional — bash is full execution authority — but the user is
 * asked to approve every call (policy "ask"), and the tool description
 * tells the model so.
 *
 * Output is captured (stdout + stderr interleaved) and trimmed with
 * truncateTail so error tails are preserved when output is large.
 *
 * Default timeout 30s, max 5 min. Exit code is reported separately.
 */

import { spawn } from "node:child_process";
import { resolveWithinCwd, PathSandboxError, getUserSandboxRoot } from "./pathSandbox";
import { truncateTail, formatSize, type TruncationDetails } from "./truncate";
import { errorResult, type ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_BUFFER_CAP = 1 * 1024 * 1024; // 1 MB raw before truncation

export interface BashArgs {
    command: string;
    cwd?: string;
    timeoutMs?: number;
}

export interface BashDetails {
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    truncation?: TruncationDetails;
}

/**
 * Optional execution context forwarded from the owning session.
 * `ownerUserId` is used in cloud mode (MICHI_CLOUD=1) to build an explicit
 * env allowlist that prevents the bash process from reading secrets from
 * process.env (MICHI_ENCRYPTION_KEY, BETTER_AUTH_SECRET, etc.).
 */
export interface BashContext {
    ownerUserId?: string | null;
}

export async function executeBash(
    args: BashArgs,
    sessionCwd: string,
    ctx: BashContext = {},
): Promise<ToolResult<BashDetails>> {
    if (typeof args?.command !== "string" || args.command.trim().length === 0) {
        return errorResult("command is required");
    }

    let runCwd = sessionCwd;
    if (typeof args.cwd === "string" && args.cwd.length > 0) {
        try {
            runCwd = resolveWithinCwd(args.cwd, sessionCwd);
        } catch (e) {
            if (e instanceof PathSandboxError) return errorResult(e.message);
            throw e;
        }
    }

    const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1000, typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS),
    );

    const startedAt = Date.now();

    // In cloud mode, pass an explicit env allowlist so the bash subprocess
    // cannot read secrets from the parent process environment
    // (MICHI_ENCRYPTION_KEY, BETTER_AUTH_SECRET, RAILWAY_API_TOKEN, etc.).
    // Desktop mode (MICHI_CLOUD unset) keeps full process.env as today.
    const spawnEnv =
        process.env.MICHI_CLOUD === "1" && ctx.ownerUserId
            ? {
                  PATH: process.env.PATH ?? "/usr/bin:/bin",
                  HOME: getUserSandboxRoot(ctx.ownerUserId),
                  LANG: process.env.LANG ?? "en_US.UTF-8",
                  NODE_NO_WARNINGS: "1",
              }
            : process.env;

    const child = spawn("bash", ["-c", args.command], { cwd: runCwd, env: spawnEnv });
    let buf = "";
    let bufferTruncated = false;
    const append = (chunk: Buffer) => {
        if (buf.length >= OUTPUT_BUFFER_CAP) {
            bufferTruncated = true;
            return;
        }
        const remaining = OUTPUT_BUFFER_CAP - buf.length;
        const text = chunk.toString("utf-8");
        if (text.length <= remaining) buf += text;
        else {
            buf += text.slice(0, remaining);
            bufferTruncated = true;
        }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
        let resolved = false;
        const timer = setTimeout(() => {
            if (resolved) return;
            try {
                child.kill("SIGTERM");
            } catch {
                /* ignore */
            }
            // Hard-kill after 2s if SIGTERM didn't take.
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* ignore */
                }
            }, 2000);
            resolved = true;
            resolve({ code: null, timedOut: true });
        }, timeoutMs);
        child.on("close", (code) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ code, timedOut: false });
        });
        child.on("error", () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ code: null, timedOut: false });
        });
    });

    const durationMs = Date.now() - startedAt;
    const { content: trimmedOutput, details: truncation } = truncateTail(buf);

    const trailing: string[] = [];
    if (bufferTruncated)
        trailing.push(`[output buffer hit ${formatSize(OUTPUT_BUFFER_CAP)}; raw stream further truncated below]`);
    if (truncation.truncated)
        trailing.push(`[showing tail; ${truncation.totalLines - truncation.outputLines} earlier line(s) omitted]`);

    const status = result.timedOut
        ? `timed out after ${timeoutMs}ms`
        : result.code === 0
        ? "exit 0"
        : `exit ${result.code ?? "?"}`;
    const text =
        `$ ${args.command}\n` +
        `(${status}, ${durationMs}ms)` +
        (trimmedOutput ? `\n\n${trimmedOutput}` : "") +
        (trailing.length > 0 ? `\n\n${trailing.join("\n")}` : "");

    return {
        content: [{ type: "text", text }],
        details: {
            exitCode: result.code,
            timedOut: result.timedOut,
            durationMs,
            truncation: truncation.truncated ? truncation : undefined,
        },
        isError: result.timedOut || (result.code !== null && result.code !== 0),
    };
}
