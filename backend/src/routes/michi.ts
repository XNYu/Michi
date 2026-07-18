import express from "express";
import path from "path";
import fs from "fs";
import { assertCwdAllowed, getUserSandboxRoot, deriveSandboxCwd, NotFoundError } from "../agents/tools/pathSandbox";
import { ChatManager, ExtraContext } from "../services/chatManager";
import { summarizeWorkspace, ExportRequest } from "../services/exportSummary";
import { finalTerminalEvent } from "./chatStreamEvents";
import { getRuntime } from "../agents/registry";
import { getAgentConfig, resolveModel, resolveReasoning } from "../services/agentConfig";
import { startupMark } from "../services/startupTrace";
import * as sessionRegistry from "../agents/sessionRegistry";
import { chatHub, type BackgroundCursor, type HubSubscriber } from "../agents/chatHub";
import { paneOwnership } from "../agents/paneOwnership";
import { HEARTBEAT_INTERVAL_MS } from "../config/constants";
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from "michi-shared";
// getSessionForUser enforces ownership in cloud mode; getSession is for internal callers.
const { getSessionForUser } = sessionRegistry;
import type { AgentSession } from "../agents/types";
import {
    getNode,
    getNodeSessionBinding,
    getNodeWorkspaceId,
    listGrants,
    listMessages,
    revokePermission,
    saveWorkspace,
    updateNodeResumeBinding,
} from "../services/dbRepository";
import type { WorkspaceRow } from "../services/dbRepository";
import { ensureDurableGraphNode } from "../services/graphCommands";
import { requireWorkspaceOwner, requireChatOwner, requireNodeOwner } from "./middleware/ownership";
import {
    buildCompatibleResumeContext,
    buildTargetResumeSignature,
    chooseResumeStrategy,
    computeTranscriptFingerprint,
    normalizeResumeSignature,
    normalizeSignaturePart,
    type ResumeSignature,
    type ResumeStrategy,
    type TranscriptMessage,
} from "../services/resumeStrategy";

function inferRuntimeId(row: ReturnType<typeof getNode> | null, nodeId: string): string | null {
    const explicit = normalizeSignaturePart(row?.runtime_id);
    if (explicit) return explicit;
    const sid = normalizeSignaturePart(row?.acp_session_id);
    if (!sid) return null;
    return sid === nodeId ? "pi" : "kiro";
}

function resolvePublicNodeId(identifier: string, userId?: string | null): string | null {
    const live = getSessionForUser(identifier, userId ?? null);
    if (live) return live.id;
    return getNodeSessionBinding(identifier, userId ?? undefined)?.nodeId ?? null;
}

function getSessionByIdentifier(identifier: string, userId?: string | null): AgentSession | null {
    const nodeId = resolvePublicNodeId(identifier, userId);
    return nodeId ? getSessionForUser(nodeId, userId ?? null) : null;
}

export function canAccessRuntimeChat(chatId: string, userId?: string): boolean {
    if (process.env.MICHI_CLOUD !== '1') return true;
    if (!userId) return false;
    return Boolean(getNodeSessionBinding(chatId, userId) || getSessionForUser(chatId, userId));
}

/**
 * A message's UI node must be the persisted owner of its runtime chat id.
 * This closes the gap where a caller who owns two nodes could send a turn to
 * one runtime while attributing its durable events to the other node.
 */
export function isRuntimeChatBoundToNode(chatId: string, nodeId: string, userId?: string): boolean {
    if (process.env.MICHI_CLOUD !== '1' || !userId) return false;
    return getNodeSessionBinding(chatId, userId)?.nodeId === nodeId;
}

const MAX_BACKGROUND_CURSORS = 5_000;
const MAX_SSE_BUFFER_BYTES = 1_048_576;

/** The small writable surface shared by Express' SSE responses and route tests. */
export interface SseWritableResponse {
    writableEnded: boolean;
    destroyed: boolean;
    writableLength: number;
    write(frame: string): unknown;
    destroy(error?: Error): unknown;
}

/**
 * Write one SSE frame, dropping only this HTTP response when its outgoing
 * buffer grows beyond 1 MiB. Callers detach their subscriber on `false`; the
 * ChatHub turn itself deliberately continues so a client can replay later.
 */
export function writeSseFrame(response: SseWritableResponse, frame: string): boolean {
    if (response.writableEnded || response.destroyed) return false;
    try {
        response.write(frame);
    } catch {
        return false;
    }
    if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
        try {
            response.destroy(new Error('SSE client exceeded buffer limit'));
        } catch {
            // The peer is already gone; either way this subscriber is done.
        }
        return false;
    }
    return true;
}

function readBackgroundCursors(raw: unknown): Record<string, BackgroundCursor> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, BackgroundCursor> = {};
    for (const [chatId, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_BACKGROUND_CURSORS)) {
        if (!chatId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const turnId = (value as { turnId?: unknown }).turnId;
        const seq = (value as { seq?: unknown }).seq;
        if (typeof turnId !== 'string' || !turnId || typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        out[chatId] = { turnId, seq: Math.max(-1, Math.trunc(seq)) };
    }
    return out;
}

function ensureCloudWorkspaceRow(userId: string | undefined, workspaceId: string | null | undefined): void {
    if (process.env.MICHI_CLOUD !== "1" || !userId || !workspaceId) return;
    try {
        deriveSandboxCwd(userId, workspaceId);
        return;
    } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
    }

    const now = Date.now();
    const row: WorkspaceRow = {
        id: workspaceId,
        name: "Untitled",
        cwd: null,
        active_tree_id: null,
        created_at: now,
        updated_at: now,
        settings: null,
        deleted_at: null,
        archived_at: null,
        owner_user_id: userId,
    };
    saveWorkspace(row);
}

function readTranscriptMessages(input: unknown, nodeId: string, userId?: string): TranscriptMessage[] {
    if (Array.isArray(input)) {
        return input.flatMap((item): TranscriptMessage[] => {
            if (!item || typeof item !== "object") return [];
            const row = item as Record<string, unknown>;
            const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
            const content =
                typeof row.content === "string"
                    ? row.content
                    : typeof row.text === "string"
                        ? row.text
                        : null;
            if (!role || content === null) return [];
            return [{ role, content }];
        });
    }
    return listMessages(nodeId, userId)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
        }));
}

function readExistingSignature(
    row: ReturnType<typeof getNode> | null,
    body: Record<string, unknown>,
    nodeId: string,
): ResumeSignature | null {
    return normalizeResumeSignature({
        runtimeId: row?.runtime_id ?? body.runtimeId ?? inferRuntimeId(row, nodeId),
        providerId: row?.provider_id ?? body.providerId,
        modelId: row?.model_id ?? body.modelId,
        reasoning: row?.reasoning ?? body.reasoning,
    });
}

function isClaudeConcurrencyError(err: unknown): boolean {
    return (err as Error | undefined)?.name === "ClaudeConcurrencyError";
}

