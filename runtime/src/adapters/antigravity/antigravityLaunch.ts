import type { AcpLaunch } from '../kiro/acpClient';
import type { RuntimeAvailability } from '../../contract/types';
import { findOnPath, isRunnableFile } from '../../core/executableLookup';

/**
 * Where the Antigravity CLI is. Michi's factory reads them from its
 * environment each time it resolves the binary or checks availability.
 */
export interface AntigravityAdapterOptions {
    /**
     * The agy executable (Michi: MICHI_ANTIGRAVITY_BIN). When set it wins
     * outright; a bad value is reported rather than skipped.
     */
    binPath?: string;
    /** PATH-style directory list searched for `agy` when binPath is unset. */
    searchPath?: string;
    /** Arguments after `agy acp`. */
    extraArgs?: string[];
}

export interface AntigravityLaunchResolution {
    launch: AcpLaunch | null;
    /** Why no launch resolved; set only when `launch` is null. */
    detail?: string;
}

const NOT_FOUND = 'Antigravity CLI (agy) not found. Install it and sign in, or set MICHI_ANTIGRAVITY_BIN.';

/**
 * Resolve how to start `agy acp`: `binPath` (MICHI_ANTIGRAVITY_BIN) when set,
 * else the first `agy` in `searchPath`. The process inherits Michi's
 * environment unchanged; agy keeps its own sign-in.
 */
export function resolveAntigravityLaunchDetailed(options: AntigravityAdapterOptions): AntigravityLaunchResolution {
    const extraArgs = options.extraArgs ?? [];
    const args = () => ['acp', ...extraArgs];
    const binPath = options.binPath?.trim();
    if (binPath) {
        if (!isRunnableFile(binPath)) return { launch: null, detail: `MICHI_ANTIGRAVITY_BIN=${binPath} is not an executable file` };
        return { launch: { standardAcp: true, bin: binPath, args } };
    }
    const found = options.searchPath ? findOnPath('agy', { env: { PATH: options.searchPath } }) : null;
    if (found) return { launch: { standardAcp: true, bin: found, args } };
    return { launch: null, detail: NOT_FOUND };
}

export function resolveAntigravityLaunch(options: AntigravityAdapterOptions): AcpLaunch | null {
    return resolveAntigravityLaunchDetailed(options).launch;
}

/**
 * Synchronous, offline check that the agy binary resolves. Whether it is
 * signed in shows only when a session opens (agy answers initialize either way).
 */
export function antigravityAvailability(options: AntigravityAdapterOptions): RuntimeAvailability {
    const resolved = resolveAntigravityLaunchDetailed(options);
    return resolved.launch ? { available: true } : { available: false, detail: resolved.detail };
}
