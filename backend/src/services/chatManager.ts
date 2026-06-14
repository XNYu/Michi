import type { NormalizedEvent } from "./chatEvents";
import type { KiroRuntime } from "../agents/kiro/KiroRuntime";
import type { AgentSession, ChatMessage, ExtraContext } from "../agents/types";
import * as sessionRegistry from "../agents/sessionRegistry";

export type { ChatMessage, ExtraContext };

/**
 * Thin facade that brokers chat-creation requests to KiroRuntime and
 * registers the resulting AgentSession with sessionRegistry. Used by
 * digestGenerator / exportSummary which still take a ChatManager handle —
 * routes/michi.ts now goes through sessionRegistry directly.
 *
 * KiroRuntime is constructed by RUNTIME_FACTORIES in server.ts; ChatManager
 * holds a reference to the registered instance instead of owning its
 * lifecycle. The runtime is optional so Pi-only / Claude-only deployments
 * (where Kiro isn't registered) can still construct a ChatManager — the
 * Kiro-specific methods (warm, modes, setMode) become no-ops in that case.
 */
export class ChatManager {
    constructor(
        private readonly runtime: KiroRuntime | undefined,
        private readonly defaultCwd: string = process.cwd(),
    ) {}

    getRuntime(): KiroRuntime | undefined {
        return this.runtime;
    }

    async newChat(
        parentChatId?: string,
        cwd?: string,
        mergeContexts?: string[],
        model?: string,
        extraContexts?: ExtraContext[],
        enableFollowUps: boolean = true,
        contextManifest?: ExtraContext[],
    ): Promise<string> {
        if (!this.runtime) {
            throw new Error("ChatManager.newChat: Kiro runtime not registered");
        }
        const session = await this.runtime.newSession({
            cwd: cwd ?? this.defaultCwd,
            parentChatId,
            mergeContexts,
            extraContexts,
            contextManifest,
            enableFollowUps,
            model,
        });
        sessionRegistry.registerSession(session);
        return session.id;
    }

    async *sendMessage(chatId: string, userText: string): AsyncIterableIterator<NormalizedEvent> {
        const session = sessionRegistry.getSession(chatId);
        if (!session) throw new Error(`unknown chat: ${chatId}`);
        yield* session.send(userText);
    }

    async cancel(chatId: string): Promise<void> {
        const session = sessionRegistry.getSession(chatId);
        if (!session) return;
        await Promise.resolve(session.cancel());
    }

    respondToPermission(chatId: string, requestId: number, optionId: string): void {
        const session = sessionRegistry.getSession(chatId);
        session?.respondToPermission?.(requestId, optionId);
    }

    cancelPermission(chatId: string, requestId: number): void {
        const session = sessionRegistry.getSession(chatId);
        session?.cancelPermission?.(requestId);
    }

    getCurrentMode(chatId: string): string | undefined {
        return this.runtime?.getCurrentMode(chatId);
    }

    async getAvailableModes(): Promise<any[]> {
        if (!this.runtime) return [];
        return this.runtime.getAvailableModes();
    }

    async setMode(chatId: string, modeId: string): Promise<void> {
        if (!this.runtime) return;
        await this.runtime.setMode(chatId, modeId);
    }

    async warm(): Promise<void> {
        if (!this.runtime) return;
        await this.runtime.warm(this.defaultCwd);
    }

    /** AgentSession lookup (used by ChatManager-using callers; new code should use sessionRegistry directly). */
    getSession(chatId: string): AgentSession | undefined {
        return sessionRegistry.getSession(chatId);
    }
}