function sendAgentRouteError(res: express.Response, err: unknown): void {
    if (isClaudeConcurrencyError(err)) {
        res.status(503).json({
            code: "CLAUDE_SESSIONS_BUSY",
            error: (err as Error).message,
        });
        return;
    }
    res.status(500).json({ error: (err as Error).message });
}

async function retireLiveSession(session: AgentSession | undefined): Promise<void> {
    if (!session) return;
    const runtime = getRuntime(session.runtimeId);
    try {
        await Promise.resolve(runtime?.releaseSession(session.id) ?? session.cancel());
    } catch {
        /* ignore best-effort cleanup */
    }
    sessionRegistry.dropSession(session.id);
}

function persistResumeBinding(
    nodeId: string,
    session: AgentSession,
    signature: ResumeSignature,
    fingerprint: string,
): void {
    try {
        if (!getNode(nodeId)) return;
        updateNodeResumeBinding(nodeId, {
            acp_session_id: session.nativeSessionId ?? session.id,
            runtime_id: signature.runtimeId,
            provider_id: signature.providerId,
            model_id: signature.modelId,
            reasoning: signature.reasoning,
            resume_fingerprint: fingerprint,
            current_mode_id: session.currentModeId ?? null,
        });
    } catch (err) {
        console.warn(`Failed to persist resume binding for ${nodeId}:`, err);
    }
}

