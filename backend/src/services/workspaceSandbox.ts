/**
 * Cloud-mode per-user workspace sandbox: the per-user sandbox root, the cwd
 * prefix check, and the owned-workspace cwd derivation used by routes and
 * services. These read Michi's data dir and workspace store. The generic path
 * containment helpers stay in agents/tools/pathSandbox.ts.
 */

import path from "node:path";
import fs from "node:fs";
import { getRuntimeDeps } from "../agents/runtimeDeps";
import { PathSandboxError } from "michi-runtime/internal/core/pathSandbox";

/**
 * Returns the per-user sandbox root in cloud mode.
 * e.g. /data/user-cwds/<userId>
 *
 * MICHI_DATA_DIR defaults to ~/.michi on desktop (where this function is
 * never called in practice because all callers gate on MICHI_CLOUD=1).
 */
export function getUserSandboxRoot(userId: string): string {
    return path.join(getRuntimeDeps().dataDir, "user-cwds", userId);
}

/**
 * Throw (PathSandboxError) if `cwd` is not inside the per-user sandbox root.
 * Call only when `process.env.MICHI_CLOUD === '1'`.
 *
 * The sandbox dir does not need to exist on disk — this is a prefix check,
 * not a stat. Creating the directory is P1.10's responsibility.
 */
export function assertCwdAllowed(cwd: string, userId: string): void {
    const root = getUserSandboxRoot(userId);
    const abs = path.resolve(cwd);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new PathSandboxError(abs, root);
    }
}

/**
 * Typed error thrown when workspaceId is not found or not owned by userId.
 * Callers should catch and return HTTP 404.
 */
export class NotFoundError extends Error {
    constructor(public readonly workspaceId: string) {
        super(`workspace not found: ${workspaceId}`);
        this.name = "NotFoundError";
    }
}

/**
 * Derive a trusted, user-owned cwd from a workspaceId in cloud mode.
 *
 * - Verifies workspace exists and is owned by `userId` (via getWorkspace with userId).
 * - Returns `<getUserSandboxRoot(userId)>/ws-<workspaceId>`, creating the directory.
 * - Throws NotFoundError on ownership mismatch or missing workspace.
 *
 * Only call in cloud mode (MICHI_CLOUD === '1'). Desktop callers continue to
 * trust the client-supplied cwd.
 */
export function deriveSandboxCwd(userId: string, workspaceId: string): string {
    const row = getRuntimeDeps().historyStore.getWorkspace(workspaceId, userId);
    if (!row || row.owner_user_id !== userId) {
        throw new NotFoundError(workspaceId);
    }
    const dir = path.join(getUserSandboxRoot(userId), `ws-${workspaceId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
