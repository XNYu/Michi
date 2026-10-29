import { useMemo } from 'react';
import { useEmbeddedChatNode } from '../useEmbeddedChatNode';
import type { AssistantInfo } from '../../services/api/assistant';

export type AssistantNodeState = 'loading' | 'ready' | 'failed';

/** The global assistant uses the same authoritative embedded-node loader as Page Helpers. */
export function useAssistantNode(info: AssistantInfo | null): { state: AssistantNodeState; retry: () => void } {
  const workspaceId = info?.workspaceId;
  const treeId = info?.treeId;
  const nodeId = info?.nodeId;
  // Store updates and panel renders must not abort and restart an in-flight read.
  const descriptor = useMemo(() => workspaceId && nodeId ? {
    backendConnectionId: 'local',
    workspaceId,
    treeId: treeId ?? '',
    nodeId,
  } : null, [workspaceId, treeId, nodeId]);
  const result = useEmbeddedChatNode(descriptor);
  return { state: result.state, retry: result.retry };
}
