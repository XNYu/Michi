import { createSseObserver } from "../services/httpSse";
import express from "express";
import path from "path";
import fs from "fs";
import { ChatManager } from "../services/chatManager";
import {
    runDigestGeneration,
    streamDigestGeneration,
    GenerationRequest,
} from "../services/digestGenerator";
import { requireWorkspaceOwner } from "./middleware/ownership";

function validateGenerationBody(body: GenerationRequest): string | null {
    if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
        return "nodes is required";
    }
    if (body.cwd !== undefined) {
        if (typeof body.cwd !== "string" || !path.isAbsolute(body.cwd)) {
            return "cwd must be an absolute path";
        }
        try {
            const s = fs.statSync(body.cwd);
            if (!s.isDirectory()) return "cwd is not a directory";
        } catch {
            return "cwd does not exist";
        }
    }
    return null;
}

export function setupDigestRoutes(chatManager: ChatManager) {
    const router = express.Router();

    router.post("/digests/generate", requireWorkspaceOwner, async (req, res) => {
        try {
            const body = req.body as GenerationRequest;
            const err = validateGenerationBody(body);
            if (err) return res.status(400).json({ error: err });
            const markdown = await runDigestGeneration(chatManager, body);
            res.json({ markdown });
        } catch (err) {
            console.error("Digest generation failed:", err);
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.post("/digests/stream", requireWorkspaceOwner, async (req, res) => {
        const body = req.body as GenerationRequest;
        const validation = validateGenerationBody(body);
        if (validation) return res.status(400).json({ error: validation });

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        const observer = createSseObserver(res);
        const send = (event: string, data: unknown) => {
            observer.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
            for await (const ev of streamDigestGeneration(chatManager, body)) {
                // Drain the producer after observer disconnect; do not cancel its turn.
                if (ev.kind === "chunk" || ev.kind === "thought" || ev.kind === "status") {
                    send(ev.kind, { text: ev.text });
                } else if (ev.kind === "done") {
                    send("done", { markdown: ev.finalMarkdown });
                    break;
                }
            }
        } catch (err) {
            console.error("Digest streaming failed:", err);
            send("error", { message: (err as Error).message });
        } finally {
            observer.close();
            if (!res.destroyed && !res.writableEnded) res.end();
        }
    });

    return router;
}
