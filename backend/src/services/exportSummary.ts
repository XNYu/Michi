import { ChatManager } from "./chatManager";
import { runExportGeneration, NodeSnapshot } from "./digestGenerator";
import { getDb } from "./db";

export interface ExportNode extends NodeSnapshot {}

export interface ExportRequest {
    workspace: { name: string; cwd?: string; createdAt: number };
    rootTitle: string;
    nodes: ExportNode[];
    cwd?: string;
    /** If present, backend filters nodes to this subset before prompting kiro. */
    nodeIds?: string[];
}

export function excludeUnpromotedPageHelpers(req: ExportRequest): ExportRequest {
    const ids = [...new Set(req.nodes.map((node) => node.nodeId).filter((id) => typeof id === 'string' && id.length > 0))];
    const hidden = new Set<string>();
    for (let index = 0; index < ids.length; index += 500) {
        const chunk = ids.slice(index, index + 500);
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => '?').join(',');
        const rows = getDb().prepare(`SELECT id FROM nodes WHERE page_id IS NOT NULL AND id IN (${placeholders})`).all(...chunk) as unknown as Array<{ id: string }>;
        rows.forEach((row) => hidden.add(row.id));
    }
    const ordinaryNodes = req.nodes.filter((node) => !hidden.has(node.nodeId));
    const visibleIds = new Set(ordinaryNodes.map((node) => node.nodeId));
    const selectedNodeIds = req.nodeIds?.filter((nodeId) => visibleIds.has(nodeId));
    const filtered = {
        ...req,
        nodes: ordinaryNodes,
        ...(req.nodeIds ? { nodeIds: selectedNodeIds } : {}),
    };
    if (filtered.nodeIds) {
        return { ...filtered, nodes: filtered.nodes.filter((n) => filtered.nodeIds!.includes(n.nodeId)) };
    }
    return filtered;
}

export async function summarizeWorkspace(
    chatManager: ChatManager,
    req: ExportRequest,
): Promise<string> {
    const visible = excludeUnpromotedPageHelpers(req);
    if (visible.nodes.length === 0) return '';
    return runExportGeneration(chatManager, visible);
}

export { stripScaffolding } from "./digestGenerator";
