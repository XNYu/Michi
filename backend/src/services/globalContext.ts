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
import { parseBranchOverviewEntries } from "michi-shared";

export const DISABLED_MESSAGE =
    'AI workspace tools are disabled for this workspace. Ask the user to enable "Let AI navigate this workspace" in Settings if you need to inspect the broader workspace.';

export const NO_WORKSPACE_MESSAGE =
    "No active workspace bound to this session yet.";

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

export interface ReadNodeOpts {
    role?: "user" | "assistant";
    from?: "head" | "tail";
    offset?: number;
    limit?: number;
}

type NodeInfoRow = { id: string; workspace_id: string; title: string | null; kind: string; branch_overview?: string | null };

/** Shared node lookup with cloud-mode ownership enforcement. */
function lookupNode(
    db: ReturnType<typeof getDb>,
    trimmedId: string,
    ownerUserId: string | null | undefined,
): NodeInfoRow | undefined {
    if (process.env.MICHI_CLOUD === "1" && ownerUserId) {
        return db
            .prepare(
                "SELECT n.id, n.workspace_id, n.title, n.kind, n.branch_overview FROM nodes n " +
                "JOIN workspaces w ON n.workspace_id = w.id " +
                "WHERE n.id = ? AND n.deleted_at IS NULL AND w.owner_user_id = ?",
            )
            .get(trimmedId, ownerUserId) as unknown as NodeInfoRow | undefined;
    }
    return db
        .prepare("SELECT id, workspace_id, title, kind, branch_overview FROM nodes WHERE id = ? AND deleted_at IS NULL")
        .get(trimmedId) as unknown as NodeInfoRow | undefined;
}

/** Shared access-control preamble for node-reading tools. */
function validateNodeAccess(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
): { error: ReadNodeResult } | { trimmedId: string; db: ReturnType<typeof getDb>; nodeRow: NodeInfoRow } {
    if (!sessionWorkspaceId) {
        return { error: { status: "no_workspace", text: NO_WORKSPACE_MESSAGE } };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { error: { status: "disabled", text: DISABLED_MESSAGE } };
    }
    const trimmedId = nodeId.trim();
    if (!trimmedId) {
        return { error: { status: "not_found", text: "nodeId is required." } };
    }
    const db = getDb();
    const nodeRow = lookupNode(db, trimmedId, ownerUserId);
    if (!nodeRow) {
        return { error: { status: "not_found", text: `node not found: ${trimmedId}` } };
    }
    return { trimmedId, db, nodeRow };
}

/** Apply a byte-size cap to a message array (forward walk). */
function applySizeCap(
    messages: Array<{ role: string; content: string }>,
    cap: number,
): { kept: Array<{ role: string; content: string }>; truncated: boolean } {
    const result: Array<{ role: string; content: string }> = [];
    let total = 0;
    for (const m of messages) {
        if (total + m.content.length > cap) return { kept: result, truncated: true };
        total += m.content.length;
        result.push(m);
    }
    return { kept: result, truncated: false };
}

/**
 * Read a node's branch overview journal — lightweight chronological summary.
 */
export function readNodeOverview(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
): ReadNodeResult {
    const access = validateNodeAccess(sessionWorkspaceId, ownerUserId, nodeId);
    if ("error" in access) return access.error;
    const { trimmedId, db, nodeRow } = access;

    const entries = parseBranchOverviewEntries(nodeRow.branch_overview ?? null);
    const msgRow = db
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE node_id = ? AND role IN ('user','assistant')")
        .get(trimmedId) as unknown as { cnt: number };
    const msgCount = msgRow.cnt;

    if (entries.length === 0) {
        return {
            status: "ok",
            text: `# ${nodeRow.title ?? "(untitled)"} (${trimmedId}) — ${msgCount} messages\n\nNo overview entries recorded.`,
        };
    }

    const lines = entries.map((e) => {
        const date = e.at > 0
            ? new Date(e.at).toISOString().replace("T", " ").slice(0, 19)
            : "(legacy)";
        return `[${date}] ${e.text}`;
    });

    return {
        status: "ok",
        text: `# ${nodeRow.title ?? "(untitled)"} (${trimmedId}) — ${msgCount} messages\n\n${lines.join("\n")}`,
    };
}

export function readNode(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
    opts?: ReadNodeOpts,
): ReadNodeResult {
    const access = validateNodeAccess(sessionWorkspaceId, ownerUserId, nodeId);
    if ("error" in access) return access.error;
    const { trimmedId, db, nodeRow } = access;

    const role = opts?.role;
    const from = opts?.from ?? "tail";
    const offset = Math.max(1, opts?.offset ?? 1);
    const requestedLimit = opts?.limit;
    const hasPagination = !!(opts?.role || opts?.from || opts?.offset || opts?.limit);

    // SQL query with optional role filter.
    const roleFilter = role ? " AND role = ?" : "";
    const params: Array<string> = [trimmedId];
    if (role) params.push(role);
    const messages = db
        .prepare(
            `SELECT role, content FROM messages WHERE node_id = ?` +
            ` AND role IN ('user', 'assistant')${roleFilter}` +
            ` ORDER BY seq ASC`,
        )
        .all(...params) as unknown as Array<{ role: string; content: string }>;

    const totalCount = messages.length;

    // No pagination options: preserve exact legacy tail-bias 12KB behavior.
    if (!hasPagination) {
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
        const header = `# ${nodeRow.title ?? "(untitled)"} (${trimmedId})`;
        return { status: "ok", text: `${header}\n\n${lines.join("\n\n")}` };
    }

    // Paginated mode: window determined by from + offset + limit.
    let sliced: Array<{ role: string; content: string }>;

    if (from === "head") {
        // offset 1 = first message
        const start = offset - 1;
        sliced = requestedLimit
            ? messages.slice(start, start + requestedLimit)
            : messages.slice(start);
    } else {
        // offset 1 = window ends at last message; offset 5 = window ends 4 from end
        const end = totalCount - (offset - 1);
        const start = requestedLimit ? Math.max(0, end - requestedLimit) : 0;
        sliced = messages.slice(Math.max(0, start), Math.max(0, end));
    }

    // Still apply size cap to prevent accidentally blowing context.
    const { kept, truncated } = applySizeCap(sliced, READ_NODE_SIZE_CAP);
    const lines = kept.map((m) => `${m.role}: ${m.content}`);
    if (truncated) lines.push("[remaining messages truncated by size cap]");

    const roleDesc = role ? ` (${role} only)` : "";
    const rangeDesc = from === "head"
        ? `from head, offset ${offset}, showing ${kept.length}/${totalCount}`
        : `from tail, offset ${offset}, showing ${kept.length}/${totalCount}`;
    const header = `# ${nodeRow.title ?? "(untitled)"} (${trimmedId}) — ${totalCount} messages${roleDesc}, ${rangeDesc}`;
    return { status: "ok", text: `${header}\n\n${lines.join("\n\n")}` };
}
