import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTreeMessages, fetchWorkspace } from '../services/api/persistence';
import { buildMessagesByNode } from './chatHydration';
import { useChatActions, useChatNode, useChatProjects } from './chatStore';
import type { ChatMessage } from './chatTypes';
import { findTreeIdForNode } from './tree';
import { serverEntityId } from '../config/backendIdentity';

export interface EmbeddedChatNodeDescriptor {
  backendConnectionId: string;
  workspaceId: string;
  treeId: string;
  nodeId: string;
}

export type EmbeddedChatNodeState = 'loading' | 'ready' | 'failed';

/** Loads an ordinary workspace node into the authoritative store for an embedded chat surface. */
export function useEmbeddedChatNode(descriptor: EmbeddedChatNodeDescriptor | null): {
  state: EmbeddedChatNodeState;
  retry: () => void;
  refreshWorkspace: (expectedNodeId?: string) => Promise<boolean>;
} {
  const { installWorkspaceSnapshot, dispatch } = useChatActions();
  const node = useChatNode(descriptor?.nodeId ?? '');
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const projects = useChatProjects().projects;
  const present = !!node && node.projectId === descriptor?.workspaceId;
  const placeholder = present && node?.messagesLoaded === false && !node.historyBefore;
  const project = descriptor ? projects.find((item) => item.id === descriptor.workspaceId) : undefined;
  const treeId = descriptor?.treeId || (descriptor && project ? findTreeIdForNode(descriptor.nodeId, project) : null);

  const refreshWorkspace = useCallback(async (expectedNodeId = descriptor?.nodeId): Promise<boolean> => {
    if (!descriptor) return false;
    if (!expectedNodeId) return false;
    const readStartedAt = Date.now();
    const raw = await fetchWorkspace(descriptor.workspaceId);
    const installed = installWorkspaceSnapshot(raw, readStartedAt);
    const rows = (raw as { nodes?: Array<{ id?: unknown }> } | null)?.nodes;
    const current = nodeRef.current;
    return installed && current?.nodeId === expectedNodeId && current.projectId === descriptor.workspaceId
      || Array.isArray(rows) && rows.some((row) => row?.id === serverEntityId(expectedNodeId, descriptor.backendConnectionId));
  }, [descriptor, installWorkspaceSnapshot]);

  useEffect(() => {
    if (!descriptor || present) return undefined;
    const controller = new AbortController();
    void fetchWorkspace(descriptor.workspaceId, controller.signal)
      .then((raw) => {
        if (controller.signal.aborted) return;
        const installed = installWorkspaceSnapshot(raw, Date.now());
        const rows = (raw as { nodes?: Array<{ id?: unknown }> } | null)?.nodes;
        if (!installed || nodeRef.current?.projectId !== descriptor.workspaceId) {
          if (!Array.isArray(rows) || !rows.some((row) => row?.id === serverEntityId(descriptor.nodeId, descriptor.backendConnectionId))) setFailed(true);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [descriptor, present, attempt, installWorkspaceSnapshot]);

  useEffect(() => {
    if (!descriptor || !present || !placeholder || !treeId) return undefined;
    const controller = new AbortController();
    void fetchTreeMessages(descriptor.workspaceId, treeId, descriptor.backendConnectionId === 'local' ? undefined : descriptor.backendConnectionId, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        const current = nodeRef.current;
        if (!current || current.messagesLoaded !== false || current.messages.length > 0) return;
        const byNode: Record<string, ChatMessage[]> = buildMessagesByNode(rows);
        dispatch({ type: 'messages-loaded', nodeIds: [descriptor.nodeId], messagesByNode: { [descriptor.nodeId]: byNode[descriptor.nodeId] ?? [] } });
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [descriptor, present, placeholder, treeId, attempt, dispatch]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((count) => count + 1);
  }, []);

  if (failed) return { state: 'failed', retry, refreshWorkspace };
  return { state: present && !placeholder ? 'ready' : 'loading', retry, refreshWorkspace };
}
