import { log } from "../../services/logger";
import {
    buildTitlePrompt,
    cleanGeneratedTitle,
    withTitleTimeout,
} from "../../services/titleGeneration";

/**
 * The slice of AcpClient the title generator needs. Kept narrow so tests can
 * drive it with a fake and so the generator never reaches into chat-session
 * bookkeeping (sessionCwd, sidByNodeId, …) that belongs to KiroRuntime.
 */
export interface KiroTitleClient {
    isAlive(): boolean;
    hasSession(sessionId: string): boolean;
    newSession(mcpServers?: never[]): Promise<{ sessionId: string }>;
    setModel(sessionId: string, modelId: string, timeoutMs?: number): Promise<void>;
    prompt(sessionId: string, text: string, extraBlocks?: never[], signal?: AbortSignal): AsyncIterableIterator<Record<string, any>>;
    cancel(sessionId: string): Promise<void>;
    cancelPermission(requestId: number): void;
    destroySession(sessionId: string): void;
}

export interface KiroTitleGeneratorDeps {
    /** Returns the live client the title session should live on (defaultCwd). */
    ensureClient(): Promise<KiroTitleClient>;
    /** Cheap model id, e.g. `gpt-5.6-luna`. */
    model: string;
    timeoutMs: number;
    /** Rotate the native session after this many prompts to bound history growth. */
    maxTurnsPerSession?: number;
}

interface TitleSessionHandle {
    client: KiroTitleClient;
    sid: string;
    turns: number;
}

export const DEFAULT_KIRO_TITLE_SESSION_TURNS = 40;

/**
 * One dedicated ACP session, on the shared defaultCwd kiro-cli process,
 * pinned to a cheap model. ACP serializes prompts per session and runs
 * different sessions in parallel, so this never blocks a chat turn; several
 * simultaneous title requests queue behind each other on this one session,
 * which is fine at 1-3s each.
 *
 * The session is recreated when the process died, the session was purged,
 * or after `maxTurnsPerSession` prompts (kiro keeps prior turns in context).
 */
export class KiroTitleGenerator {
    private handle: TitleSessionHandle | null = null;
    private opening: Promise<TitleSessionHandle> | null = null;
    private readonly maxTurns: number;

    constructor(private readonly deps: KiroTitleGeneratorDeps) {
        this.maxTurns = deps.maxTurnsPerSession ?? DEFAULT_KIRO_TITLE_SESSION_TURNS;
    }

    async generate(userText: string, signal?: AbortSignal, contextText?: string): Promise<string | null> {
        const handle = await this.ensureSession();
        handle.turns += 1;
        const rotateAfter = handle.turns >= this.maxTurns;
        try {
            const title = await withTitleTimeout(
                (timeoutSignal) => this.promptOnce(handle, userText, mergeSignals(signal, timeoutSignal), contextText),
                this.deps.timeoutMs,
                "kiro title generation",
            );
            return title || null;
        } catch (err) {
            // A timed-out or failed prompt leaves the session in an unknown
            // state; cancel it and drop the handle so the next title starts clean.
            await handle.client.cancel(handle.sid).catch(() => {});
            this.discard(handle);
            throw err;
        } finally {
            if (rotateAfter) this.discard(handle);
        }
    }

    async shutdown(): Promise<void> {
        const handle = this.handle;
        this.handle = null;
        if (handle) handle.client.destroySession(handle.sid);
    }

    private discard(handle: TitleSessionHandle): void {
        if (this.handle !== handle) return;
        this.handle = null;
        try {
            handle.client.destroySession(handle.sid);
        } catch {
            // best-effort
        }
    }

    private async ensureSession(): Promise<TitleSessionHandle> {
        const current = this.handle;
        if (current && current.client.isAlive() && current.client.hasSession(current.sid)) return current;
        if (this.opening) return this.opening;
        this.handle = null;
        this.opening = (async () => {
            const client = await this.deps.ensureClient();
            const { sessionId: sid } = await client.newSession([]);
            try {
                await client.setModel(sid, this.deps.model);
            } catch (err) {
                // The cheap model may be missing from this account's catalog.
                // Keep the session on kiro's default model rather than failing
                // every title; the cost difference is the only thing lost.
                log.warn("chat", "kiro title session could not switch model; using session default", {
                    model: this.deps.model,
                    error: (err as Error).message,
                });
            }
            const handle: TitleSessionHandle = { client, sid, turns: 0 };
            this.handle = handle;
            return handle;
        })().finally(() => {
            this.opening = null;
        });
        return this.opening;
    }

    private async promptOnce(handle: TitleSessionHandle, userText: string, signal: AbortSignal, contextText?: string): Promise<string> {
        let collected = "";
        for await (const update of handle.client.prompt(handle.sid, buildTitlePrompt(userText, contextText), [], signal)) {
            const kind = update?.sessionUpdate;
            if (kind === "agent_message_chunk") {
                const content = update.content;
                const blocks = Array.isArray(content) ? content : content ? [content] : [];
                for (const block of blocks) {
                    if (block && block.type === "text" && typeof block.text === "string") collected += block.text;
                }
            } else if (kind === "permission_request" && typeof update.requestId === "number") {
                // The title session has no business running tools. Decline
                // immediately so the model falls back to answering in text.
                handle.client.cancelPermission(update.requestId);
            } else if (kind === "turn_end") {
                break;
            }
        }
        return cleanGeneratedTitle(collected);
    }
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
    if (!a) return b;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (a.aborted || b.aborted) controller.abort();
    a.addEventListener("abort", abort, { once: true });
    b.addEventListener("abort", abort, { once: true });
    return controller.signal;
}
