import { createSseObserver } from "../services/httpSse";
import express, { Request, Response } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { NotFoundError } from "../services/workspaceSandbox";
import {
  findWorkspaceFileBySuffix,
  resolveWorkspaceFileRoot as resolveRoot,
  resolveWorkspaceRegularFile,
  WORKSPACE_FILE_ID_RE,
} from "../services/workspaceFiles";
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

  // Arbitrary files are downloads, never active same-origin HTML/SVG content.
  router.get("/artifacts/:workspaceId/download", (req: Request, res: Response) => {
    const workspaceId = req.params.workspaceId;
    if (typeof workspaceId !== 'string' || !WORKSPACE_FILE_ID_RE.test(workspaceId)
      || typeof req.query.path !== 'string') return res.status(404).end();
    try {
      const root = resolveWorkspaceRoot(req, workspaceId);
      const { realPath } = resolveWorkspaceRegularFile(req.query.path, root);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      // Containment is checked above. A workspace root may itself sit in a
      // dot directory (~/.michi/workspaces/<id>), which send() ignores by default.
      res.download(realPath, path.basename(realPath), { dotfiles: 'allow' }, (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    } catch {
      res.status(404).end();
    }
  });

  router.get("/artifacts/:workspaceId/read", async (req: Request, res: Response) => {
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

    const preview = req.query.preview === '1';
    let real: string;
    let stat: fs.Stats;
    let resolvedPath = relPath;
    try {
      // The owner desktop/remote API has host filesystem access, like the
      // Electron file viewer. Cloud previews always retain workspace isolation.
      if (preview && path.isAbsolute(relPath) && process.env.MICHI_CLOUD !== '1') {
        real = fs.realpathSync(relPath);
        stat = fs.statSync(real);
        if (!stat.isFile()) return res.status(404).end();
      } else {
        const relative = preview && path.isAbsolute(relPath) ? path.relative(root, relPath) : relPath;
        try {
          ({ realPath: real, stat } = resolveWorkspaceRegularFile(relative, root));
        } catch (error) {
          // Chat file links often cite only a basename or trailing path. The
          // match is sandboxed again; artifact reads keep exact paths.
          const match = preview && !path.isAbsolute(relPath) && (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? await findWorkspaceFileBySuffix(root, relative) : null;
          if (!match) throw error;
          ({ realPath: real, stat } = resolveWorkspaceRegularFile(match, root));
          resolvedPath = match;
        }
      }
    } catch {
      return res.status(404).end();
    }

    // Size gate: files >5MB should be opened externally
    if (stat.size > 5 * 1024 * 1024) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      return res.status(413).json({ error: `File too large (${sizeMB}MB > 5MB) — open externally` });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const imageMime = preview ? ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[path.extname(real).toLowerCase()] : undefined;
    if (imageMime) {
      try {
        return res.json({ content: `data:${imageMime};base64,${fs.readFileSync(real).toString('base64')}`, imageMime,
          path: resolvedPath, basename: path.basename(real), extension: path.extname(real).slice(1), size: stat.size, modifiedAt: stat.mtimeMs });
      } catch { return res.status(500).json({ error: 'Failed to read image' }); }
    }

    // 5. Read as UTF-8 text
    let content: string;
    try {
      const bytes = fs.readFileSync(real);
      if (preview && bytes.includes(0)) return res.status(415).json({ error: 'This binary file cannot be previewed.' });
      content = bytes.toString('utf-8');
    } catch {
      return res.status(500).json({ error: "Failed to read file" });
    }

    const ext = path.extname(real).toLowerCase().replace(/^\./, "");
    const basename = path.basename(real);

    res.json({
      content,
      path: resolvedPath,
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
