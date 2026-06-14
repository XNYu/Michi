import type { ChatNodeState, Project } from '../state/chatStore';
import { activeTreeRootNodeId } from '../state/chatStore';
import { visibleMessageText } from '../state/assistantBlocks';
import type { DigestGenerationPayload } from '../services/digestApi';

export function buildDigestPayload(
  project: Project,
  sourceIds: string[],
  nodes: Record<string, ChatNodeState>,
  previousContent?: string,
  customPrompt?: string,
): DigestGenerationPayload {
  const rootNode = nodes[activeTreeRootNodeId(project) ?? project.chatIds[0]];
  const rootTitle =
    rootNode?.title
    ?? rootNode?.messages.find((m) => m.role === 'user')?.text.slice(0, 80)
    ?? project.name;
  const nodeList: DigestGenerationPayload['nodes'] = [];
  for (const id of sourceIds) {
    const n = nodes[id];
    if (!n || n.kind !== 'chat' || n.deletedAt) continue;
    nodeList.push({
      nodeId: n.nodeId,
      parentNodeId: n.parentNodeId,
      title: n.title,
      depth: 0,
      messages: n.messages
        .map((m) => ({
          role: m.role,
          text: visibleMessageText(m),
        }))
        .filter((m) => !!m.text),
    });
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
