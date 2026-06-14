import express, { Request, Response } from "express";
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import {
    deriveSandboxCwd,
    resolveWithinCwd,
    NotFoundError,
} from "../agents/tools/pathSandbox";
import { SHOW_IMAGE_MAX_BYTES } from "../agents/claude/showImage";
import { getWorkspace } from "../services/dbRepository";

/**
 * GET /files/:workspaceId/*rest  (mounted under /api → /api/files/...)
 *
 * Streams a workspace image to the browser. This is the read side of the
 * `show_image` tool: Claude calls show_image with a workspace-relative path,
 * the frontend renders <img src="/api/files/<ws>/<relPath>">, and this route
 * serves the bytes — display-only, never back into Claude's context.
 *
 * Security (all mandatory):
 *   - workspaceId must match /^[a-zA-Z0-9_-]{1,64}$/  (else 404)
 *   - the request rel-path is resolved INSIDE the workspace cwd via
 *     resolveWithinCwd (throws PathSandboxError on `..` escape → 404)
 *   - the resolved path is realpath'd and re-asserted inside realpath(root)
 *     to defeat symlink escape (404 otherwise)
 *   - must be a regular file (no directory listing)
 *   - MIME allowlist: png/jpg/jpeg/gif/webp ONLY — SVG is excluded because it
 *     can carry inline <script> (stored-XSS vector); unknown ext → 404
 *   - response is nosniff + inline + private short-cache, streamed
 *
 * Every rejection returns a bare 404 (no body) so the route never leaks
 * whether a path exists, is the wrong type, or escaped the sandbox.
 */

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Desktop workspace-root resolution. This is a faithful copy of the logic in
// routes/uploads.ts (`pickDesktopRoot` + `<root>/<workspaceId>`) so that the
// serve-root is byte-for-byte the same directory uploads land in and that the
// "web-cwd" ClaudeSession runs in on desktop. Kept inline (not extracted) to
// keep this security-sensitive route self-contained and avoid touching the
// already-merged uploads route.
const SHARED_ROOT = "/shared/michi/files";

function desktopUploadRoot(): string {
    try {
        const parent = path.dirname(SHARED_ROOT);
        const s = fs.statSync(parent);
        if (s.isDirectory()) return SHARED_ROOT;
    } catch {
        // /shared not present (typical dev / Docker) — fall through to tmp.
    }
    return path.join(os.tmpdir(), "michi", "files");
}

/**
 * Desktop workspace cwd for `workspaceId`.
 *
 * Resolution order:
 *   1. The persisted `workspaces.cwd` (the canonical session cwd). The frontend
 *      syncs `project.cwd` via POST /workspaces/:id/sync → saveWorkspace, so an
 *      Electron workspace opened against a user-picked folder has its real
 *      absolute cwd here — the SAME dir POST /chats runs the ClaudeSession in.
 *      This is what lets show_image files in a picked folder actually serve.
 *   2. Fallback: the web/local upload root `<uploadRoot>/<workspaceId>` (matches
 *      uploads.ts) for "web-cwd" workspaces that have no stored cwd.
 *
 * No ownership check here: desktop is single-user (owner_user_id is null,
 * MICHI_CLOUD !== '1'). Cloud never reaches this path — it uses
 * deriveSandboxCwd, which both derives the cwd AND verifies ownership.
 */
function pickDesktopRoot(workspaceId: string): string {
    const stored = getWorkspace(workspaceId)?.cwd;
    if (typeof stored === "string" && stored.trim() !== "") {
        return stored;
    }
    const root = desktopUploadRoot();
    const cwd = path.join(root, workspaceId);
    // Defense-in-depth: workspaceId is already regex-validated by the caller,
    // but re-assert the join can't escape the upload root.
    if (cwd !== root && !cwd.startsWith(root + path.sep)) {
        throw new NotFoundError(workspaceId);
    }
    return cwd;
}

export interface FilesRouteDeps {
    /**
     * Test seam + prod resolver. Returns the absolute workspace cwd for
     * `workspaceId`, or throws NotFoundError when the workspace is unknown /
     * not owned by the requester. Defaults to the cloud/desktop resolver.
     */
    resolveRoot?: (req: Request, workspaceId: string) => string;
}

function defaultResolveRoot(req: Request, workspaceId: string): string {
    if (process.env.MICHI_CLOUD === "1") {
        // Verifies ownership and returns the per-user sandbox dir — the SAME
        // cwd deriveSandboxCwd hands to /chats, uploads, and import-file, so
        // serve-root == session-cwd in cloud. Throws NotFoundError → 404.
        return deriveSandboxCwd(req.user!.id, workspaceId);
    }
    return pickDesktopRoot(workspaceId);
}

