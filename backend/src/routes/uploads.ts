import express from "express";
import { NotFoundError } from "../services/workspaceSandbox";
import { resolveWorkspaceFileRoot, WORKSPACE_FILE_ID_RE } from "../services/workspaceFiles";

export function setupUploadsRoutes(): express.Router {
    const router = express.Router();

    // Cloud:   ${MICHI_DATA_DIR}/user-cwds/${userId}/ws-${workspaceId}/
    //          (same dir agent tools sandbox to via deriveSandboxCwd)
    // Desktop: saved cwd, existing upload, legacy scratch, then a new upload root.
    router.post("/uploads/web-cwd", (req, res) => {
        const workspaceId: unknown = req.body?.workspaceId;
        if (typeof workspaceId !== "string" || !WORKSPACE_FILE_ID_RE.test(workspaceId)) {
            return res.status(400).json({ error: "workspaceId must match [a-zA-Z0-9_-]{1,64}" });
        }
        try {
            const cwd = resolveWorkspaceFileRoot(req, workspaceId, { allocate: true });
            return res.json({ cwd });
        } catch (err) {
            if (err instanceof NotFoundError) return res.status(404).json({ error: "workspace not found" });
            return res.status(500).json({ error: `mkdir failed: ${(err as Error).message}` });
        }
    });

    return router;
}
