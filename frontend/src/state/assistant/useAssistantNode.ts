import { useEmbeddedChatNode } from '../useEmbeddedChatNode';
import type { AssistantInfo } from '../../services/api/assistant';

export type AssistantNodeState = 'loading' | 'ready' | 'failed';

/** The global assistant uses the same authoritative embedded-node loader as Page Helpers. */
export function useAssistantNode(info: AssistantInfo | null): { state: AssistantNodeState; retry: () => void } {
  const result = useEmbeddedChatNode(info ? {
    backendConnectionId: 'local',
    workspaceId: info.workspaceId,
    treeId: info.treeId,
    nodeId: info.nodeId,
  } : null);
  return { state: result.state, retry: result.retry };
}
