/**
 * Workspace-global "AI navigation" tools shared by Kiro (via MCP server) and
 * Pi (via in-process AgentTool). Each function returns a structured result —
 * callers wrap it into their runtime's native tool-result shape.
 *
 * The disabled / not-bound / not-found cases are returned as `kind` discriminants
 * rather than thrown errors so callers can render appropriate fallback text
 * without parsing exception messages.
 */

import { buildTopology } from "./topologyBuilder";
import { keywordSearch } from "../routes/search";
import { getDb } from "./db";
import { getAiGlobalContext } from "./dbRepository";

export const DISABLED_MESSAGE =
    'AI workspace tools are disabled for this workspace. Ask the user to enable "Let AI navigate this workspace" in Settings if you need to inspect the broader workspace.';

export const NO_WORKSPACE_MESSAGE =
    "No active workspace bound to this session yet.";

export type GlobalContextStatus = "ok" | "disabled" | "no_workspace" | "not_found";

export interface ListThreadsResult {
    status: "ok" | "disabled" | "no_workspace";
    text: string;
}

export interface SearchMessagesResult {
    status: "ok" | "disabled" | "no_workspace";
    /** Pre-formatted summary suitable for tool output. */
    text: string;
    matchCount?: number;
}

export interface ReadNodeResult {
    status: "ok" | "disabled" | "no_workspace" | "not_found";
    text: string;
}

/**
 * List trees/nodes in a workspace. Returns the buildTopology output.
 *
 * @param sessionWorkspaceId workspace the calling session is bound to (null if not yet bound).
 * @param ownerUserId        Better-Auth user id of the chat owner. When set (cloud mode) all
 *                           DB reads are scoped to this user's workspaces so an attacker who
 *                           gains chat access cannot read another user's data via this tool.
 * @param targetWorkspaceId  optional override (model passes workspaceId arg). Defaults to session.
 * @param currentNodeId      node currently in focus, marked with > YOU in the output.
 */
export function listThreads(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    targetWorkspaceId?: string,
    currentNodeId?: string,
): ListThreadsResult {
    if (!sessionWorkspaceId) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { status: "disabled", text: DISABLED_MESSAGE };
    }
    const rawWsId = targetWorkspaceId && targetWorkspaceId.length > 0
        ? targetWorkspaceId
        : sessionWorkspaceId;
    // In cloud mode verify the resolved workspace is owned by ownerUserId.
    // If an attacker passes a foreign workspaceId as targetWorkspaceId, the
    // ownership check here returns [] / no_workspace rather than leaking data.
    let wsId = rawWsId;
    if (process.env.MICHI_CLOUD === "1" && ownerUserId) {
        const db = getDb();
        const owned = db
            .prepare("SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?")
            .get(rawWsId, ownerUserId);
        if (!owned) {
            return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
        }
    }
    const out = buildTopology(getDb(), wsId, currentNodeId);
    return { status: "ok", text: out.topology };
}

/**
 * Keyword search across workspace messages.
 *
 * @param sessionWorkspaceId workspace the calling session is bound to.
 * @param ownerUserId        Better-Auth user id of the chat owner. When set (cloud mode)
 *                           all FTS results are scoped to this user's workspaces.
 * @param query              non-empty case-insensitive substring.
 * @param scope              "current" (default) restricts to session ws; "all" searches everywhere.
 * @param limit              clamped to 1..50, default 10.
 */
export function searchMessages(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    query: string,
    scope: "current" | "all" = "current",
    limit = 10,
): SearchMessagesResult {
    if (!sessionWorkspaceId) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { status: "disabled", text: DISABLED_MESSAGE };
    }
    const trimmed = query.trim();
    if (!trimmed) {
        return { status: "ok", text: "Empty query." };
    }
    const clampedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    const wsArg = scope === "all" ? undefined : sessionWorkspaceId;
    // Pass ownerUserId so keywordSearch's cloud-mode owner filter applies.
    const results = keywordSearch(trimmed, wsArg, clampedLimit, ownerUserId ?? undefined);
    if (results.length === 0) {
        return {
            status: "ok",
            text: `No matches for "${trimmed}" in ${wsArg ? "current workspace" : "all workspaces"}.`,
            matchCount: 0,
        };
    }
    const formatted = results
        .map((r) => `- [${r.workspace_name} · ${r.node_title ?? "(untitled)"}] (node: ${r.node_id}) ${r.role}: ${r.snippet}`)
        .join("\n");
    return {
        status: "ok",
        text: `Found ${results.length} match${results.length === 1 ? "" : "es"}:\n${formatted}\n\nUse read_node(nodeId) to read a specific node's transcript.`,
        matchCount: results.length,
    };
}

/**
 * Read a node's transcript with a tail-bias size cap. Tool consumers (kiro-cli,
 * Pi runtime) all share the same 12 KB ceiling — large enough for most threads,
 * conservative enough to stay under typical tool-result limits.
 */
const READ_NODE_SIZE_CAP = 12 * 1024;

export function readNode(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
): ReadNodeResult {
    if (!sessionWorkspaceId) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { status: "disabled", text: DISABLED_MESSAGE };
    }
    const trimmed = nodeId.trim();
    if (!trimmed) {
        return { status: "not_found", text: "nodeId is required." };
    }
    const db = getDb();
    // In cloud mode, JOIN through workspaces to enforce ownership. An attacker
    // cannot read another user's node by guessing its id.
    let nodeRow: { id: string; workspace_id: string; title: string | null; kind: string } | undefined;
    if (process.env.MICHI_CLOUD === "1" && ownerUserId) {
        nodeRow = db
            .prepare(
                "SELECT n.id, n.workspace_id, n.title, n.kind FROM nodes n " +
                "JOIN workspaces w ON n.workspace_id = w.id " +
                "WHERE n.id = ? AND n.deleted_at IS NULL AND w.owner_user_id = ?",
            )
            .get(trimmed, ownerUserId) as unknown as typeof nodeRow;
    } else {
        nodeRow = db
            .prepare("SELECT id, workspace_id, title, kind FROM nodes WHERE id = ? AND deleted_at IS NULL")
            .get(trimmed) as unknown as typeof nodeRow;
    }
    if (!nodeRow) {
        return { status: "not_found", text: `node not found: ${trimmed}` };
    }
    const messages = db
        .prepare("SELECT role, content FROM messages WHERE node_id = ? AND role IN ('user', 'assistant') ORDER BY seq ASC")
        .all(trimmed) as unknown as Array<{ role: string; content: string }>;

    // Tail-bias trimming: walk newest-first, keep what fits, then re-reverse for display.
    const reversed = [...messages].reverse();
    const kept: Array<{ role: string; content: string }> = [];
    let total = 0;
    let truncated = false;
    for (const m of reversed) {
        if (total + m.content.length > READ_NODE_SIZE_CAP) {
            truncated = true;
            break;
        }
        total += m.content.length;
        kept.unshift(m);
    }
    const lines = kept.map((m) => `${m.role}: ${m.content}`);
    if (truncated) lines.unshift("[earlier messages omitted]");
    const header = `# ${nodeRow.title ?? "(untitled)"} (${trimmed})`;
    return { status: "ok", text: `${header}\n\n${lines.join("\n\n")}` };
}
