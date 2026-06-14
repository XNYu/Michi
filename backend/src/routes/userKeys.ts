import express, { Router } from "express";
import { listUserProviderKeys, setUserProviderKey, clearUserProviderKey } from "../services/userKeys";
import { log } from "../services/logger";

/**
 * Routes:
 *   GET  /api/user/keys                → which providers have a key set
 *                                         (returns provider list + last-4 mask + updatedAt;
 *                                          plaintext is never returned)
 *   PUT  /api/user/keys/:provider      → body: { key: string }
 *   DEL  /api/user/keys/:provider
 *
 * All routes require an authenticated session — that's enforced upstream
 * by the requireSession middleware in server.ts. Here we just read
 * req.user.id and trust it.
 */
export function setupUserKeysRoutes(): Router {
    const router = express.Router();

    router.get("/user/keys", (req, res) => {
        const userId = req.user?.id as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        try {
            const rows = listUserProviderKeys(userId);
            res.json({
                providers: rows.map((r) => ({
                    provider: r.provider,
                    updatedAt: r.updatedAt,
                })),
            });
        } catch (err) {
            log.error("auth", "listUserProviderKeys failed", { err: (err as Error).message });
            res.status(500).json({ error: "failed to list provider keys" });
        }
    });

    router.put("/user/keys/:provider", (req, res) => {
        const userId = req.user?.id as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        const provider = req.params.provider;
        const { key } = req.body ?? {};
        if (typeof key !== "string" || !key.trim()) {
            return res.status(400).json({ error: "key (string) is required" });
        }
        try {
            setUserProviderKey(userId, provider, key.trim());
            res.json({ ok: true });
        } catch (err) {
            log.warn("auth", "setUserProviderKey failed", { err: (err as Error).message });
            res.status(400).json({ error: (err as Error).message });
        }
    });

    router.delete("/user/keys/:provider", (req, res) => {
        const userId = req.user?.id as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        const provider = req.params.provider;
        try {
            clearUserProviderKey(userId, provider);
            res.json({ ok: true });
        } catch (err) {
            log.error("auth", "clearUserProviderKey failed", { err: (err as Error).message });
            res.status(500).json({ error: "failed to clear provider key" });
        }
    });

    return router;
}
