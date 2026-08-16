import { execFileSync } from "child_process";
import { existsSync, accessSync, constants as fsConstants } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AcpAuthMethod, AcpInitializeResult, AcpProfile } from "../types";
import { mapCursorPermissionOptions } from "./cursor";

function findOnPath(name: string): string | undefined {
    for (const p of (process.env.PATH || "").split(":")) {
        if (!p) continue;
        const cand = join(p, name);
        if (existsSync(cand)) {
            try {
                accessSync(cand, fsConstants.X_OK);
                return cand;
            } catch {}
        }
    }
    return undefined;
}

export function findGrokCli(): string {
    const env = process.env.GROK_CLI_BIN;
    if (env) {
        if (existsSync(env)) return env;
        throw new Error(`GROK_CLI_BIN is set to ${env} but that file does not exist.`);
    }
    const found = findOnPath("grok");
    if (found) return found;
    const local = join(homedir(), ".local", "bin", "grok");
    if (existsSync(local)) {
        try {
            accessSync(local, fsConstants.X_OK);
            return local;
        } catch {}
    }
    throw new Error(
        "Grok CLI binary not found. Install the official xAI Grok CLI (`grok`) or set GROK_CLI_BIN to its path.",
    );
}

/**
 * Official xAI Grok CLI vs community `grok` binaries (log parsers, etc.).
 * Accept output that mentions xAI / x.ai, or that advertises `agent stdio`.
 */
export function isOfficialGrokCli(versionOrHelp: string): boolean {
    const t = versionOrHelp.toLowerCase();
    if (t.includes("logstash") || t.includes("grok pattern") || t.includes("named capture")) {
        return false;
    }
    if (t.includes("xai") || t.includes("x.ai")) return true;
    if (t.includes("agent") && t.includes("stdio")) return true;
    return false;
}

export function grokSpawnArgs(helpText?: string): string[] {
    if (helpText !== undefined && !helpText.includes("--no-auto-update")) {
        return ["agent", "stdio"];
    }
    return ["--no-auto-update", "agent", "stdio"];
}

/**
 * Live probe (2026-08-17, grok 1.0.4 after login): initialize advertises
 * authMethods [cached_token, grok.com]; xai.api_key only if XAI_API_KEY is set.
 * Prefer the login cache. Do not require xai.api_key.
 */
export function selectGrokAuthMethod(
    authMethods: Array<AcpAuthMethod | string> | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const ids = new Set(
        (authMethods ?? []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean),
    );
    if (ids.has("cached_token")) return "cached_token";
    if (env.XAI_API_KEY && (ids.has("xai.api_key") || ids.size === 0)) return "xai.api_key";
    if (ids.has("grok.com")) return "grok.com";
    if (ids.has("xai.api_key") && env.XAI_API_KEY) return "xai.api_key";
    if (ids.size === 0) return "cached_token";
    throw new Error(
        "Grok CLI is not authenticated. Run `grok login` first, or set XAI_API_KEY (the same key Pi's xai provider uses).",
    );
}

function probeGrokText(bin: string, args: string[]): string {
    try {
        return execFileSync(bin, args, {
            encoding: "utf8",
            timeout: 4000,
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (err: any) {
        const stdout = typeof err?.stdout === "string" ? err.stdout : "";
        const stderr = typeof err?.stderr === "string" ? err.stderr : "";
        return `${stdout}\n${stderr}`;
    }
}

export function assertOfficialGrokCli(bin: string): string {
    const version = probeGrokText(bin, ["--version"]);
    const help = probeGrokText(bin, ["--help"]);
    const combined = `${version}\n${help}`;
    if (!isOfficialGrokCli(combined)) {
        throw new Error(
            `The grok binary at ${bin} does not look like the official xAI Grok CLI. Set GROK_CLI_BIN to the official binary (https://docs.x.ai/build/cli).`,
        );
    }
    return help;
}

export interface GrokProfileOptions {
    binaryPath?: string;
    cwd?: string;
    model?: string;
    /** Test hook: skip binary/version/auth preflight. */
    skipPreflight?: boolean;
    /** Test hook: force spawn argv (otherwise preferred `--no-auto-update agent stdio`). */
    spawnArgs?: string[];
}

export class GrokAcpProfile implements AcpProfile {
    readonly runtimeId = "grok";
    readonly logLabel = "grok";
    readonly protocolVersion = 1;
    readonly clientInfo = { name: "michi", version: "1.0.0" };
    readonly mcpAttach = "always" as const;
    readonly clientCapabilities = {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
    };
    readonly spawnArgs: string[];
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    private readonly skipPreflight: boolean;

    constructor(opts: GrokProfileOptions = {}) {
        this.cwd = opts.cwd ?? process.cwd();
        this.model = opts.model;
        this.skipPreflight = !!opts.skipPreflight;
        this.binaryPath = opts.binaryPath ?? (this.skipPreflight ? "grok" : findGrokCli());
        this.spawnArgs = opts.spawnArgs ?? grokSpawnArgs();
    }

    preflight(): void {
        if (this.skipPreflight) return;
        if (!existsSync(this.binaryPath)) {
            throw new Error(
                `Grok CLI binary not found at ${this.binaryPath}. Install the official xAI Grok CLI or set GROK_CLI_BIN.`,
            );
        }
        const help = assertOfficialGrokCli(this.binaryPath);
        // Prefer root `--no-auto-update` when the binary advertises it.
        if (!this.spawnArgs.includes("--no-auto-update") && help.includes("--no-auto-update")) {
            (this as { spawnArgs: string[] }).spawnArgs = grokSpawnArgs(help);
        } else if (this.spawnArgs[0] === "--no-auto-update" && !help.includes("--no-auto-update")) {
            (this as { spawnArgs: string[] }).spawnArgs = grokSpawnArgs(help);
        }
    }

    buildAuthenticate(init: AcpInitializeResult): Record<string, unknown> {
        const methodId = selectGrokAuthMethod(init.authMethods, process.env);
        return { methodId, _meta: { headless: true } };
    }

    mapPermissionOptions(options: unknown[]): unknown[] {
        return mapCursorPermissionOptions(options);
    }
}

export function createGrokProfile(opts: GrokProfileOptions = {}): GrokAcpProfile {
    return new GrokAcpProfile(opts);
}