export function setupFilesRoutes(deps: FilesRouteDeps = {}): express.Router {
    const router = express.Router();
    const resolveRoot = deps.resolveRoot ?? defaultResolveRoot;

    // Express 5 (path-to-regexp 8) requires a NAMED wildcard: a bare "*"
    // throws at registration time. `req.params.rest` is an array of the
    // already-URL-decoded path segments (e.g. ["sub","dir","a.png"]).
    router.get("/files/:workspaceId/*rest", (req: Request, res: Response) => {
        const workspaceId = req.params.workspaceId;
        if (typeof workspaceId !== "string" || !WORKSPACE_ID_RE.test(workspaceId)) {
            return res.status(404).end();
        }

        // path-to-regexp already decoded each segment once; join with "/" to
        // rebuild the rel-path. Do NOT decodeURIComponent again (double-decode
        // would let an attacker smuggle %252e%252e past the sandbox check).
        const rawRest = (req.params as Record<string, unknown>).rest;
        const segments = Array.isArray(rawRest)
            ? (rawRest as string[])
            : typeof rawRest === "string"
              ? [rawRest]
              : [];

        // Reject hostile segments BEFORE they reach resolveWithinCwd, which
        // runs expandPath (tilde + leading-@ expansion designed for LLM-typed
        // paths). We never want untrusted HTTP input interpreted as $HOME or a
        // mention token. An empty segment means a leading/double slash (e.g.
        // //etc/passwd → absolute escape). Today assertWithinCwd would still
        // catch all of these, but the route's safety must NOT silently depend
        // on that helper's semantics — reject up front, keep the
        // resolveWithinCwd + realpath layers below as defense in depth.
        for (const seg of segments) {
            if (seg === "" || seg.startsWith("~") || seg.startsWith("@")) {
                return res.status(404).end();
            }
        }

        const relPath = segments.join("/");
        if (relPath === "") {
            return res.status(404).end();
        }

        // 1. Resolve workspaceId → the workspace cwd (cloud: ownership-checked).
        let root: string;
        try {
            root = resolveRoot(req, workspaceId);
        } catch (err) {
            if (err instanceof NotFoundError) return res.status(404).end();
            return res.status(500).end();
        }

        // 2. Resolve the rel-path inside cwd; `..` escape → PathSandboxError → 404.
        //    ANY resolution failure (sandbox escape or otherwise) returns a
        //    bare 404 — keeping a single uniform reject shape so the route never
        //    leaks which check tripped (a 400 here would be a faint oracle).
        let abs: string;
        try {
            abs = resolveWithinCwd(relPath, root);
        } catch {
            return res.status(404).end();
        }

        // 3. Defeat symlink escape: realpath the target AND the root, then
        //    re-assert the real target is still inside the real root.
        let real: string;
        let realRoot: string;
        try {
            real = fs.realpathSync(abs);
            realRoot = fs.realpathSync(root);
        } catch {
            return res.status(404).end();
        }
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            return res.status(404).end();
        }

        // 4. Regular file only — no directory listing.
        let stat: fs.Stats;
        try {
            stat = fs.statSync(real);
        } catch {
            return res.status(404).end();
        }
        if (!stat.isFile()) return res.status(404).end();

        // 4b. Size cap — bound what we stream (matches show_image's display
        //     limit). Over-cap → bare 404 like every other reject (no oracle).
        if (stat.size > SHOW_IMAGE_MAX_BYTES) return res.status(404).end();

        // 5. MIME allowlist (png/jpg/jpeg/gif/webp; SVG excluded). Unknown → 404.
        const mime = IMAGE_MIME_BY_EXT[path.extname(real).toLowerCase()];
        if (!mime) return res.status(404).end();

        res.setHeader("Content-Type", mime);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "private, max-age=300");

        // TOCTOU note: there is a window between realpathSync(real) above and
        // createReadStream opening the fd here in which `real` could be swapped.
        // Accepted for v1 — the workspace cwd is owner-controlled (per-user in
        // cloud), a personal sandbox, NOT a privilege boundary, so an attacker
        // racing their own files gains nothing they couldn't already serve.
        const stream = fs.createReadStream(real);
        stream.on("error", () => {
            if (!res.headersSent) res.status(404).end();
            else res.destroy();
        });
        // Client disconnected mid-stream — tear down the fs read so the open
        // fd doesn't leak under load.
        res.on("close", () => stream.destroy());
        stream.pipe(res);
    });

    return router;
}
