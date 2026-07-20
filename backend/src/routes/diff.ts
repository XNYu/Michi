import express, { Request, Response } from "express";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
    deriveSandboxCwd,
    resolveWithinCwd,
    NotFoundError,
} from "../agents/tools/pathSandbox";
import { getWorkspace } from "../services/dbRepository";

const pexec = promisify(execFile);

/**
 * GET /workspaces/:workspaceId/diff?path=<relative-path>
 *   (mounted under /api → /api/workspaces/:id/diff)
 *
 * Read side of the turn-diff receipt: the frontend derives "N files changed"
 * from a turn's write/edit tool calls, and clicking a file fetches the
 * unified diff for that path from the workspace's git repo.
 *
 * Diff resolution order (first non-empty wins):
 *   1. `git diff HEAD -- <path>`        — uncommitted (staged + unstaged)
 *   2. untracked file                    — synthesized new-file diff
 *   3. `git diff HEAD~1 HEAD -- <path>` — the last commit's change (agent
 *      turns that commit their work land here)
 *
 * Security:
 *   - workspaceId must match /^[a-zA-Z0-9_-]{1,64}$/ (else 404)
 *   - `path` resolves INSIDE the workspace cwd via resolveWithinCwd
 *     (`..` traversal → 404); hostile prefixes (~ @ absolute) rejected first
 *   - git is invoked via execFile (no shell), cwd pinned to the workspace
 *   - output capped at 100KB (truncated flag set when clipped)
 *
 * Responses: 200 { diff, truncated? } · 404 (unknown ws / path escape /
 * not a git repo / no diff for the file) · 400 (missing path param).
 */

const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_DIFF_BYTES = 100 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface DiffRouteDeps {
    /** Test seam: resolve workspaceId → absolute workspace cwd. Throws NotFoundError when unknown. */
    resolveCwd?: (req: Request, workspaceId: string) => string;
}

function defaultResolveCwd(req: Request, workspaceId: string): string {
    if (process.env.MICHI_CLOUD === "1") {
        // Ownership-checked per-user sandbox dir (throws NotFoundError → 404).
        return deriveSandboxCwd(req.user!.id, workspaceId);
    }
    const stored = getWorkspace(workspaceId)?.cwd;
    if (typeof stored === "string" && stored.trim() !== "") return stored;
    throw new NotFoundError(workspaceId);
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
    try {
        const { stdout } = await pexec("git", args, {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: MAX_DIFF_BYTES * 4,
        });
        return { stdout, code: 0 };
    } catch (err) {
        const e = err as { code?: number | string; stdout?: string };
        // `git diff --no-index` exits 1 when files differ — that's success
        // with content for our purposes. Any stdout is still usable.
        if (e.code === 1 && typeof e.stdout === "string") {
            return { stdout: e.stdout, code: 1 };
        }
        // maxBuffer exceeded: the diff is huge. The partial stdout execFile
        // captured is exactly what the truncation cap below will clip to.
        if (
            e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
            typeof e.stdout === "string" &&
            e.stdout !== ""
        ) {
            return { stdout: e.stdout, code: 0 };
        }
        return { stdout: "", code: typeof e.code === "number" ? e.code : -1 };
    }
}

export function setupDiffRoutes(deps: DiffRouteDeps = {}): express.Router {
    const router = express.Router();
    const resolveCwd = deps.resolveCwd ?? defaultResolveCwd;

    router.get(
        "/workspaces/:workspaceId/diff",
        async (req: Request, res: Response) => {
            const workspaceId = req.params.workspaceId;
            if (typeof workspaceId !== "string" || !WORKSPACE_ID_RE.test(workspaceId)) {
                return res.status(404).json({ error: "not found" });
            }

            const rel = req.query.path;
            if (typeof rel !== "string" || rel.trim() === "") {
                return res.status(400).json({ error: "path query param required" });
            }
            // Reject hostile prefixes BEFORE resolveWithinCwd runs expandPath
            // (tilde / leading-@ expansion is meant for LLM-typed paths, never
            // untrusted HTTP input).
            if (rel.startsWith("~") || rel.startsWith("@")) {
                return res.status(404).json({ error: "not found" });
            }

            let cwd: string;
            try {
                cwd = resolveCwd(req, workspaceId);
            } catch (err) {
                if (err instanceof NotFoundError) {
                    return res.status(404).json({ error: "not found" });
                }
                return res.status(500).json({ error: "internal error" });
            }

            // Resolve the file inside the workspace; `..` escape → 404.
            let abs: string;
            try {
                abs = resolveWithinCwd(rel, cwd);
            } catch {
                return res.status(404).json({ error: "not found" });
            }
            const relPath = path.relative(cwd, abs);
            if (relPath === "" || relPath.startsWith(":")) {
                return res.status(404).json({ error: "not found" });
            }
            // Neutralize git pathspec magic: a pathspec starting with ':'
            // (e.g. ':/x', ':(top)x') is interpreted relative to the REPO
            // ROOT, which would leak diffs outside the workspace when cwd is
            // a subdirectory of a larger repo. A './' prefix makes git treat
            // the argument as a plain relative path.
            const gitPath = `./${relPath}`;

            // Must be a git repo (a failing rev-parse means no repo → 404).
            const repoCheck = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
            if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== "true") {
                return res.status(404).json({ error: "not a git repository" });
            }

            // 1. Uncommitted changes (staged + unstaged) vs HEAD.
            let diff = (await git(cwd, ["diff", "HEAD", "--", gitPath])).stdout;

            // 2. Untracked file → synthesize a new-file diff.
            if (diff.trim() === "") {
                const untracked = await git(cwd, [
                    "ls-files", "--others", "--exclude-standard", "--", gitPath,
                ]);
                if (untracked.stdout.trim() !== "" && fs.existsSync(abs)) {
                    diff = (
                        await git(cwd, ["diff", "--no-index", "--", "/dev/null", gitPath])
                    ).stdout;
                }
            }

            // 3. Fall back to the last commit's change to this file.
            if (diff.trim() === "") {
                diff = (await git(cwd, ["diff", "HEAD~1", "HEAD", "--", gitPath])).stdout;
            }

            if (diff.trim() === "") {
                return res.status(404).json({ error: "no diff for this file" });
            }

            let truncated = false;
            if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
                diff = Buffer.from(diff, "utf8")
                    .subarray(0, MAX_DIFF_BYTES)
                    .toString("utf8");
                truncated = true;
            }

            return res.json({ diff, truncated });
        },
    );

    return router;
}
