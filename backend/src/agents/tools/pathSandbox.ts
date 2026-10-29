/**
 * Path sandbox for in-tree tools.
 *
 * The resolver (expandPath, resolveToCwd, normalizeWorkspaceCwd,
 * PathSandboxError, assertWithinCwd, assertPathAllowed, resolveWithinCwd,
 * resolveWithinFolders) lives in michi-runtime
 * (runtime/src/core/pathSandbox.ts), which documents its contracts. It is
 * re-exported here, so tools, routes and adapters share one PathSandboxError
 * class. Cloud-mode per-user sandbox roots read Michi's data dir and workspace
 * store; they live in services/workspaceSandbox.ts.
 */

export {
    expandPath,
    resolveToCwd,
    normalizeWorkspaceCwd,
    PathSandboxError,
    assertWithinCwd,
    assertPathAllowed,
    resolveWithinCwd,
    resolveWithinFolders,
} from "michi-runtime/internal/core/pathSandbox";
