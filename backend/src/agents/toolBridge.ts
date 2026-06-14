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
}

export interface BridgeSpawnBranchesArgs {
    /** The chatId that initiated the spawn (the "parent" branch). */
    parentChatId: string;
    /** Cwd inherited by the children. */
    cwd: string;
    /** Whether children should also instruct the agent to call set_follow_ups. */
    enableFollowUps: boolean;
    topics: Array<{ title: string; prompt: string }>;
}

export interface BridgeSaveContextArgs {
    cwd: string;
    /** Sanitized to /^[A-Za-z0-9_-]+$/. The bridge enforces this. */
    name: string;
    body: string;
}

export interface BridgeContextResult {
    name: string;
    filePath: string;
    size: number;
}

export type BridgeSaveContextResult = BridgeContextResult;
export type BridgeUpdateContextResult = BridgeContextResult;

export interface BridgeUpdateContextArgs {
    cwd: string;
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
    }) => Promise<string>; // returns child chatId
}

function isValidContextName(name: unknown): name is string {
    return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name);
}

function contextFilePath(name: string): string {
    return `.contexts/${name}.md`;
}

export function createAgentToolBridge(deps: AgentToolBridgeDeps): AgentToolBridge {
    return {
        async spawnBranches(args: BridgeSpawnBranchesArgs): Promise<SpawnedBranch[]> {
            const result: SpawnedBranch[] = [];
            for (const t of args.topics) {
                if (!t?.title || !t?.prompt) continue;
                try {
                    const childChatId = await deps.createChild({
                        parentChatId: args.parentChatId,
                        cwd: args.cwd,
                        enableFollowUps: args.enableFollowUps,
                    });
                    result.push({ title: t.title, prompt: t.prompt, chatId: childChatId });
                    log.info("bridge", "branch child created", { parentChatId: args.parentChatId, childChatId, title: t.title });
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
            return { name: args.name, filePath, size: args.body.length };
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
            return { name: args.name, filePath, size: args.body.length };
        },
    };
}
