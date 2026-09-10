/**
 * piMcpConfig — reads MCP server definitions for the Pi runtime.
 *
 * Configuration sources (evaluated in order, all additive):
 *
 *   1. `~/.michi/config.json` → `piMcpServers` array
 *   2. `MICHI_PI_MCP_SERVERS` env var — JSON array or comma-separated
 *      shorthand commands (e.g. "sample-mcp,sample-docs-mcp")
 *
 * Each entry matches the McpServerConfig shape from mcpClientManager.ts.
 * When shorthand (bare command name) is used, the serverName is derived
 * by stripping a trailing "-mcp" suffix: "sample-mcp" → "sample".
 */
import fs from "fs";
import path from "path";
import os from "os";
import type { McpServerConfig } from "./mcpClientManager";

const CONFIG_DIR = path.join(os.homedir(), ".michi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

/**
 * Derive a short server name from a command.
 * "sample-mcp" → "sample", "/usr/bin/sample-docs-mcp" → "sample-docs"
 */
function commandToServerName(command: string): string {
    const base = path.basename(command);
    return base.endsWith("-mcp") ? base.slice(0, -4) : base;
}

function parseShorthand(s: string): McpServerConfig {
    const command = s.trim();
    return { serverName: commandToServerName(command), command };
}

function isValidConfig(entry: unknown): entry is McpServerConfig {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    return typeof e.command === "string" && e.command.length > 0;
}

function normalizeEntry(entry: unknown): McpServerConfig | null {
    if (typeof entry === "string") return parseShorthand(entry);
    if (!isValidConfig(entry)) return null;
    return {
        serverName: typeof entry.serverName === "string" && entry.serverName
            ? entry.serverName
            : commandToServerName(entry.command),
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : undefined,
        env: entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
            ? entry.env as Record<string, string>
            : undefined,
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    };
}

/**
 * Read MCP server configs for Pi. Returns an empty array when nothing is
 * configured — callers should skip MCP initialization entirely in that case.
 *
 * De-duplicates by serverName; later entries (env) override earlier (disk).
 */
export function readPiMcpServers(): McpServerConfig[] {
    const byName = new Map<string, McpServerConfig>();

    // Source 1: config.json → piMcpServers
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        const arr = raw?.piMcpServers;
        if (Array.isArray(arr)) {
            for (const entry of arr) {
                const cfg = normalizeEntry(entry);
                if (cfg) byName.set(cfg.serverName, cfg);
            }
        }
    } catch {
        // Missing or malformed config.json — not an error.
    }

    // Source 2: MICHI_PI_MCP_SERVERS env var
    const envVal = process.env.MICHI_PI_MCP_SERVERS?.trim();
    if (envVal) {
        // Try JSON array first
        try {
            const parsed = JSON.parse(envVal);
            if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                    const cfg = normalizeEntry(entry);
                    if (cfg) byName.set(cfg.serverName, cfg);
                }
            }
        } catch {
            // Fallback: comma-separated command names
            for (const cmd of envVal.split(",")) {
                if (cmd.trim()) {
                    const cfg = parseShorthand(cmd);
                    byName.set(cfg.serverName, cfg);
                }
            }
        }
    }

    return [...byName.values()];
}
