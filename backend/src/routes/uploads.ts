import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { deriveSandboxCwd, NotFoundError } from "../agents/tools/pathSandbox";

const SHARED_ROOT = "/shared/michi/files";

function tmpRoot(): string {
    return path.join(os.tmpdir(), "michi", "files");
}

function pickDesktopRoot(): string {
    try {
        const parent = path.dirname(SHARED_ROOT);
        const s = fs.statSync(parent);
        if (s.isDirectory()) return SHARED_ROOT;
    } catch {
        // /shared not present (typical dev / Docker) — fall through to tmp.
    }
    return tmpRoot();
}

export function setupUploadsRoutes(): express.Router {
    const router = express.Router();

    // Cloud:   ${MICHI_DATA_DIR}/user-cwds/${userId}/ws-${workspaceId}/
    //          (same dir agent tools sandbox to via deriveSandboxCwd)
    // Desktop: /shared/michi/files/<workspaceId>/  (or os.tmpdir() fallback)
    router.post("/uploads/web-cwd", (req, res) => {
        const workspaceId: unknown = req.body?.workspaceId;
        if (typeof workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(workspaceId)) {
            return res.status(400).json({ error: "workspaceId must match [a-zA-Z0-9_-]{1,64}" });
        }
        const userId: string | undefined = req.user?.id;

        if (process.env.MICHI_CLOUD === "1" && userId) {
            try {
                // deriveSandboxCwd verifies ownership and mkdirs the workspace
                // sandbox dir. Returning that path here keeps uploads landing
                // inside the same cwd the agent's read/bash tools sandbox to —
                // otherwise the agent can't see uploaded files.
                return res.json({ cwd: deriveSandboxCwd(userId, workspaceId) });
            } catch (err) {
                if (err instanceof NotFoundError) {
                    return res.status(404).json({ error: "workspace not found" });
                }
                return res.status(500).json({ error: `mkdir failed: ${(err as Error).message}` });
            }
        }

        const root = pickDesktopRoot();
        const cwd = path.join(root, workspaceId);
        if (!cwd.startsWith(root + path.sep)) {
            return res.status(400).json({ error: "resolved path escapes upload root" });
        }
        try {
            fs.mkdirSync(cwd, { recursive: true });
        } catch (err) {
            return res.status(500).json({ error: `mkdir failed: ${(err as Error).message}` });
        }
        res.json({ cwd });
    });

    return router;
}
