import { ChatManager } from "./chatManager";
import { runExportGeneration, NodeSnapshot } from "./digestGenerator";

export interface ExportNode extends NodeSnapshot {}

export interface ExportRequest {
    workspace: { name: string; cwd?: string; createdAt: number };
    rootTitle: string;
    nodes: ExportNode[];
    cwd?: string;
    /** If present, backend filters nodes to this subset before prompting kiro. */
    nodeIds?: string[];
}

export async function summarizeWorkspace(
    chatManager: ChatManager,
    req: ExportRequest,
): Promise<string> {
    const filtered = req.nodeIds && req.nodeIds.length > 0
        ? { ...req, nodes: req.nodes.filter((n) => req.nodeIds!.includes(n.nodeId)) }
        : req;
    return runExportGeneration(chatManager, filtered);
}

export { stripScaffolding } from "./digestGenerator";
