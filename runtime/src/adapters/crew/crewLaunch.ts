import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpLaunch } from "../kiro/acpClient";
import type { RuntimeAvailability } from "../../contract/types";
import { CREW_APP_VERSION, crewAppNeedsSync } from './crewAppVersion';

/** Kiro Crew app the adapter authenticates as. */
export const DEFAULT_CREW_APP = "michi-crew-runtime";

export interface CrewLaunchResolution {
    launch: AcpLaunch | null;
    /** Why no launch resolved; set only when `launch` is null. */
    detail?: string;
}

/** The Crew App Michi runs as, and where Kiro Crew keeps it. */
export interface CrewAppLocation {
    /** Kiro Crew home (Michi: KIROCREW_HOME). Default ~/.kiro/crew. */
    kirocrewHome?: string;
    /** The Crew App (Michi: MICHI_CREW_APP). Default michi-crew-runtime. */
    appName?: string;
}

/**
 * Where the Crew adapter and App are. Michi's factory reads them from its
 * environment each time it resolves the adapter or checks availability.
 */
export interface CrewAdapterOptions extends CrewAppLocation {
    /**
     * An executable taking the adapter argv (Michi: MICHI_CREW_ACP_BIN). When
     * set it wins outright; a bad value is reported rather than skipped.
     */
    acpBinOverride?: string;
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
 *   1. `acpBinOverride` (MICHI_CREW_ACP_BIN): an executable taking the adapter
 *      argv. When set it wins outright; a bad value is reported rather than
 *      silently skipped.
 *   2. The bundled `crewAcp.js` next to this module, run by this Node binary.
 *   3. The source `acp/main.ts`, run by this Node binary under ts-node.
 * The adapter inherits Michi's environment unchanged (KIROCREW_HOME and
 * MICHI_CREW_APP included).
 */
export function resolveCrewAcpLaunchDetailed(locations: CrewAdapterOptions): CrewLaunchResolution {
    const override = locations.acpBinOverride?.trim();
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

export function resolveCrewAcpLaunch(locations: CrewAdapterOptions): AcpLaunch | null {
    return resolveCrewAcpLaunchDetailed(locations).launch;
}

export function crewAppName(app: CrewAppLocation): string {
    return app.appName?.trim() || DEFAULT_CREW_APP;
}

/** `<KIROCREW_HOME or ~/.kiro/crew>/apps/<app>/.app_secret`. Path only; never read here. */
export function crewAppSecretPath(app: CrewAppLocation): string {
    return path.join(crewAppDir(app), ".app_secret");
}

function crewAppDir(app: CrewAppLocation): string {
    const home = app.kirocrewHome?.trim() || path.join(os.homedir(), ".kiro", "crew");
    return path.join(home, "apps", crewAppName(app));
}

/** Installed configuration only. The next model call still has to prove the MCP is live. */
export function crewIntegrationStatus(app: CrewAppLocation) {
    try {
        const dir = crewAppDir(app);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
        const installed = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
        let config: { mcp_gateway?: { stub_servers?: string[]; stub_overrides?: Record<string, boolean> } } = {};
        try { config = JSON.parse(fs.readFileSync(path.join(dir, '../..', 'config.json'), 'utf8')); } catch { /* not configured */ }
        const name = `${crewAppName(app)}:michi`;
        const routed = config.mcp_gateway?.stub_overrides?.[name]
            ?? config.mcp_gateway?.stub_servers?.includes(name) ?? false;
        return { enabled: installed.enabled === true,
            installedVersion: typeof manifest.version === 'string' ? manifest.version : null,
            expectedVersion: CREW_APP_VERSION,
            updateRequired: crewAppNeedsSync(manifest.version),
            approvals: installed.enabled === true && installed.sessionApprovalConsentPending !== true && manifest.permissions?.sessionApproval === true,
            mcpDeclared: installed.enabled === true && !!manifest.mcpServers?.michi,
            mcpRouted: routed, steer: false as const };
    } catch { return { enabled: false, approvals: false, mcpDeclared: false, mcpRouted: false, steer: false as const,
        installedVersion: null, expectedVersion: CREW_APP_VERSION, updateRequired: false }; }
}

/**
 * The app's `installed.json` `enabled` flag (never the secret). A disabled
 * app can still exchange its secret, but the Gateway refuses its WS and treats
 * it as off, so Michi must not use it.
 */
function crewAppEnabled(app: CrewAppLocation): boolean {
    try {
        const installed = JSON.parse(fs.readFileSync(path.join(crewAppDir(app), "installed.json"), "utf8"));
        return installed?.enabled === true;
    } catch {
        return false;
    }
}

/**
 * Synchronous, offline readiness check: the adapter resolves, the app secret
 * file exists, the App is enabled, and required MCP/approval configuration is
 * present. Never reads the secret's content or claims the MCP route is live.
 */
export function crewAvailability(locations: CrewAdapterOptions): RuntimeAvailability {
    const resolved = resolveCrewAcpLaunchDetailed(locations);
    if (!resolved.launch) return { available: false, detail: resolved.detail };
    if (!isFile(crewAppSecretPath(locations))) {
        return {
            available: false,
            detail: `Install and enable the Kiro Crew app ${crewAppName(locations)} (no app secret at ${crewAppSecretPath(locations)})`,
        };
    }
    if (!crewAppEnabled(locations)) {
        return {
            available: false,
            detail: `Enable the Kiro Crew app ${crewAppName(locations)} in the Kiro Crew dashboard (Apps)`,
        };
    }
    const integration = crewIntegrationStatus(locations);
    if (integration.updateRequired) {
        return { available: false, detail: `Kiro Crew App update required (${integration.installedVersion ?? 'unknown'} → ${integration.expectedVersion}). Run michi update, then Sync michi-crew-runtime in Crew Apps. Existing custom or temporary sources must be refreshed with the compatibility helper first. Complete any launch approval or Gateway restart requested by Crew.` };
    }
    if (!integration.approvals) {
        return { available: false, detail: `Kiro Crew setup incomplete: install or Sync ${crewAppName(locations)} from your Michi crew-app directory, complete sessionApproval consent in Crew Apps, and confirm Enabled. Approvals must be handled in Michi.` };
    }
    if (!integration.mcpDeclared || !integration.mcpRouted) {
        return { available: false, detail: `Kiro Crew setup incomplete: install or Sync ${crewAppName(locations)} from your Michi crew-app directory, then enable and approve ${crewAppName(locations)}:michi Stub / Routed in Crew Developer > MCP Management and restart the Gateway.` };
    }
    return { available: true };
}
