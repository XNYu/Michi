import type { ChatNodeState, Project } from '../state/chatTypes';
import { activeTreeRootNodeId, findTreeIdForNode } from '../state/tree';
import { digestSourceSnapshot } from './digestSource';
import type { DigestGenerationPayload } from '../services/digestApi';

export function buildDigestPayload(
  project: Project,
  sourceIds: string[],
  nodes: Record<string, ChatNodeState>,
  previousContent?: string,
  customPrompt?: string,
): DigestGenerationPayload {
  const sourceTreeId = sourceIds.map((id) => findTreeIdForNode(id, project)).find((id) => id !== null);
  const sourceRootId = project.trees.find((tree) => tree.id === sourceTreeId)?.rootNodeId;
  const rootId = sourceRootId ?? activeTreeRootNodeId(project);
  const rootNode = rootId ? nodes[rootId] : undefined;
  const rootTitle =
    rootNode?.title
    ?? rootNode?.messages.find((m) => m.role === 'user')?.text.slice(0, 80)
    ?? project.name;
  const nodeList: DigestGenerationPayload['nodes'] = [];
  for (const id of sourceIds) {
    const n = nodes[id];
    if (!n || n.kind !== 'chat' || n.deletedAt) continue;
    nodeList.push(digestSourceSnapshot(n));
  }
  return {
    workspace: { name: project.name, cwd: project.cwd, createdAt: project.createdAt },
    rootTitle,
    nodes: nodeList,
    cwd: project.cwd,
    previousContent,
    customPrompt,
  };
}
