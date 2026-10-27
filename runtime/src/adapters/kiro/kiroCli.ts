import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
    exeName,
    findInDir,
    findOnPath,
    isRunnableFile,
} from "../../core/executableLookup";

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

/** Where findKiroCli looks besides its fixed locations (Michi: KIRO_CLI_BIN, LOCALAPPDATA). */
export interface KiroCliLookup {
    /** An explicit kiro-cli path, used when it exists. */
    kiroCliBin?: string;
    /** Windows: the local application data directory. Default ~/AppData/Local. */
    localAppData?: string;
}

export function findKiroCli(lookup: KiroCliLookup = {}): string {
    const env = lookup.kiroCliBin;
    if (env && existsSync(env)) return env;

    const home = homedir();
    const local = findInDir(join(home, ".local", "bin"), "kiro-cli");
    if (local) return local;

    if (process.platform === "win32") {
        const localAppData = lookup.localAppData || join(home, "AppData", "Local");
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
        const localAppData = lookup.localAppData || join(home, "AppData", "Local");
        const toolsDir = join(localAppData, "Toolbox", "tools", "kiro-cli");
        for (const version of newestVersionDirs(toolsDir)) {
            const cand = findInDir(join(toolsDir, version), "kiro-cli");
            if (cand) return cand;
        }
    }

    const onPath = findOnPath("kiro-cli");
    if (onPath) return onPath;

    // Historical fallback: return the conventional toolbox path even if missing
    // so callers can surface a concrete path in error messages. Callers that
    // need to know whether kiro-cli is actually installed must use
    // probeKiroCli() — this function's return value proves nothing.
    if (process.platform === "win32") {
        const localAppData = lookup.localAppData || join(home, "AppData", "Local");
        return join(localAppData, "Toolbox", "bin", exeName("kiro-cli"));
    }
    return join(home, ".toolbox", "bin", "kiro-cli");
}

/**
 * Is kiro-cli actually present and runnable?
 *
 * findKiroCli() deliberately falls back to a conventional path that need not
 * exist, so its result cannot be used as an install check. This re-tests the
 * resolved path and is the only honest signal Michi has short of spawning the
 * binary. Filesystem-only, so it is safe to call from a status request.
 */
export function probeKiroCli(lookup: KiroCliLookup = {}): { path: string; installed: boolean } {
    const path = findKiroCli(lookup);
    return { path, installed: isRunnableFile(path) };
}
