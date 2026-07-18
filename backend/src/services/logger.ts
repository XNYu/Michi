import fs from "fs";
import os from "os";
import path from "path";

/**
 * Lifecycle logger for the backend. Writes structured single-line records
 * to `<logdir>/backend.log` and mirrors them to stdout/stderr so dev still
 * sees output. The log dir defaults to `~/.michi/logs/` and can be
 * overridden via `MICHI_LOG_DIR` (Electron main passes this in).
 *
 * A separate `kiro-cli.log` is provided for ACP child-process stderr —
 * the AcpClient pipes raw bytes there with `acpStderr()` so user-facing
 * "michi didn't start" reports always include kiro-cli's last words.
 *
 * Format (tab-separated, easy to grep / paste into a bug report):
 *   2026-05-12T14:32:01.234Z INFO  acp        kiro-cli resolved path=… source=…
 *
 * Rotation: when a file exceeds MAX_BYTES it is renamed to <file>.1
 * (overwriting any prior .1) and a fresh file is started. Single rotation
 * is enough — we just don't want one runaway session to fill the disk.
 */

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";
type Stage =
    | "boot"
    | "http"
    | "acp"
    | "chat"
    | "workspace"
    | "mcp"
    | "bridge"
    | "auth"
    | "tree";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB per file before rotation

function resolveLogDir(): string {
    const env = process.env.MICHI_LOG_DIR;
    if (env && env.length > 0) return env;
    return path.join(os.homedir(), ".michi", "logs");
}

const LOG_DIR = resolveLogDir();
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
    // Falls back to stdout-only if the directory can't be created.
}

const BACKEND_LOG = path.join(LOG_DIR, "backend.log");
const KIRO_CLI_LOG = path.join(LOG_DIR, "kiro-cli.log");

/** Lazily-opened write streams. Re-opened after rotation. */
let backendStream: fs.WriteStream | null = null;
let kiroCliStream: fs.WriteStream | null = null;

function openStream(file: string): fs.WriteStream {
    return fs.createWriteStream(file, { flags: "a" });
}

function getBackendStream(): fs.WriteStream {
    if (!backendStream) backendStream = openStream(BACKEND_LOG);
    return backendStream;
}

function getKiroCliStream(): fs.WriteStream {
    if (!kiroCliStream) kiroCliStream = openStream(KIRO_CLI_LOG);
    return kiroCliStream;
}

function rotateIfNeeded(file: string, stream: fs.WriteStream | null): fs.WriteStream | null {
    try {
        const stat = fs.statSync(file);
        if (stat.size < MAX_BYTES) return stream;
        if (stream) stream.end();
        const rotated = `${file}.1`;
        try { fs.unlinkSync(rotated); } catch { /* not present */ }
        fs.renameSync(file, rotated);
        return null; // signal that stream needs re-open
    } catch {
        // File doesn't exist yet — nothing to rotate.
        return stream;
    }
}

function appendSafe(file: string, line: string): void {
    if (file === BACKEND_LOG) {
        backendStream = rotateIfNeeded(file, backendStream);
        getBackendStream().write(line);
    } else {
        kiroCliStream = rotateIfNeeded(file, kiroCliStream);
        getKiroCliStream().write(line);
    }
}

function formatMeta(meta?: Record<string, unknown>): string {
    if (!meta) return "";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue;
        let s: string;
        if (typeof v === "string") {
            // Avoid line breaks in serialized values.
            s = v.includes(" ") || v.includes("=") ? JSON.stringify(v) : v;
        } else if (v instanceof Error) {
            s = JSON.stringify(`${v.message}`);
        } else {
            try { s = JSON.stringify(v); } catch { s = String(v); }
        }
        parts.push(`${k}=${s}`);
    }
    return parts.length > 0 ? " " + parts.join(" ") : "";
}

/** DEBUG lines always land in backend.log but only reach stdout when
 *  MICHI_LOG_DEBUG=1 — keeps the dev console quiet without losing the
 *  diagnostic trail. */
const DEBUG_TO_STDOUT = process.env.MICHI_LOG_DEBUG === "1";

function emit(level: Level, stage: Stage, msg: string, meta?: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const stagePad = stage.padEnd(10, " ");
    const line = `${ts} ${level.padEnd(5, " ")} ${stagePad} ${msg}${formatMeta(meta)}\n`;
    appendSafe(BACKEND_LOG, line);
    if (level === "ERROR") process.stderr.write(line);
    else if (level !== "DEBUG" || DEBUG_TO_STDOUT) process.stdout.write(line);
}

export const log = {
    debug(stage: Stage, msg: string, meta?: Record<string, unknown>): void {
        emit("DEBUG", stage, msg, meta);
    },
    info(stage: Stage, msg: string, meta?: Record<string, unknown>): void {
        emit("INFO", stage, msg, meta);
    },
    warn(stage: Stage, msg: string, meta?: Record<string, unknown>): void {
        emit("WARN", stage, msg, meta);
    },
    error(stage: Stage, msg: string, meta?: Record<string, unknown>): void {
        emit("ERROR", stage, msg, meta);
    },
    /** Raw passthrough for kiro-cli child stderr/stdout. Does not parse;
     *  records exactly what the child wrote, with a per-write timestamp on
     *  newline boundaries so the file stays grep-friendly. */
    acpStderr(chunk: string): void {
        kiroCliStream = rotateIfNeeded(KIRO_CLI_LOG, kiroCliStream);
        try {
            const ts = new Date().toISOString();
            const tagged = chunk.replace(/(^|\n)(?=.)/g, (_m, p1) => `${p1}${ts} `);
            getKiroCliStream().write(tagged);
        } catch {
            // best effort
        }
    },
    /** Path to the backend log — exposed so the diagnostics endpoint can
     *  point users at it. */
    backendLogPath(): string { return BACKEND_LOG; },
    kiroCliLogPath(): string { return KIRO_CLI_LOG; },
    logDir(): string { return LOG_DIR; },
};
