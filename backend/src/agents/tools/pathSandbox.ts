/**
 * Path resolution + sandbox enforcement for in-tree tools.
 *
 * Two contracts:
 *   1. `resolveToCwd` produces an absolute path with ~ expansion + leading-@
 *      stripping (the agent sometimes emits "@/foo/bar" because it learned
 *      that pattern from chat mention tokens) and unicode-space normalization.
 *   2. `assertWithinCwd` verifies the resolved path stays inside cwd. ANY tool
 *      that touches the filesystem MUST call this — the existing preamble.ts
 *      already enforces this for @-mentioned context files; the new tool
 *      surface needs the same guarantee.
 *
 * macOS NFD / curly-quote / AM-PM screenshot fallbacks (present in
 * pi-coding-agent's path-utils) are intentionally omitted — rabbitholes is
 * a research workspace, not a screenshot pipeline, so the user-typed path
 * is the path.
 */

import path, { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import fs from "node:fs";
import { getRuntimeDeps } from "../runtimeDeps";

const UNICODE_SPACES = /[  -   　]/g;

/**
 * Normalize an LLM-typed path:
 *   - strip a leading "@" (agent borrowed it from mention tokens)
 *   - replace non-breaking / ideographic / narrow spaces with ASCII spaces
 *   - expand ~ and ~/...
 *
 * Output is still possibly relative — feed it through resolveToCwd.
 */
export function expandPath(filePath: string): string {
    const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;
    const normalized = stripped.replace(UNICODE_SPACES, " ");
    if (normalized === "~") return homedir();
    if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
        return path.join(homedir(), normalized.slice(2));
    }
    return normalized;
}

/**
 * Produce an absolute path from `filePath`, resolving relative paths
 * against `cwd`. Does NOT enforce the sandbox — that's `assertWithinCwd`'s
 * job.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
    const expanded = expandPath(filePath);
    if (isAbsolute(expanded)) return expanded;
    return resolvePath(cwd, expanded);
}

export class PathSandboxError extends Error {
    constructor(
        public readonly attemptedPath: string,
        public readonly cwd: string,
    ) {
        super(`access denied: ${attemptedPath} is outside the workspace`);
        this.name = "PathSandboxError";
    }
}

/**
 * Throw if `absolutePath` is outside `cwd`. Both arguments must already
 * be absolute and normalized (use resolveToCwd first). Path equality
 * with cwd itself is allowed (listing the workspace root is fine).
 *
 * Note: this is a *prefix* check, not a symlink-resolved check. A
 * symlink inside cwd that points outside will pass — that's intentional
 * scope: workspace owners control what they put there. If the tool
 * caller wants a stricter realpath check, layer it on top.
 */
export function assertWithinCwd(absolutePath: string, cwd: string): void {
    if (absolutePath === cwd) return;
    if (absolutePath.startsWith(cwd + sep)) return;
    throw new PathSandboxError(absolutePath, cwd);
}

/**
 * Multi-folder variant of assertWithinCwd. Throws if `absolutePath` is not
 * inside ANY of the provided folder paths. When `folders` is empty, falls
 * back to `cwd` (single-folder legacy behavior).
 */
export function assertPathAllowed(
    absolutePath: string,
    folders: Array<{ path: string }>,
    cwd?: string,
): void {
    // Build effective allowlist: all folder paths, plus cwd as fallback
    const allowlist: string[] = folders.map(f => f.path);
    if (allowlist.length === 0 && cwd) allowlist.push(cwd);
    if (allowlist.length === 0) {
        throw new PathSandboxError(absolutePath, '(no workspace directory)');
    }

    const resolved = path.resolve(absolutePath);
    const allowed = allowlist.some(dir => {
        const resolvedDir = path.resolve(dir);
        return resolved === resolvedDir || resolved.startsWith(resolvedDir + sep);
    });
    if (!allowed) {
        throw new PathSandboxError(absolutePath, allowlist[0]);
    }
}

/**
 * Convenience: resolve and assert in one step. Returns the absolute
 * path on success.
 */
export function resolveWithinCwd(filePath: string, cwd: string): string {
    const abs = resolveToCwd(filePath, cwd);
    assertWithinCwd(abs, cwd);
    return abs;
}

/**
 * Multi-folder convenience: resolve against primary cwd, then assert against
 * all registered folders. Returns the absolute path on success.
 */
export function resolveWithinFolders(
    filePath: string,
    cwd: string,
    folders: Array<{ path: string }>,
): string {
    const abs = resolveToCwd(filePath, cwd);
    assertPathAllowed(abs, folders, cwd);
    return abs;
}

// ── Cloud-mode per-user sandbox helpers ──────────────────────────────────────

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
