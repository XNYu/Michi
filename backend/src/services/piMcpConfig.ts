/**
 * piMcpConfig — reads MCP server definitions for the Pi runtime.
 *
 * Configuration sources (evaluated in order, all additive):
 *
 *   1. `config.json` under `MICHI_CONFIG_DIR` (default `~/.michi`)
 *      → `piMcpServers` array
 *   2. `MICHI_PI_MCP_SERVERS` env var — JSON array or comma-separated
 *      shorthand commands (e.g. "sample-mcp,sample-docs-mcp")
 *
 * Each entry matches the McpServerConfig shape from mcpClientManager.ts.
 * When shorthand (bare command name) is used, the serverName is derived
 * by stripping a trailing "-mcp" suffix: "sample-mcp" → "sample".
 */
import path from "path";
import type { McpServerConfig } from "./mcpClientManager";
import { getMichiConfigPaths } from './configPaths';
import { readJsonConfig } from './jsonConfigStore';

const { configPath: CONFIG_PATH } = getMichiConfigPaths();

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

    // Only a missing file is an empty configuration. Corrupt/unreadable files
    // must reach PiSession's MCP setup warning, rather than starting unconfigured servers.
    const raw = readJsonConfig(CONFIG_PATH) ?? {};
    if (raw.piMcpServers !== undefined && !Array.isArray(raw.piMcpServers)) {
        throw Object.assign(new Error('piMcpServers must be an array'), { code: 'MCP_CONFIG_INVALID' });
    }
    for (const entry of raw.piMcpServers ?? []) {
        const cfg = normalizeEntry(entry);
        if (cfg) byName.set(cfg.serverName, cfg);
    }

    // Source 2: MICHI_PI_MCP_SERVERS env var
    const envVal = process.env.MICHI_PI_MCP_SERVERS?.trim();
    if (envVal) {
        // JSON-looking input must not become an executable shorthand after
        // a syntax failure. Keep the diagnostic free of credential-bearing input.
        if (envVal.startsWith('[') || envVal.startsWith('{')) {
            let parsed: unknown;
            try { parsed = JSON.parse(envVal); } catch {
                throw Object.assign(new Error('MICHI_PI_MCP_SERVERS must contain a valid JSON array or command shorthand'), { code: 'MCP_CONFIG_INVALID' });
            }
            if (!Array.isArray(parsed)) throw Object.assign(new Error('MICHI_PI_MCP_SERVERS JSON must be an array'), { code: 'MCP_CONFIG_INVALID' });
            for (const entry of parsed) {
                const cfg = normalizeEntry(entry);
                if (cfg) byName.set(cfg.serverName, cfg);
            }
        } else {
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
