import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpLaunch } from "../../services/acpClient";
import type { RuntimeAvailability } from "../types";

/** Kiro Crew app the adapter authenticates as. */
export const DEFAULT_CREW_APP = "michi-crew-runtime";

export interface CrewLaunchResolution {
    launch: AcpLaunch | null;
    /** Why no launch resolved; set only when `launch` is null. */
    detail?: string;
}

export interface CrewLaunchLocations {
    env?: NodeJS.ProcessEnv;
    /** Bundled adapter next to the bundled server.js. */
    bundledScript?: string;
    /** Adapter entry in the source tree (dev loop under ts-node). */
    sourceMain?: string;
}

function adapterArgs(model?: string): string[] {
    return ["acp", "--agent-engine", "v2", ...(model ? ["--model", model] : [])];
}

function isExecutableFile(file: string): boolean {
    try {
        if (!fs.statSync(file).isFile()) return false;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function isFile(file: string): boolean {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

function resolveTsNodeRegister(): string | null {
    try { return require.resolve("ts-node/register"); } catch { return null; }
}

/**
 * Resolve how to start the Kiro Crew ACP adapter, in order:
 *   1. `MICHI_CREW_ACP_BIN`: an executable taking the adapter argv. When set it
 *      wins outright; a bad value is reported rather than silently skipped.
 *   2. The bundled `crewAcp.js` next to this module, run by this Node binary.
 *   3. The source `acp/main.ts`, run by this Node binary under ts-node.
 * The adapter inherits Michi's environment unchanged (KIROCREW_HOME and
 * MICHI_CREW_APP included).
 */
export function resolveCrewAcpLaunchDetailed(locations: CrewLaunchLocations = {}): CrewLaunchResolution {
    const env = locations.env ?? process.env;
    const override = env.MICHI_CREW_ACP_BIN?.trim();
    if (override) {
        if (!isExecutableFile(override)) {
            return { launch: null, detail: `MICHI_CREW_ACP_BIN=${override} is not an executable file` };
        }
        return { launch: { bin: override, args: adapterArgs } };
    }
    const bundledScript = locations.bundledScript ?? path.join(__dirname, "crewAcp.js");
    if (isFile(bundledScript)) {
        return { launch: { bin: process.execPath, args: (model) => [bundledScript, ...adapterArgs(model)] } };
    }
    const sourceMain = locations.sourceMain ?? path.join(__dirname, "acp", "main.ts");
    if (isFile(sourceMain)) {
        const register = resolveTsNodeRegister();
        if (register) {
            return {
                launch: {
                    bin: process.execPath,
                    args: (model) => ["--require", register, sourceMain, ...adapterArgs(model)],
                },
            };
        }
    }
    return {
        launch: null,
        detail: `Kiro Crew ACP adapter not found (set MICHI_CREW_ACP_BIN, or build ${bundledScript})`,
    };
}

export function resolveCrewAcpLaunch(locations: CrewLaunchLocations = {}): AcpLaunch | null {
    return resolveCrewAcpLaunchDetailed(locations).launch;
}

export function crewAppName(env: NodeJS.ProcessEnv = process.env): string {
    return env.MICHI_CREW_APP?.trim() || DEFAULT_CREW_APP;
}

/** `<KIROCREW_HOME or ~/.kiro/crew>/apps/<app>/.app_secret`. Path only; never read here. */
export function crewAppSecretPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(crewAppDir(env), ".app_secret");
}

function crewAppDir(env: NodeJS.ProcessEnv): string {
    const home = env.KIROCREW_HOME?.trim() || path.join(os.homedir(), ".kiro", "crew");
    return path.join(home, "apps", crewAppName(env));
}

/** Installed configuration only. The next model call still has to prove the MCP is live. */
export function crewIntegrationStatus(env: NodeJS.ProcessEnv = process.env) {
    try {
        const dir = crewAppDir(env);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
        const installed = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
        let config: { mcp_gateway?: { stub_servers?: string[]; stub_overrides?: Record<string, boolean> } } = {};
        try { config = JSON.parse(fs.readFileSync(path.join(dir, '../..', 'config.json'), 'utf8')); } catch { /* not configured */ }
        const name = `${crewAppName(env)}:michi`;
        const routed = config.mcp_gateway?.stub_overrides?.[name]
            ?? config.mcp_gateway?.stub_servers?.includes(name) ?? false;
        return { enabled: installed.enabled === true,
            approvals: installed.enabled === true && installed.sessionApprovalConsentPending !== true && manifest.permissions?.sessionApproval === true,
            mcpDeclared: installed.enabled === true && !!manifest.mcpServers?.michi,
            mcpRouted: routed, steer: false as const };
    } catch { return { enabled: false, approvals: false, mcpDeclared: false, mcpRouted: false, steer: false as const }; }
}

/**
 * The app's `installed.json` `enabled` flag (never the secret). A disabled
 * app can still exchange its secret, but the Gateway refuses its WS and treats
 * it as off, so Michi must not use it.
 */
function crewAppEnabled(env: NodeJS.ProcessEnv): boolean {
    try {
        const installed = JSON.parse(fs.readFileSync(path.join(crewAppDir(env), "installed.json"), "utf8"));
        return installed?.enabled === true;
    } catch {
        return false;
    }
}

/**
 * Synchronous, offline readiness check: the adapter resolves, the app secret
 * file exists and the app is enabled. Never reads the secret's content.
 */
export function crewAvailability(locations: CrewLaunchLocations = {}): RuntimeAvailability {
    const env = locations.env ?? process.env;
    const resolved = resolveCrewAcpLaunchDetailed(locations);
    if (!resolved.launch) return { available: false, detail: resolved.detail };
    if (!isFile(crewAppSecretPath(env))) {
        return {
            available: false,
            detail: `Install and enable the Kiro Crew app ${crewAppName(env)} (no app secret at ${crewAppSecretPath(env)})`,
        };
    }
    if (!crewAppEnabled(env)) {
        return {
            available: false,
            detail: `Enable the Kiro Crew app ${crewAppName(env)} in the Kiro Crew dashboard (Apps)`,
        };
    }
    return { available: true };
}