export function setupMichiRoutes(chatManager: ChatManager) {
    const router = express.Router();

    // Copies an externally-picked file into <cwd>/.contexts/. The frontend
    // reads the bytes via <input type="file"> (which uses the OS native
    // dialog under Electron) and posts either utf-8 text (`content`) for
    // text files or base64-encoded bytes (`contentBase64`) for binary
    // attachments like pasted images. Context injection in chatManager.ts
    // is char-based and confined to cwd, so writing here keeps both
    // untitled and real workspaces on a single code path.
    router.post("/workspaces/import-file", requireWorkspaceOwner, (req, res) => {
        // In cloud mode cwd is derived server-side from the workspace's owned
        // sandbox directory; the client-supplied cwd is ignored.
        let cwd: string;
        const originalName: unknown = req.body?.originalName;
        const content: unknown = req.body?.content;
        const contentBase64: unknown = req.body?.contentBase64;
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            const workspaceId: unknown = req.body?.workspaceId;
            if (typeof workspaceId !== "string" || !workspaceId) {
                return res.status(400).json({ error: "workspaceId is required" });
            }
            try {
                cwd = deriveSandboxCwd(userId, workspaceId);
            } catch (err) {
                if (err instanceof NotFoundError) {
                    return res.status(404).json({ error: "workspace not found" });
                }
                return res.status(400).json({ error: (err as Error).message });
            }
            // assertCwdAllowed stays as defense-in-depth even though cwd is server-derived.
            assertCwdAllowed(cwd, userId);
        } else {
            const cwdRaw: unknown = req.body?.cwd;
            if (typeof cwdRaw !== "string" || !path.isAbsolute(cwdRaw)) {
                return res.status(400).json({ error: "cwd must be an absolute path" });
            }
            cwd = cwdRaw;
        }
        if (typeof originalName !== "string" || originalName.length === 0) {
            return res.status(400).json({ error: "originalName required" });
        }
        const hasText = typeof content === "string";
        const hasBinary = typeof contentBase64 === "string";
        if (hasText === hasBinary) {
            return res.status(400).json({ error: "exactly one of content or contentBase64 required" });
        }

        let bytes: Buffer;
        if (hasText) {
            const text = content as string;
            if (text.length > 1_000_000) {
                return res.status(413).json({ error: `file too large (${text.length} chars; max 1,000,000)` });
            }
            bytes = Buffer.from(text, "utf-8");
        } else {
            const b64 = contentBase64 as string;
            try {
                bytes = Buffer.from(b64, "base64");
            } catch (err) {
                return res.status(400).json({ error: `invalid base64: ${(err as Error).message}` });
            }
            if (bytes.length === 0) {
                return res.status(400).json({ error: "decoded payload is empty" });
            }
            if (bytes.length > 20_000_000) {
                return res.status(413).json({ error: `file too large (${bytes.length} bytes; max 20,000,000)` });
            }
        }

        try {
            const s = fs.statSync(cwd);
            if (!s.isDirectory()) return res.status(400).json({ error: "cwd is not a directory" });
        } catch {
            return res.status(400).json({ error: "cwd does not exist" });
        }

        const base = path.basename(originalName);
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length).replace(/[^a-zA-Z0-9_-]/g, "_") || "file";
        const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "");

        const dir = path.join(cwd, ".contexts");
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            return res.status(500).json({ error: `mkdir .contexts failed: ${(err as Error).message}` });
        }

        let name = stem;
        let filename = `${stem}${safeExt}`;
        let attempt = 0;
        while (fs.existsSync(path.join(dir, filename))) {
            attempt += 1;
            name = `${stem}-${attempt}`;
            filename = `${name}${safeExt}`;
            if (attempt > 9999) return res.status(500).json({ error: "could not allocate unique filename" });
        }

        const target = path.join(dir, filename);
        if (!target.startsWith(dir + path.sep)) {
            return res.status(400).json({ error: "resolved path escapes .contexts" });
        }
        try {
            fs.writeFileSync(target, bytes);
        } catch (err) {
            return res.status(500).json({ error: `write failed: ${(err as Error).message}` });
        }
        res.json({
            name,
            displayName: base,
            filePath: `.contexts/${filename}`,
            size: bytes.length,
        });
    });

    /**
     * Pre-warm a cwd's ACP client + warmed session pool.
     *
     * Dispatches through the active runtime. Kiro warms its cwd ACP client
     * and next session; Claude registers the workspace in its warm pool and
     * resolves when the first warm slot is available.
     *
     * Frontend calls this on:
     *   - hydrate complete (for the active workspace's cwd)
     *   - workspace creation (for the new cwd)
     *   - workspace switch (for the target cwd)
     *
     * Idempotent: repeat calls for a cwd that already has a warmed session
     * are no-ops.
     */
    router.post("/warm", async (req, res) => {
        const routeStart = Date.now();
        // In cloud mode cwd is derived server-side from workspaceId.
        let cwd: string;
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            const workspaceId: unknown = req.body?.workspaceId;
            if (typeof workspaceId !== "string" || !workspaceId) {
                return res.status(400).json({ error: "workspaceId is required in cloud mode" });
            }
            try {
                cwd = deriveSandboxCwd(userId, workspaceId);
            } catch (err) {
                if (err instanceof NotFoundError) {
                    return res.status(404).json({ error: "workspace not found" });
                }
                return res.status(400).json({ error: (err as Error).message });
            }
            // assertCwdAllowed stays as defense-in-depth.
            assertCwdAllowed(cwd, userId);
        } else {
            const cwdRaw: unknown = req.body?.cwd;
            if (typeof cwdRaw !== "string" || !path.isAbsolute(cwdRaw)) {
                return res.status(400).json({ error: "cwd must be an absolute path" });
            }
            cwd = cwdRaw;
            try {
                const s = fs.statSync(cwd);
                if (!s.isDirectory()) {
                    return res.status(400).json({ error: "cwd is not a directory" });
                }
            } catch {
                return res.status(400).json({ error: "cwd does not exist or is not accessible" });
            }
        }

        const userIdForConfig: string | undefined = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
        const cfg = getAgentConfig(userIdForConfig);
        const runtime = getRuntime(cfg.runtime);
        startupMark("warm_route_start", { cwd, runtime: cfg.runtime });
        if (!runtime?.capabilities.warmSessions) {
            startupMark("warm_route_skipped", { cwd, runtime: cfg.runtime, durMs: Date.now() - routeStart });
            return res.json({ ok: true, skipped: true });
        }

        try {
            await runtime.warm(cwd, { model: resolveModel(cfg.runtime, userIdForConfig) });
            startupMark("warm_route_done", { cwd, runtime: cfg.runtime, durMs: Date.now() - routeStart });
            return res.json({ ok: true });
        } catch (err) {
            console.warn(`runtime.warm(${cwd}) failed:`, err);
            startupMark("warm_route_failed", {
                cwd,
                runtime: cfg.runtime,
                durMs: Date.now() - routeStart,
                error: (err as Error).message,
            });
            return res.json({ ok: true, warning: (err as Error).message });
        }
    });

    router.post("/chats", requireWorkspaceOwner, async (req, res) => {
        try {
            const parentChatId: string | undefined = req.body?.parentChatId;
            const mergeContexts: unknown = req.body?.mergeContexts;
            const model: unknown = req.body?.model;
            const modeId: unknown = req.body?.modeId;
            if (model !== undefined && typeof model !== "string") {
                return res.status(400).json({ error: "model must be a string" });
            }
            if (modeId !== undefined && (typeof modeId !== "string" || modeId.length === 0)) {
                return res.status(400).json({ error: "modeId must be a non-empty string" });
            }

            // In cloud mode, derive cwd server-side from workspaceId; ignore client-supplied cwd.
            // Desktop trusts client-supplied cwd.
            let cwd: string | undefined;
            if (process.env.MICHI_CLOUD === "1") {
                const userId = req.user!.id;
                const bodyWorkspaceIdForCwd: unknown = req.body?.workspaceId;
                if (typeof bodyWorkspaceIdForCwd === "string" && bodyWorkspaceIdForCwd.length > 0) {
                    try {
                        cwd = deriveSandboxCwd(userId, bodyWorkspaceIdForCwd);
                    } catch (err) {
                        if (err instanceof NotFoundError) {
                            return res.status(404).json({ error: "workspace not found" });
                        }
                        return res.status(400).json({ error: (err as Error).message });
                    }
                    // assertCwdAllowed stays as defense-in-depth.
                    assertCwdAllowed(cwd, userId);
                }
                // If no workspaceId was sent yet (e.g. untitled chat), cwd stays undefined
                // and falls back to process.cwd() below — same as before for that edge case.
            } else {
                const cwdRaw: unknown = req.body?.cwd;
                if (cwdRaw !== undefined) {
                    if (typeof cwdRaw !== "string" || !path.isAbsolute(cwdRaw)) {
                        return res.status(400).json({ error: "cwd must be an absolute path" });
                    }
                    try {
                        const s = fs.statSync(cwdRaw);
                        if (!s.isDirectory()) {
                            return res.status(400).json({ error: "cwd is not a directory" });
                        }
                    } catch {
                        return res.status(400).json({ error: "cwd does not exist" });
                    }
                    cwd = cwdRaw;
                }
            }
            let validatedMergeContexts: string[] | undefined;
            if (mergeContexts !== undefined) {
                if (!Array.isArray(mergeContexts) || !mergeContexts.every((x) => typeof x === "string")) {
                    return res.status(400).json({ error: "mergeContexts must be an array of strings" });
                }
                validatedMergeContexts = mergeContexts as string[];
            }
            const extraContexts: unknown = req.body?.extraContexts;
            let validatedExtraContexts: ExtraContext[] | undefined;
            if (extraContexts !== undefined) {
                if (!Array.isArray(extraContexts) || extraContexts.length > 20) {
                    return res.status(400).json({ error: "extraContexts must be an array of at most 20 items" });
                }
                for (const item of extraContexts) {
                    if (
                        typeof item !== "object" || item === null ||
                        typeof item.name !== "string" || item.name.length > 64 ||
                        typeof item.filePath !== "string" || !item.filePath
                    ) {
                        return res.status(400).json({ error: "each extraContext must have name (string, ≤64 chars) and filePath (string)" });
                    }
                    if (item.filePath.includes('..')) {
                        return res.status(400).json({ error: 'filePath must not contain ..' });
                    }
                    if ('size' in item && (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0)) {
                        return res.status(400).json({ error: 'extraContext.size must be a non-negative number when provided' });
                    }
                    if ('kind' in item && item.kind !== undefined && item.kind !== 'embedded' && item.kind !== 'reference') {
                        return res.status(400).json({ error: "extraContexts kind must be 'embedded' or 'reference' if present" });
                    }
                }
                validatedExtraContexts = extraContexts as ExtraContext[];
            }
            const contextManifest: unknown = req.body?.contextManifest;
            let validatedContextManifest: ExtraContext[] | undefined;
            if (contextManifest !== undefined) {
                if (!Array.isArray(contextManifest) || contextManifest.length > 50) {
                    return res.status(400).json({ error: "contextManifest must be an array of at most 50 items" });
                }
                for (const item of contextManifest) {
                    if (
                        typeof item !== "object" || item === null ||
                        typeof item.name !== "string" || item.name.length > 64 ||
                        typeof item.filePath !== "string" || !item.filePath
                    ) {
                        return res.status(400).json({ error: "each contextManifest item must have name (string, ≤64 chars) and filePath (string)" });
                    }
                    if (item.filePath.includes('..')) {
                        return res.status(400).json({ error: 'contextManifest filePath must not contain ..' });
                    }
                    if ('size' in item && (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0)) {
                        return res.status(400).json({ error: 'contextManifest.size must be a non-negative number when provided' });
                    }
                    if ('kind' in item && item.kind !== undefined && item.kind !== 'embedded' && item.kind !== 'reference') {
                        return res.status(400).json({ error: "contextManifest kind must be 'embedded' or 'reference' if present" });
                    }
                }
                validatedContextManifest = contextManifest as ExtraContext[];
            }
            const enableFollowUpsRaw: unknown = req.body?.enableFollowUps;
            let enableFollowUps: boolean = true;
            if (enableFollowUpsRaw !== undefined) {
                if (typeof enableFollowUpsRaw !== "boolean") {
                    return res.status(400).json({ error: "enableFollowUps must be a boolean" });
                }
                enableFollowUps = enableFollowUpsRaw;
            }

            // Optional client-supplied session id. Pi adopts it so chatId
            // === nodeId; Kiro ignores it (ACP requires server-minted ids).
            const nodeId: unknown = req.body?.nodeId;
            let validatedSessionId: string | undefined;
            if (nodeId !== undefined) {
                if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 128) {
                    return res.status(400).json({ error: "nodeId must be a non-empty string ≤128 chars" });
                }
                validatedSessionId = nodeId;
            }

            const userIdForConfig: string | undefined = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
            const cfg = getAgentConfig(userIdForConfig);
            const runtime = getRuntime(cfg.runtime);
            if (!runtime) {
                return res.status(500).json({ error: `Unknown agent runtime: ${cfg.runtime}` });
            }

            // Resolve workspaceId for the new session. Priority:
            //   1. Client-supplied workspaceId — the frontend always knows the owning
            //      project at createChat time, and the graph sync runs every 2s, so
            //      a fresh node + parent often haven't been flushed to SQLite yet.
            //      Trusting the client here avoids a cold-start race that left
            //      slot.workspaceId = null and broke list_threads/search_messages/
            //      read_node for the entire session.
            //   2. Parent node's workspace — covers older clients that don't send it.
            //   3. Supplied nodeId's workspace — last-resort fallback for replays.
            let workspaceId: string | null = null;
            const bodyWorkspaceId: unknown = req.body?.workspaceId;
            if (typeof bodyWorkspaceId === "string" && bodyWorkspaceId.length > 0) {
                if (bodyWorkspaceId.length > 128) {
                    return res.status(400).json({ error: "workspaceId must be ≤128 chars" });
                }
                workspaceId = bodyWorkspaceId;
            }
            if (!workspaceId && parentChatId) {
                workspaceId = getNode(parentChatId)?.workspace_id ?? null;
            }
            if (!workspaceId && validatedSessionId) {
                workspaceId = getNode(validatedSessionId)?.workspace_id ?? null;
            }

            const session = await runtime.newSession({
                cwd: cwd ?? process.cwd(),
                parentChatId,
                mergeContexts: validatedMergeContexts,
                extraContexts: validatedExtraContexts,
                contextManifest: validatedContextManifest,
                enableFollowUps,
                model: (model as string | undefined) ?? resolveModel(cfg.runtime, userIdForConfig),
                provider: cfg.provider,
                reasoning: resolveReasoning(cfg.runtime, userIdForConfig),
                sessionId: validatedSessionId,
                workspaceId,
                ownerUserId: req.user?.id ?? null,
            });
            if (
                typeof modeId === "string" &&
                session.setMode &&
                session.currentModeId !== modeId
            ) {
                await session.setMode(modeId);
            }
            sessionRegistry.registerSession(session, req.user?.id ?? null);
            res.json({
                chatId: session.id,
                currentModeId: session.currentModeId ?? null,
                runtimeId: session.runtimeId,
            });
        } catch (err) {
            console.error("Failed to create chat:", err);
            sendAgentRouteError(res, err);
        }
    });

    router.post("/chats/:chatId/load", requireChatOwner, async (req, res) => {
        const { chatId } = req.params;
        const cwd: unknown = req.body?.cwd;
        const model: unknown = req.body?.model;
        const nodeId: unknown = req.body?.nodeId;
        const bodyRuntimeId: unknown = req.body?.runtimeId;
        if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
            return res.status(400).json({ error: "cwd must be an absolute path" });
        }
        try {
            const s = fs.statSync(cwd);
            if (!s.isDirectory()) return res.status(400).json({ error: "cwd is not a directory" });
        } catch {
            return res.status(400).json({ error: "cwd does not exist" });
        }
        if (model !== undefined && typeof model !== "string") {
            return res.status(400).json({ error: "model must be a string" });
        }
        if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 128)) {
            return res.status(400).json({ error: "nodeId must be a non-empty string <=128 chars" });
        }
        if (bodyRuntimeId !== undefined && (typeof bodyRuntimeId !== "string" || bodyRuntimeId.length === 0)) {
            return res.status(400).json({ error: "runtimeId must be a non-empty string" });
        }
        try {
            const resolvedNodeId = typeof nodeId === "string"
                ? nodeId
                : resolvePublicNodeId(chatId, req.user?.id ?? null) ?? chatId;
            const nodeRow = getNode(resolvedNodeId);
            const chatRow = getNode(chatId);
            const row = nodeRow ?? chatRow;
            const runtimeId =
                (bodyRuntimeId as string | undefined) ??
                row?.runtime_id ??
                inferRuntimeId(row, resolvedNodeId) ??
                getAgentConfig(process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined).runtime;
            const runtime = getRuntime(runtimeId);
            if (!runtime?.loadSession) {
                return res.status(404).json({ error: `Runtime ${runtimeId} cannot load sessions` });
            }

            // Resolve workspaceId for the reloaded session.
            //   1. Client-supplied — required for Kiro because chatId is an
            //      ACP-minted sid, not a node id, so the getNode() fallback
            //      below cannot find it. Without this, list_threads /
            //      search_messages / read_node return NO_WORKSPACE every time
            //      a Kiro session is reloaded after the backend (or its
            //      in-memory session map) has been recycled.
            //   2. getNode(chatId) — works for Pi where chatId === nodeId.
            //      Kept as fallback for clients that don't send workspaceId.
            let workspaceId: string | null = null;
            const bodyWorkspaceId: unknown = req.body?.workspaceId;
            if (typeof bodyWorkspaceId === "string" && bodyWorkspaceId.length > 0 && bodyWorkspaceId.length <= 128) {
                workspaceId = bodyWorkspaceId;
            }
            if (!workspaceId) {
                workspaceId = row?.workspace_id ?? null;
            }
            const session = await runtime.loadSession({
                sessionId: resolvedNodeId,
                nodeId: resolvedNodeId,
                cwd,
                model: model as string | undefined,
                workspaceId,
                ownerUserId: req.user?.id ?? null,
            });
            sessionRegistry.registerSession(session, req.user?.id ?? null);
            res.json({
                ok: true,
                currentModeId: session.currentModeId ?? null,
                runtimeId: session.runtimeId,
            });
        } catch (err) {
            console.warn(`session/load failed for ${chatId}:`, err);
            res.status(404).json({ error: (err as Error).message });
        }
    });

    router.post("/nodes/:nodeId/ensure-session", requireNodeOwner, async (req, res) => {
        const { nodeId } = req.params;
        const routeStart = Date.now();
        startupMark("ensure_session_route_start", { nodeId });
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (!nodeId || nodeId.length > 128) {
            return res.status(400).json({ error: "nodeId must be a non-empty string <=128 chars" });
        }
        if (!getNode(nodeId)) {
            const prerequisite = body.graphPrerequisite;
            if (!prerequisite || typeof prerequisite !== 'object') {
                return res.status(409).json({
                    error: 'durable node prerequisite required before session creation',
                    code: 'NODE_NOT_PERSISTED',
                });
            }
            try {
                ensureDurableGraphNode({
                    ...(prerequisite as Parameters<typeof ensureDurableGraphNode>[0]),
                    ownerUserId: process.env.MICHI_CLOUD === '1' ? (req.user?.id ?? null) : null,
                });
            } catch (err) {
                return res.status(409).json({
                    error: (err as Error).message,
                    code: 'NODE_PREREQUISITE_FAILED',
                });
            }
        }

        // In cloud mode, derive cwd server-side from the node's workspace ownership.
        // Desktop trusts client-supplied cwd.
        let cwd = process.cwd();
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            // Prefer client-supplied workspaceId; fall back to the node's workspace.
            const wsIdForCwd: string | null =
                (typeof body.workspaceId === "string" && body.workspaceId.length > 0
                    ? body.workspaceId
                    : null) ??
                getNodeWorkspaceId(nodeId);
            if (wsIdForCwd) {
                try {
                    ensureCloudWorkspaceRow(userId, wsIdForCwd);
                    cwd = deriveSandboxCwd(userId, wsIdForCwd);
                } catch (err) {
                    if (err instanceof NotFoundError) {
                        return res.status(404).json({ error: "workspace not found" });
                    }
                    return res.status(400).json({ error: (err as Error).message });
                }
                // assertCwdAllowed stays as defense-in-depth.
                assertCwdAllowed(cwd, userId);
            }
        } else {
            const cwdRaw = body.cwd;
            if (cwdRaw !== undefined) {
                if (typeof cwdRaw !== "string" || !path.isAbsolute(cwdRaw)) {
                    return res.status(400).json({ error: "cwd must be an absolute path" });
                }
                try {
                    const s = fs.statSync(cwdRaw);
                    if (!s.isDirectory()) return res.status(400).json({ error: "cwd is not a directory" });
                } catch {
                    return res.status(400).json({ error: "cwd does not exist" });
                }
                cwd = cwdRaw;
            }
        }

        const existingChatId = normalizeSignaturePart(body.chatId);
        const parentChatId = normalizeSignaturePart(body.parentChatId) ?? undefined;
        const workspaceId = normalizeSignaturePart(body.workspaceId) ?? getNodeWorkspaceId(nodeId);
        const modelRaw = body.model;
        if (modelRaw !== undefined && typeof modelRaw !== "string") {
            return res.status(400).json({ error: "model must be a string" });
        }

        // Desired agent/mode for a brand-new thread (e.g. Home composer pre-pick).
        // Applied after a fresh session is created so the first prompt runs under it.
        if (body.modeId !== undefined && typeof body.modeId !== "string") {
            return res.status(400).json({ error: "modeId must be a string" });
        }
        const desiredModeId = normalizeSignaturePart(body.modeId);

        const mergeContextsRaw = body.mergeContexts;
        let mergeContexts: string[] = [];
        if (mergeContextsRaw !== undefined) {
            if (!Array.isArray(mergeContextsRaw) || !mergeContextsRaw.every((x) => typeof x === "string")) {
                return res.status(400).json({ error: "mergeContexts must be an array of strings" });
            }
            mergeContexts = mergeContextsRaw as string[];
        }

        const readExtraContexts = (raw: unknown, label: string, max: number): ExtraContext[] | undefined => {
            if (raw === undefined) return undefined;
            if (!Array.isArray(raw) || raw.length > max) {
                throw new Error(`${label} must be an array of at most ${max} items`);
            }
            for (const item of raw) {
                if (
                    typeof item !== "object" || item === null ||
                    typeof (item as ExtraContext).name !== "string" || (item as ExtraContext).name.length > 64 ||
                    typeof (item as ExtraContext).filePath !== "string" || !(item as ExtraContext).filePath
                ) {
                    throw new Error(`each ${label} item must have name (string, <=64 chars) and filePath (string)`);
                }
                const ctx = item as ExtraContext;
                if (ctx.filePath.includes("..")) {
                    throw new Error(`${label} filePath must not contain ..`);
                }
                if ("size" in ctx && ctx.size !== undefined && (typeof ctx.size !== "number" || !Number.isFinite(ctx.size) || ctx.size < 0)) {
                    throw new Error(`${label}.size must be a non-negative number when provided`);
                }
                if ("kind" in ctx && ctx.kind !== undefined && ctx.kind !== "embedded" && ctx.kind !== "reference") {
                    throw new Error(`${label}.kind must be 'embedded' or 'reference' if present`);
                }
            }
            return raw as ExtraContext[];
        };

        let extraContexts: ExtraContext[] | undefined;
        let contextManifest: ExtraContext[] | undefined;
        try {
            extraContexts = readExtraContexts(body.extraContexts, "extraContexts", 20);
            contextManifest = readExtraContexts(body.contextManifest, "contextManifest", 50);
        } catch (err) {
            return res.status(400).json({ error: (err as Error).message });
        }

        let enableFollowUps = true;
        if (body.enableFollowUps !== undefined) {
            if (typeof body.enableFollowUps !== "boolean") {
                return res.status(400).json({ error: "enableFollowUps must be a boolean" });
            }
            enableFollowUps = body.enableFollowUps;
        }

        try {
            const michiUserId: string | undefined = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
            const cfg = getAgentConfig(michiUserId);
            const runtime = getRuntime(cfg.runtime);
            if (!runtime) {
                return res.status(500).json({ error: `Unknown agent runtime: ${cfg.runtime}` });
            }
            const targetSignature = buildTargetResumeSignature(
                cfg,
                runtime,
                typeof modelRaw === "string" ? modelRaw : undefined,
            );
            const row = getNode(nodeId);
            const transcript = readTranscriptMessages(body.priorMessages, nodeId, michiUserId);
            const currentFingerprint = computeTranscriptFingerprint(transcript);
            const storedFingerprint =
                normalizeSignaturePart(body.resumeFingerprint) ??
                normalizeSignaturePart(row?.resume_fingerprint);
            const persistedBinding =
                normalizeSignaturePart(row?.acp_session_id) ??
                normalizeSignaturePart(row?.external_session_id);
            const legacyBinding = existingChatId
                ? getNodeSessionBinding(existingChatId, michiUserId)
                : null;
            const hasResumeBinding = !!persistedBinding || legacyBinding?.nodeId === nodeId;
            const existingSignature = readExistingSignature(row, body, nodeId);
            const liveSession = sessionRegistry.getSession(nodeId)
                ?? (existingChatId ? sessionRegistry.getSession(existingChatId) : undefined);
            const nativeResumeAvailable =
                runtime.capabilities.nativeResume &&
                typeof runtime.loadSession === "function" &&
                hasResumeBinding;
            const decision = chooseResumeStrategy({
                existingChatId: hasResumeBinding ? nodeId : null,
                liveSessionMatches: !!liveSession && liveSession.runtimeId === targetSignature.runtimeId,
                nativeResumeAvailable,
                existingSignature,
                targetSignature,
                storedFingerprint,
                currentFingerprint,
            });

            let session: AgentSession | undefined;
            let resumeStrategy: ResumeStrategy = decision.strategy;
            let resumeReason = decision.reason;

            if (decision.strategy === "live" && liveSession) {
                session = liveSession;
            } else if (decision.strategy === "exact" && runtime.loadSession) {
                try {
                    session = await runtime.loadSession({
                        sessionId: nodeId,
                        nodeId,
                        cwd,
                        model: targetSignature.modelId,
                        workspaceId,
                        ownerUserId: req.user?.id ?? null,
                    });
                    sessionRegistry.registerSession(session, req.user?.id ?? null);
                } catch (err) {
                    console.warn(`exact resume failed for ${nodeId}; falling back to compatible resume: ${(err as Error).message}`);
                    resumeStrategy = "compatible";
                    resumeReason = `exact_failed:${(err as Error).message}`;
                }
            }

            if (!session) {
                if (liveSession) {
                    await retireLiveSession(liveSession);
                }
                const resumeContext = buildCompatibleResumeContext(transcript, {
                    nodeId,
                    title: row?.title ?? null,
                });

                // Fallback: when branching and the parent session is dead in
                // memory (or parentChatId was nulled during hydration), read
                // the parent's transcript from SQLite and inject it as a merge
                // context so the child still gets ancestor history.
                let parentTranscriptContext: string | null = null;
                const resolvedParentNodeId: string | null = (() => {
                    if (parentChatId) {
                        if (sessionRegistry.getSession(parentChatId)) return null; // live — runtime handles it
                        const binding = getNodeSessionBinding(parentChatId, michiUserId);
                        return binding?.nodeId ?? parentChatId;
                    }
                    // parentChatId absent (nulled on hydration) — look up via DB edge
                    return row?.parent_node_id ?? null;
                })();
                if (resolvedParentNodeId) {
                    const parentRow = getNode(resolvedParentNodeId);
                    if (parentRow) {
                        const parentMessages = listMessages(resolvedParentNodeId, michiUserId)
                            .filter((m) => m.role === "user" || m.role === "assistant")
                            .map((m) => ({
                                role: m.role as "user" | "assistant",
                                content: m.content,
                            }));
                        if (parentMessages.length > 0) {
                            parentTranscriptContext = buildCompatibleResumeContext(parentMessages, {
                                nodeId: resolvedParentNodeId,
                                title: parentRow.title ?? null,
                            });
                        }
                    }
                }

                const seededMergeContexts = [
                    ...(resumeContext ? [resumeContext] : []),
                    ...(parentTranscriptContext ? [parentTranscriptContext] : []),
                    ...mergeContexts,
                ];
                session = await runtime.newSession({
                    cwd,
                    parentChatId,
                    mergeContexts: seededMergeContexts.length > 0 ? seededMergeContexts : undefined,
                    extraContexts,
                    contextManifest,
                    enableFollowUps,
                    model: targetSignature.modelId,
                    provider: targetSignature.providerId,
                    reasoning: targetSignature.reasoning,
                    sessionId: nodeId,
                    workspaceId,
                    ownerUserId: req.user?.id ?? null,
                });
                sessionRegistry.registerSession(session, req.user?.id ?? null);

                // Apply the caller's explicit agent pick before the first
                // prompt. This block only runs for a newly constructed runtime
                // session; live/exact resumes returned above are untouched.
                // A bad/unsupported mode must not fail session creation.
                if (
                    desiredModeId &&
                    session.setMode &&
                    session.currentModeId !== desiredModeId
                ) {
                    try {
                        await session.setMode(desiredModeId);
                    } catch (err) {
                        console.warn(
                            `Failed to apply desired mode ${desiredModeId} on ${session.id}:`,
                            err,
                        );
                    }
                }
            }

            persistResumeBinding(nodeId, session, targetSignature, currentFingerprint);
            startupMark("ensure_session_route_done", {
                nodeId,
                chatId: session.id,
                resumeStrategy,
                durMs: Date.now() - routeStart,
            });
            return res.json({
                chatId: session.id,
                currentModeId: session.currentModeId ?? null,
                runtimeId: targetSignature.runtimeId,
                providerId: targetSignature.providerId,
                modelId: targetSignature.modelId,
                reasoning: targetSignature.reasoning,
                resumeFingerprint: currentFingerprint,
                resumeStrategy,
                resumeReason,
            });
        } catch (err) {
            console.error("Failed to ensure session:", err);
            startupMark("ensure_session_route_failed", {
                nodeId,
                durMs: Date.now() - routeStart,
                error: (err as Error).message,
            });
            return sendAgentRouteError(res, err);
        }
    });

    router.post("/chats/:chatId/message", requireChatOwner, async (req, res) => {
        const requestedIdentifier = req.params.chatId;
        const text: string = req.body?.text || "";
        const displayText: string = typeof req.body?.displayText === 'string'
            ? req.body.displayText
            : text;
        const userMetadata = req.body?.userMetadata && typeof req.body.userMetadata === 'object'
            ? req.body.userMetadata
            : undefined;
        const legacyNodeId: string | undefined = req.body?.nodeId;
        const ownerToken: string | undefined = req.body?.ownerToken;
        const turnId: string | undefined = typeof req.body?.turnId === 'string' && req.body.turnId.length > 0
            ? req.body.turnId
            : undefined;
        const routeStart = Date.now();
        const session = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
        const nodeId = session?.id ?? null;
        startupMark("stream_route_start", { chatId: requestedIdentifier, nodeId, textLen: text.length });
        if (!text) {
            return res.status(400).json({ error: "text is required" });
        }
        if (!session || !nodeId) {
            return res.status(404).json({ error: `unknown chat: ${requestedIdentifier}` });
        }
        if (legacyNodeId && legacyNodeId !== nodeId) {
            return res.status(409).json({
                error: "chat identifier and nodeId resolve to different nodes",
                code: "IDENTITY_MISMATCH",
            });
        }
        if (paneOwnership.hasLiveClaim(nodeId) && (!ownerToken || !paneOwnership.isHeldBy(nodeId, ownerToken))) {
            return res.status(403).json({ error: "not the pane owner" });
        }
        if (chatHub.isActive(nodeId)) {
            return res.status(409).json({ error: "a turn is already active for this chat" });
        }

        let started;
        try {
            started = chatHub.startTurn({
                chatId: nodeId, nodeId, text, displayText, userMetadata, session,
                turnId,
                ownerUserId: req.user?.id ?? null,
            });
        } catch (err) {
            return res.status(409).json({
                error: (err as Error).message,
                code: 'turn_begin_failed',
            });
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        let wroteTerminal = false;
        let wroteFirstEvent = false;
        let detached = false;
        let detach = () => {};
        const detachSubscriber = () => {
            if (detached) return;
            detached = true;
            detach();
        };
        const sub: HubSubscriber = {
            send: (ev) => {
                if (res.writableEnded || res.destroyed) return;
                if (!wroteFirstEvent) {
                    wroteFirstEvent = true;
                    startupMark("stream_route_first_event", { chatId: nodeId, nodeId, kind: ev.event, durMs: Date.now() - routeStart });
                }
                if (ev.event === CHAT_STREAM_EVENTS.done || ev.event === CHAT_STREAM_EVENTS.error) {
                    wroteTerminal = true;
                }
                if (!writeSseFrame(res, encodeChatStreamEvent(ev))) detachSubscriber();
            },
            close: () => {
                const terminal = finalTerminalEvent({ wroteTerminal, aborted: false });
                if (terminal && !res.writableEnded && !res.destroyed) {
                    writeSseFrame(res, encodeChatStreamEvent(terminal));
                }
                if (!res.writableEnded && !res.destroyed) res.end();
            },
        };
        const subscription = chatHub.subscribeTurn(nodeId, started.turnId, sub, 0);
        if (!subscription) {
            return res.status(410).json({ error: 'turn replay unavailable', code: 'turn_replay_unavailable' });
        }
        detach = subscription;
        if (detached) detach();
        res.on("close", () => {
            detachSubscriber();
        });
        try {
            await started.done;
        } finally {
            startupMark("stream_route_done", { chatId: nodeId, nodeId, durMs: Date.now() - routeStart, aborted: false });
            if (!res.writableEnded && !res.destroyed) res.end();
        }
    });

    router.post("/chats/:chatId/cancel", requireChatOwner, async (req, res) => {
        const requestedIdentifier = req.params.chatId;
        const session = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
        const nodeId = session?.id ?? resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        const ownerToken: string | undefined = req.body?.ownerToken;
        const turnId: string | undefined = typeof req.body?.turnId === 'string'
            ? req.body.turnId
            : undefined;
        try {
            if (paneOwnership.hasLiveClaim(nodeId) && (!ownerToken || !paneOwnership.isHeldBy(nodeId, ownerToken))) {
                return res.status(403).json({ error: "not the pane owner" });
            }
            const activeTurnMatched = chatHub.cancel(nodeId, turnId);
            // Foreground turns are cancelled through ChatHub.activeSessions.
            // Runtime self-turns are owned by ClaudeSession's idle-pump lock,
            // so cancel that live session directly.
            if (session && activeTurnMatched && !chatHub.isOwnerTurnActive(nodeId)) {
                await Promise.resolve(session.cancel());
            }
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.post("/chats/background/subscribe", (req, res) => {
        const backgroundUserId = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
        if (process.env.MICHI_CLOUD === "1" && !backgroundUserId) {
            return res.status(401).json({ error: "unauthorized" });
        }
        const requestedCursors = readBackgroundCursors(req.body?.cursors);
        const cursors: Record<string, BackgroundCursor> = {};
        const durableCursors: Record<string, BackgroundCursor> = {};
        const nodeIds = new Map<string, string>();
        for (const [chatId, cursor] of Object.entries(requestedCursors)) {
            const binding = getNodeSessionBinding(chatId, backgroundUserId ?? null);
            if (process.env.MICHI_CLOUD === "1" && !binding) continue;
            cursors[chatId] = cursor;
            if (!binding) continue;
            nodeIds.set(chatId, binding.nodeId);
            const row = getNode(binding.nodeId);
            if (row?.last_applied_turn_id && typeof row.last_applied_seq === 'number') {
                durableCursors[chatId] = {
                    turnId: row.last_applied_turn_id,
                    seq: row.last_applied_seq,
                };
            }
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        let detached = false;
        let detach = () => {};
        const detachSubscriber = () => {
            if (detached) return;
            detached = true;
            detach();
        };
        try {
            detach = chatHub.subscribeBackground({
            send: (chatId, event) => {
                if (res.writableEnded || res.destroyed) return;
                if (!writeSseFrame(res, encodeChatStreamEvent(event))) detachSubscriber();
            },
            gap: (chatId, durableCursor) => {
                const nodeId = nodeIds.get(chatId)
                    ?? getNodeSessionBinding(chatId, backgroundUserId ?? null)?.nodeId;
                if (!writeSseFrame(res,
                    `event: background_sync_required\ndata: ${JSON.stringify({ chatId, nodeId, ...durableCursor })}\n\n`,
                )) detachSubscriber();
            },
            close: () => {},
            ownerUserId: backgroundUserId,
            }, { cursors, durableCursors });
            if (detached) detach();
        } catch {
            if (!res.writableEnded) res.end();
            return;
        }

        const keepalive = setInterval(() => {
            if (res.writableEnded || res.destroyed) return;
            if (!writeSseFrame(res, ': keepalive\n\n')) detachSubscriber();
        }, HEARTBEAT_INTERVAL_MS);
        keepalive.unref?.();
        res.on("close", () => {
            clearInterval(keepalive);
            detachSubscriber();
        });
    });

    router.get("/chats/:chatId/stream", requireChatOwner, (req, res) => {
        const requestedIdentifier = req.params.chatId;
        const nodeId = resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        const fromSeqRaw = req.query.fromSeq;
        const fromTurnIdRaw = req.query.fromTurnId;
        const fromSeq = typeof fromSeqRaw === "string" ? parseInt(fromSeqRaw, 10) : 0;
        const fromTurnId = typeof fromTurnIdRaw === "string" ? fromTurnIdRaw : undefined;

        if (!fromTurnId) return res.status(400).json({ error: 'fromTurnId is required' });
        if (!canAccessRuntimeChat(requestedIdentifier, req.user?.id)) {
            return res.status(404).json({ error: 'not_found' });
        }
        // Validate the replay cursor before committing HTTP/SSE headers so a
        // gap remains an actionable 410 response rather than a hung stream.
        const probe = chatHub.subscribeTurn(nodeId, fromTurnId, { send: () => {}, close: () => {} }, Number.isFinite(fromSeq) ? fromSeq : 0);
        if (!probe) return res.status(410).json({ error: 'turn replay unavailable', code: 'turn_replay_unavailable' });
        probe();

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        let detached = false;
        let detach = () => {};
        const detachSubscriber = () => {
            if (detached) return;
            detached = true;
            detach();
        };
        const sub: HubSubscriber = {
            send: (ev) => {
                if (res.writableEnded || res.destroyed) return;
                if (!writeSseFrame(res, encodeChatStreamEvent(ev))) {
                    detachSubscriber();
                    return;
                }
                if (ev.event === CHAT_STREAM_EVENTS.done || ev.event === CHAT_STREAM_EVENTS.error) {
                    // A replay/direct recovery stream is per-turn. It must
                    // release its HTTP/1.1 slot once that turn is terminal.
                    queueMicrotask(() => {
                        if (!res.writableEnded) res.end();
                    });
                }
            },
            close: () => {
                if (!res.writableEnded && !res.destroyed) res.end();
            },
        };
        const subscription = chatHub.subscribeTurn(nodeId, fromTurnId, sub, Number.isFinite(fromSeq) ? fromSeq : 0);
        if (!subscription) return res.status(410).json({ error: 'turn replay unavailable', code: 'turn_replay_unavailable' });
        detach = subscription;
        if (detached) detach();
        const keepalive = setInterval(() => {
            if (res.writableEnded || res.destroyed) return;
            if (!writeSseFrame(res, ': keepalive\n\n')) detachSubscriber();
        }, HEARTBEAT_INTERVAL_MS);
        keepalive.unref?.();
        res.on("close", () => {
            clearInterval(keepalive);
            detachSubscriber();
        });
    });

    router.post("/chats/:chatId/claim", requireChatOwner, (req, res) => {
        const nodeId = resolvePublicNodeId(req.params.chatId, req.user?.id ?? null) ?? req.params.chatId;
        const ownerToken: unknown = req.body?.ownerToken;
        const windowId: unknown = req.body?.windowId;
        if (typeof ownerToken !== "string" || !ownerToken) {
            return res.status(400).json({ error: "ownerToken is required" });
        }
        res.json(paneOwnership.claim(nodeId, ownerToken, typeof windowId === "string" ? windowId : "window"));
    });

    router.post("/chats/:chatId/heartbeat", requireChatOwner, (req, res) => {
        const nodeId = resolvePublicNodeId(req.params.chatId, req.user?.id ?? null) ?? req.params.chatId;
        const ownerToken: unknown = req.body?.ownerToken;
        if (typeof ownerToken !== "string" || !ownerToken) {
            return res.status(400).json({ error: "ownerToken is required" });
        }
        const ok = paneOwnership.heartbeat(nodeId, ownerToken);
        if (!ok) return res.status(409).json({ ok: false, demoted: true });
        res.json({ ok: true });
    });

    router.post("/chats/:chatId/release", requireChatOwner, (req, res) => {
        const nodeId = resolvePublicNodeId(req.params.chatId, req.user?.id ?? null) ?? req.params.chatId;
        const ownerToken: unknown = req.body?.ownerToken;
        if (typeof ownerToken !== "string" || !ownerToken) {
            return res.status(400).json({ error: "ownerToken is required" });
        }
        paneOwnership.release(nodeId, ownerToken);
        res.json({ ok: true });
    });

    // Accept or deny a pending permission request from kiro-cli.
    // The frontend sends { requestId, optionId } to approve, or
    // { requestId, cancel: true } to deny.
    router.post("/chats/:chatId/permission-response", requireChatOwner, (req, res) => {
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        const nodeId = session.id;
        const { requestId, optionId, cancel } = req.body ?? {};
        if (typeof requestId !== "number") {
            return res.status(400).json({ error: "requestId (number) is required" });
        }
        if (cancel === true) {
            session.cancelPermission?.(requestId);
            chatHub.resolvePermission(nodeId, requestId);
            return res.json({ ok: true });
        }
        if (typeof optionId !== "string") {
            return res.status(400).json({ error: "optionId (string) required when not cancelling" });
        }
        if (!session.respondToPermission) {
            return res.status(400).json({ error: "Session does not support permissions" });
        }
        session.respondToPermission(requestId, optionId);
        chatHub.resolvePermission(nodeId, requestId);
        res.json({ ok: true });
    });

    // Respond to a pending AskUserQuestion from the agent.
    router.post("/chats/:chatId/user-input-response", requireChatOwner, (req, res) => {
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        const nodeId = session.id;
        const { requestId, answers, skip } = req.body ?? {};
        if (typeof requestId !== "number") {
            return res.status(400).json({ error: "requestId (number) is required" });
        }
        if (skip === true) {
            session.skipUserInput?.(requestId);
            chatHub.resolveUserInput(nodeId, requestId);
            return res.json({ ok: true });
        }
        if (!Array.isArray(answers)) {
            return res.status(400).json({ error: "answers (array) required when not skipping" });
        }
        if (!session.respondToUserInput) {
            return res.status(400).json({ error: "Session does not support user input requests" });
        }
        session.respondToUserInput(requestId, answers);
        chatHub.resolveUserInput(nodeId, requestId);
        res.json({ ok: true });
    });

    // List always-allow permission grants for a workspace.
    router.get("/workspaces/:workspaceId/permission-grants", requireWorkspaceOwner, (req, res) => {
        const { workspaceId } = req.params;
        try {
            res.json({ grants: listGrants(workspaceId) });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // Revoke a single grant.
    router.delete("/workspaces/:workspaceId/permission-grants/:toolName", requireWorkspaceOwner, (req, res) => {
        const { workspaceId, toolName } = req.params;
        try {
            revokePermission(workspaceId, toolName);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get("/modes", async (req, res) => {
        const cfg = getAgentConfig(process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined);
        const runtime = getRuntime(cfg.runtime);
        if (!runtime?.capabilities.modes) {
            return res.json({ availableModes: [] });
        }
        try {
            // The kiro path keeps its warm-aware ChatManager fast path; any
            // other modes-capable runtime answers through the AgentRuntime
            // contract. The frontend expects { id, name, description }.
            if (runtime === chatManager.getRuntime()) {
                const availableModes = await chatManager.getAvailableModes();
                return res.json({ availableModes });
            }
            const modes = await (runtime.listModes?.("") ?? Promise.resolve([]));
            res.json({
                availableModes: modes.map((m) => ({
                    id: m.id,
                    name: m.label ?? m.id,
                    description: m.description,
                })),
            });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get("/chats/:chatId/modes", requireChatOwner, (req, res) => {
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        res.json({ currentModeId: session.currentModeId ?? null });
    });

    router.post("/chats/:chatId/set-mode", requireChatOwner, async (req, res) => {
        const modeId = req.body?.modeId;
        if (typeof modeId !== "string" || !modeId) {
            return res.status(400).json({ error: "modeId is required" });
        }
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session?.setMode) {
            return res.status(400).json({ error: "Active session does not support modes" });
        }
        try {
            await session.setMode(modeId);
            res.json({ ok: true, currentModeId: modeId });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get("/chats/:chatId/model", requireChatOwner, (req, res) => {
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        res.json({ currentModelId: session.currentModelId ?? null });
    });

    router.post("/chats/:chatId/set-model", requireChatOwner, async (req, res) => {
        const modelId = req.body?.modelId;
        if (typeof modelId !== "string" || !modelId) {
            return res.status(400).json({ error: "modelId is required" });
        }
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session?.setModel) {
            return res.status(400).json({ error: "Active session does not support runtime model switching" });
        }
        try {
            await session.setModel(modelId);
            res.json({ ok: true, currentModelId: modelId });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.post("/exports/summary", requireWorkspaceOwner, async (req, res) => {
        try {
            const body = req.body as ExportRequest;
            if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
                return res.status(400).json({ error: "nodes is required" });
            }
            if (body.cwd !== undefined) {
                if (typeof body.cwd !== "string" || !path.isAbsolute(body.cwd)) {
                    return res.status(400).json({ error: "cwd must be an absolute path" });
                }
                try {
                    const s = fs.statSync(body.cwd);
                    if (!s.isDirectory()) {
                        return res.status(400).json({ error: "cwd is not a directory" });
                    }
                } catch {
                    return res.status(400).json({ error: "cwd does not exist" });
                }
            }
            const markdown = await summarizeWorkspace(chatManager, body);
            res.json({ markdown });
        } catch (err) {
            console.error("Export failed:", err);
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get("/models", async (_req, res) => {
        try {
            const { execFile } = await import("child_process");
            const { promisify } = await import("util");
            const { findKiroCli } = await import("../services/acpClient");
            const pexec = promisify(execFile);
            const bin = process.env.KIRO_CLI_BIN || findKiroCli();
            const { stdout } = await pexec(bin, ["chat", "--list-models", "--format", "json"], {
                timeout: 5000,
            });
            const parsed = JSON.parse(stdout);
            res.json({ models: parsed.models || [], default_model: parsed.default_model || null });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}
