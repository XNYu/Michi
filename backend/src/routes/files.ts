import express, { Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { NotFoundError } from "../services/workspaceSandbox";
import { SHOW_IMAGE_MAX_BYTES } from "michi-runtime/internal/core/showImage";
import { resolveWorkspaceFileRoot, resolveWorkspaceRegularFile, WORKSPACE_FILE_ID_RE } from "../services/workspaceFiles";

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
 *     resolveHttpWorkspacePath (rejects `..` escape → 404)
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

export interface FilesRouteDeps {
    /**
     * Test seam + prod resolver. Returns the absolute workspace cwd for
     * `workspaceId`, or throws NotFoundError when the workspace is unknown /
     * not owned by the requester. Defaults to the cloud/desktop resolver.
     */
    resolveRoot?: (req: Request, workspaceId: string) => string;
}

export function setupFilesRoutes(deps: FilesRouteDeps = {}): express.Router {
    const router = express.Router();
    const resolveRoot = deps.resolveRoot ?? resolveWorkspaceFileRoot;

    // Express 5 (path-to-regexp 8) requires a NAMED wildcard: a bare "*"
    // throws at registration time. `req.params.rest` is an array of the
    // already-URL-decoded path segments (e.g. ["sub","dir","a.png"]).
    router.get("/files/:workspaceId/*rest", (req: Request, res: Response) => {
        const workspaceId = req.params.workspaceId;
        if (typeof workspaceId !== "string" || !WORKSPACE_FILE_ID_RE.test(workspaceId)) {
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

        const relPath = segments.join("/");

        // 1. Resolve workspaceId → the workspace cwd (cloud: ownership-checked).
        let root: string;
        try {
            root = resolveRoot(req, workspaceId);
        } catch (err) {
            if (err instanceof NotFoundError) return res.status(404).end();
            return res.status(500).end();
        }

        let real: string;
        let stat: fs.Stats;
        try {
            ({ realPath: real, stat } = resolveWorkspaceRegularFile(relPath, root));
        } catch {
            return res.status(404).end();
        }

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
