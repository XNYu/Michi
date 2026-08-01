import express, { Request, Response } from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deriveSandboxCwd,
  resolveWithinCwd,
  NotFoundError,
} from "../agents/tools/pathSandbox";
import { getWorkspace } from "../services/dbRepository";
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
 * check: we refuse to stream binary blobs.
 *
 * Max file size: 5MB (generous for markdown/code; rejects giant binaries).
 */

const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SHARED_ROOT = "/shared/michi/files";

/**
 * Desktop workspace cwd — mirrors routes/files.ts resolution order:
 *   1. Persisted workspaces.cwd (user-picked folder)
 *   2. ~/.michi/workspaces/<workspaceId> (Electron "skip folder" creates this)
 *   3. Upload-root fallback: /shared/michi/files/<workspaceId> or $TMPDIR/michi/files/<workspaceId>
 */
function pickDesktopRoot(workspaceId: string): string {
  const stored = getWorkspace(workspaceId)?.cwd;
  if (typeof stored === "string" && stored.trim() !== "") {
    return stored;
  }

  // Check ~/.michi/workspaces/<workspaceId> (skip-folder scratch dir)
  const michiScratch = path.join(os.homedir(), ".michi", "workspaces", workspaceId);
  try {
    if (fs.statSync(michiScratch).isDirectory()) return michiScratch;
  } catch { /* not found — continue */ }

  // Final fallback: same upload-root logic as routes/files.ts
  let uploadRoot: string;
  try {
    const parent = path.dirname(SHARED_ROOT);
    const s = fs.statSync(parent);
    if (s.isDirectory()) uploadRoot = SHARED_ROOT;
    else uploadRoot = path.join(os.tmpdir(), "michi", "files");
  } catch {
    uploadRoot = path.join(os.tmpdir(), "michi", "files");
  }
  const cwd = path.join(uploadRoot, workspaceId);
  if (cwd !== uploadRoot && !cwd.startsWith(uploadRoot + path.sep)) {
    throw new NotFoundError(workspaceId);
  }
  return cwd;
}

function resolveRoot(req: Request, workspaceId: string): string {
  if (process.env.MICHI_CLOUD === "1") {
    return deriveSandboxCwd(req.user!.id, workspaceId);
  }
  return pickDesktopRoot(workspaceId);
}

export function setupArtifactRoutes(): express.Router {
  const router = express.Router();

  router.get("/artifacts/:workspaceId/read", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    if (typeof workspaceId !== "string" || !WORKSPACE_ID_RE.test(workspaceId)) {
      return res.status(404).end();
    }

    const relPath = req.query.path;
    if (typeof relPath !== "string" || relPath.trim() === "") {
      return res.status(400).json({ error: "Missing ?path= parameter" });
    }

    // Reject hostile segments
    const segments = relPath.split("/");
    for (const seg of segments) {
      if (seg === "" || seg.startsWith("~") || seg.startsWith("@")) {
        return res.status(404).end();
      }
    }

    // 1. Resolve workspace root
    let root: string;
    try {
      root = resolveRoot(req, workspaceId);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).end();
      return res.status(500).end();
    }

    // 2. Sandbox resolution
    let abs: string;
    try {
      abs = resolveWithinCwd(relPath, root);
    } catch {
      return res.status(404).end();
    }

    // 3. Symlink escape defeat
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

    // 4. Regular file + size check
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return res.status(404).end();
    }
    if (!stat.isFile()) return res.status(404).end();

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
    if (typeof workspaceId !== "string" || !WORKSPACE_ID_RE.test(workspaceId)) {
      return res.status(404).end();
    }

    const rawPaths = (req.body as { paths?: unknown } | undefined)?.paths;
    if (!Array.isArray(rawPaths)) {
      return res.status(400).json({ error: "Expected { paths: string[] }" });
    }
    const paths = rawPaths.filter((p): p is string => typeof p === "string");

    let root: string;
    try {
      root = resolveRoot(req, workspaceId);
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
    if (typeof workspaceId !== "string" || !WORKSPACE_ID_RE.test(workspaceId)) {
      return res.status(404).end();
    }

    let root: string;
    try {
      root = resolveRoot(req, workspaceId);
    } catch (err) {
      if (err instanceof NotFoundError) return res.status(404).end();
      return res.status(500).end();
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // defeat proxy buffering (nginx)
    res.flushHeaders?.();
    // Prime the stream so EventSource fires `open` promptly (and any proxy
    // flushes headers). The frontend re-declares its path set on `open`.
    res.write(": connected\n\n");

    const unsubscribe = subscribeArtifactWatch(root, (evt) => {
      const event = evt.removed ? "artifact_removed" : "artifact_changed";
      const data = evt.removed
        ? { filePath: evt.filePath }
        : { filePath: evt.filePath, mtimeMs: evt.mtimeMs, size: evt.size };
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });

    // Heartbeat keeps intermediaries from reaping an idle connection.
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 25_000);
    heartbeat.unref?.();

    // res.on('close' — NOT req.on('close'): req 'close' fires as soon as the
    // (empty) request body is consumed, which would tear down the stream
    // immediately (CLAUDE.md gotcha).
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
