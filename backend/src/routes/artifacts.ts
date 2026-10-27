import { createSseObserver } from "../services/httpSse";
import express, { Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { NotFoundError } from "../agents/tools/pathSandbox";
import { resolveWorkspaceFileRoot as resolveRoot, resolveWorkspaceRegularFile, WORKSPACE_FILE_ID_RE } from "../services/workspaceFiles";
import {
  declareArtifactWatchPaths,
  subscribeArtifactWatch,
} from "../services/artifactWatcher";

/**
 * GET /artifacts/:workspaceId/read?path=relative/path.md
 *
 * Returns the text content of a workspace file for the ArtifactPane viewer.
 * Security constraints mirror routes/files.ts (sandbox escape prevention,
 * symlink defeat, size cap) but the MIME allowlist is replaced by a text-only
 * response: the viewer reads UTF-8 text.
 *
 * Max file size: 5MB (generous for markdown/code; rejects giant binaries).
 */

export interface ArtifactRouteDeps {
  resolveRoot?: (req: Request, workspaceId: string) => string;
  subscribe?: typeof subscribeArtifactWatch;
  heartbeatMs?: number;
}

export function setupArtifactRoutes(deps: ArtifactRouteDeps = {}): express.Router {
  const resolveWorkspaceRoot = deps.resolveRoot ?? resolveRoot;
  const subscribe = deps.subscribe ?? subscribeArtifactWatch;
  const router = express.Router();

  router.get("/artifacts/:workspaceId/read", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    if (typeof workspaceId !== "string" || !WORKSPACE_FILE_ID_RE.test(workspaceId)) {
      return res.status(404).end();
    }

    const relPath = req.query.path;
    if (typeof relPath !== "string" || relPath.trim() === "") {
      return res.status(400).json({ error: "Missing ?path= parameter" });
    }

    // 1. Resolve workspace root
    let root: string;
    try {
      root = resolveWorkspaceRoot(req, workspaceId);
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

    // Size gate: files >5MB should be opened externally
    if (stat.size > 5 * 1024 * 1024) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      return res.status(413).json({ error: `File too large (${sizeMB}MB > 5MB) — open externally` });
    }

    // 5. Read as UTF-8 text
    let content: string;
    try {
      content = fs.readFileSync(real, "utf-8");
    } catch {
      return res.status(500).json({ error: "Failed to read file" });
    }

    const ext = path.extname(real).toLowerCase().replace(/^\./, "");
    const basename = path.basename(real);

    res.json({
      content,
      path: relPath,
      basename,
      extension: ext,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    });
  });

  // ── Artifact live-refresh watch channel ─────────────────────────────────────
  //
  // Two endpoints let an open ArtifactPane learn that a file changed on disk
  // (from any source) without polling. They reuse the same workspaceId→cwd
  // resolution (`resolveRoot`) and sandbox as the reader above; the watcher
  // itself lives in services/artifactWatcher.ts.

  /**
   * POST /workspaces/:workspaceId/watch  { paths: string[] }
   * Declare/replace the set of stored paths to watch for this workspace's cwd.
   * Paths escaping the cwd sandbox are silently dropped from `watching`.
   */
  router.post("/workspaces/:workspaceId/watch", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    if (typeof workspaceId !== "string" || !WORKSPACE_FILE_ID_RE.test(workspaceId)) {
      return res.status(404).end();
    }

    const rawPaths = (req.body as { paths?: unknown } | undefined)?.paths;
    if (!Array.isArray(rawPaths)) {
      return res.status(400).json({ error: "Expected { paths: string[] }" });
    }
    const paths = rawPaths.filter((p): p is string => typeof p === "string");

    let root: string;
    try {
      root = resolveWorkspaceRoot(req, workspaceId);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).end();
      return res.status(500).end();
    }

    const { watching } = declareArtifactWatchPaths(root, paths);
    res.json({ watching });
  });

  /**
   * GET /workspaces/:workspaceId/watch/stream
   * Persistent SSE channel. Emits `artifact_changed` / `artifact_removed`
   * frames whose `filePath` byte-matches the pane's stored path so the
   * frontend can string-match against open artifact nodes.
   */
  router.get("/workspaces/:workspaceId/watch/stream", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    if (typeof workspaceId !== "string" || !WORKSPACE_FILE_ID_RE.test(workspaceId)) {
      return res.status(404).end();
    }

    let root: string;
    try {
      root = resolveWorkspaceRoot(req, workspaceId);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).end();
      return res.status(500).end();
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // defeat proxy buffering (nginx)
    res.flushHeaders?.();
    const observer = createSseObserver(res);
    // Prime the stream before subscribing; failure must not retain a watcher.
    if (!observer.write(": connected\n\n")) return;
    observer.addCleanup(subscribe(root, (evt) => {
      const event = evt.removed ? "artifact_removed" : "artifact_changed";
      const data = evt.removed
        ? { filePath: evt.filePath }
        : { filePath: evt.filePath, mtimeMs: evt.mtimeMs, size: evt.size };
      observer.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }));
    observer.heartbeat(": ping\n\n", deps.heartbeatMs ?? 25_000);
    // Only the observer is detached on response close/error; producers continue.
  });

  return router;
}
