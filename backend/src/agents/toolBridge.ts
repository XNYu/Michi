import fs from "fs";
import path from "path";
import { log } from "../services/logger";

/**
 * Shared business-effect handlers for the four internal "tools" any agent
 * runtime can call: spawn-branches, set-title, set-follow-ups, save/update-context.
 *
 * The bridge does NOT surface events. That's each runtime's job:
 *   - Kiro injects synthetic ACP updates onto the parent ACP session queue
 *     (see ChatManager.handleSpawnBranches etc.).
 *   - Pi yields NormalizedEvent directly from its in-process stream loop.
 *
 * The runtime calls bridge.spawnBranches(...) etc. and consumes the
 * structured result. The bridge handles the durable side effects (creating
 * a new chat, persisting a context file).
 */
export interface SpawnedBranch {
    title: string;
    prompt: string;
    chatId: string;
    nodeId: string;
}

export interface BridgeSpawnBranchesArgs {
    /** The chatId that initiated the spawn (the "parent" branch). */
    parentChatId: string;
    /** Cwd inherited by the children. */
    cwd: string;
    /** Whether children should also instruct the agent to call set_follow_ups. */
    enableFollowUps: boolean;
    /** Cloud owner of the parent session, forwarded to durable graph lookup. */
    ownerUserId?: string | null;
    topics: Array<{ title: string; prompt: string }>;
}

export interface BridgeSaveContextArgs {
    cwd: string;
    /** Runtime chat id used to resolve the durable workspace owner. */
    chatId?: string;
    ownerUserId?: string | null;
    /** Sanitized to /^[A-Za-z0-9_-]+$/. The bridge enforces this. */
    name: string;
    body: string;
}

export interface BridgeContextResult {
    /** Durable contexts row id. Present in the production bridge. */
    id?: string;
    name: string;
    filePath: string;
    size: number;
}

export type BridgeSaveContextResult = BridgeContextResult;
export type BridgeUpdateContextResult = BridgeContextResult;

export interface BridgeUpdateContextArgs {
    cwd: string;
    /** Runtime chat id used to resolve the durable workspace owner. */
    chatId?: string;
    ownerUserId?: string | null;
    /** Sanitized to /^[A-Za-z0-9_-]+$/. The bridge enforces this. */
    name: string;
    body: string;
}

export interface AgentToolBridge {
    spawnBranches(args: BridgeSpawnBranchesArgs): Promise<SpawnedBranch[]>;
    saveContext(args: BridgeSaveContextArgs): BridgeSaveContextResult | null;
    updateContext(args: BridgeUpdateContextArgs): BridgeUpdateContextResult | null;
}

/**
 * Default implementation. The `createChild` callback is provided at
 * construction time so the bridge stays decoupled from ChatManager
 * implementation details — the wiring of "create a new chat with
 * parent X, cwd Y" is provided by the caller.
 */
export interface AgentToolBridgeDeps {
    createChild: (args: {
        parentChatId: string;
        cwd: string;
        enableFollowUps: boolean;
        ownerUserId?: string | null;
        /** Durable node title — survives an expired parent replay frame. */
        title: string;
        /** First child turn, stored as a durable outbox item until it starts. */
        prompt: string;
    }) => Promise<{ chatId: string; nodeId: string }>;
    /**
     * Records agent-owned context metadata immediately after the file write.
     * Optional so isolated runtime/unit tests can use the filesystem-only bridge.
     */
    persistContext?: (context: {
        chatId: string;
        ownerUserId?: string | null;
        name: string;
        filePath: string;
        size: number;
    }) => string | false | null | void;
}

function isValidContextName(name: unknown): name is string {
    return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name);
}

function contextFilePath(name: string): string {
    return `.contexts/${name}.md`;
}

export function createAgentToolBridge(deps: AgentToolBridgeDeps): AgentToolBridge {
    const persistContext = (args: { chatId?: string; ownerUserId?: string | null; name: string; filePath: string; size: number }): string | undefined | null => {
        if (!args.chatId || !deps.persistContext) return undefined;
        try {
            const persisted = deps.persistContext({
                chatId: args.chatId,
                ...(args.ownerUserId !== undefined ? { ownerUserId: args.ownerUserId } : {}),
                name: args.name,
                filePath: args.filePath,
                size: args.size,
            });
            if (persisted === false || persisted === null) return null;
            return typeof persisted === "string" ? persisted : undefined;
        } catch (err) {
            log.error("bridge", "context metadata persistence failed", { chatId: args.chatId, name: args.name, err: (err as Error).message });
            return null;
        }
    };
    return {
        async spawnBranches(args: BridgeSpawnBranchesArgs): Promise<SpawnedBranch[]> {
            const capped = args.topics.slice(0, 5);
            const result: SpawnedBranch[] = [];
            for (const t of capped) {
                if (!t?.title || !t?.prompt) continue;
                try {
                    const child = await deps.createChild({
                        parentChatId: args.parentChatId,
                        cwd: args.cwd,
                        enableFollowUps: args.enableFollowUps,
                        ...(args.ownerUserId !== undefined ? { ownerUserId: args.ownerUserId } : {}),
                        title: t.title,
                        prompt: t.prompt,
                    });
                    result.push({ title: t.title, prompt: t.prompt, chatId: child.chatId, nodeId: child.nodeId });
                    log.info("bridge", "branch child created", { parentChatId: args.parentChatId, childChatId: child.chatId, nodeId: child.nodeId, title: t.title });
                } catch (err) {
                    log.error("bridge", "branch child create failed", { parentChatId: args.parentChatId, title: t.title, err: (err as Error).message });
                }
            }
            return result;
        },
        saveContext(args: BridgeSaveContextArgs): BridgeSaveContextResult | null {
            // Path traversal protection — same regex as old ChatManager.handleSaveContext.
            if (!isValidContextName(args.name) || typeof args.body !== "string") {
                log.warn("bridge", "saveContext rejected (invalid name)", { name: args.name });
                return null;
            }
            const dir = path.join(args.cwd, ".contexts");
            fs.mkdirSync(dir, { recursive: true });
            const filePath = contextFilePath(args.name);
            fs.writeFileSync(path.join(args.cwd, filePath), args.body, "utf-8");
            log.info("bridge", "context saved", { name: args.name, size: args.body.length, cwd: args.cwd });
            const result = { name: args.name, filePath, size: args.body.length };
            const contextId = persistContext({ chatId: args.chatId, ownerUserId: args.ownerUserId, ...result });
            if (contextId === null) return null;
            return { ...result, ...(contextId ? { id: contextId } : {}) };
        },
        updateContext(args: BridgeUpdateContextArgs): BridgeUpdateContextResult | null {
            if (!isValidContextName(args.name) || typeof args.body !== "string") {
                log.warn("bridge", "updateContext rejected (invalid name)", { name: args.name });
                return null;
            }
            const filePath = contextFilePath(args.name);
            const absolutePath = path.join(args.cwd, filePath);
            if (!fs.existsSync(absolutePath)) {
                log.warn("bridge", "updateContext rejected (missing context)", { name: args.name, cwd: args.cwd });
                return null;
            }
            fs.writeFileSync(absolutePath, args.body, "utf-8");
            log.info("bridge", "context updated", { name: args.name, size: args.body.length, cwd: args.cwd });
            const result = { name: args.name, filePath, size: args.body.length };
            const contextId = persistContext({ chatId: args.chatId, ownerUserId: args.ownerUserId, ...result });
            if (contextId === null) return null;
            return { ...result, ...(contextId ? { id: contextId } : {}) };
        },
    };
}
