import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { fetchTreeMessagePage, fetchTreeMessages } from '../services/api/persistence';
import { buildMessagesByNode } from './chatHydration';
import { sameTreeMessageNode } from './treeMessageRequests';
import { findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import { backendConnectionGeneration } from '../config/backendConnectionState';

export interface MessageHistoryActions {
  loadOlderMessages(nodeId: string): Promise<void>;
  ensureCompleteHistory(nodeIds: readonly string[]): Promise<Record<string, ChatNodeState>>;
}

/** Provider-scoped reads only: no durable browser mirror and no write retries. */
export function useMessageHistory(nodesRef: MutableRefObject<Record<string, ChatNodeState>>,
  projectsRef: MutableRefObject<Project[]>, dispatch: (action: ChatAction) => void,
): MessageHistoryActions {
  const reads = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  useEffect(() => () => { for (const read of reads.current.values()) read.controller.abort(); reads.current.clear(); }, []);
  const read = useCallback((key: string, work: (signal: AbortSignal) => Promise<void>) => {
    const previous = reads.current.get(key);
    if (previous) return previous.promise;
    const controller = new AbortController();
    const entry = { controller, promise: Promise.resolve() };
    reads.current.set(key, entry);
    entry.promise = work(controller.signal).finally(() => {
      if (reads.current.get(key) === entry) reads.current.delete(key);
    });
    return entry.promise;
  }, []);

  const loadOlderMessages = useCallback(async (nodeId: string) => {
    const node = nodesRef.current[nodeId];
    const project = projectsRef.current.find(item => item.id === node?.projectId);
    const treeId = project && findTreeIdForNode(nodeId, project);
    const before = node?.historyBefore;
    if (!node || !before || !project || !treeId) return;
    const connectionId = project.backendConnectionId ?? 'local';
    const generation = backendConnectionGeneration(connectionId);
    await read(JSON.stringify(['older', nodeId, before, generation]), async signal => {
      const result = await fetchTreeMessagePage(project.id, treeId, project.backendConnectionId, signal, { nodeId, before });
      if (signal.aborted) return;
      if (generation !== backendConnectionGeneration(connectionId)) throw new DOMException('Remote connection changed', 'AbortError');
      const page = result.pages?.find(item => item.nodeId === nodeId);
      if (result.pages && !page) throw new Error('The remote conversation is no longer available');
      const messages = buildMessagesByNode(result.messages)[nodeId] ?? [];
      dispatch({ type: 'history-page-loaded', nodeId, expectedBefore: before,
        before: page?.before ?? null, total: page?.total ?? messages.length, messages });
    });
  }, [dispatch, nodesRef, projectsRef, read]);

  const ensureCompleteHistory = useCallback(async (nodeIds: readonly string[]) => {
    const groups = new Map<string, { project: Project; treeId: string }>();
    for (const id of nodeIds) {
      const node = nodesRef.current[id];
      if (!node || node.messagesLoaded !== false) continue;
      const project = projectsRef.current.find(item => item.id === node.projectId);
      const treeId = project && findTreeIdForNode(id, project);
      if (project && treeId) groups.set(JSON.stringify([project.id, treeId]), { project, treeId });
    }
    // Bound history reads on a high-latency link; opening many sources must not
    // flood the shared forward or starve the active turn's event stream.
    for (const [key, { project, treeId }] of groups) {
      const connectionId = project.backendConnectionId ?? 'local';
      const generation = backendConnectionGeneration(connectionId);
      await read(`full:${key}:${generation}`, async signal => {
        const beforeNodes = new Map(project.chatIds.flatMap(id => {
          const node = nodesRef.current[id];
          return node?.messagesLoaded === false && findTreeIdForNode(id, project) === treeId ? [[id, node] as const] : [];
        }));
        const rows = await fetchTreeMessages(project.id, treeId, project.backendConnectionId, signal);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (generation !== backendConnectionGeneration(connectionId)) throw new DOMException('Remote connection changed', 'AbortError');
        const messages = buildMessagesByNode(rows);
        for (const [id, beforeNode] of beforeNodes) {
          const current = nodesRef.current[id];
          if (!current || current.messagesLoaded !== false) continue;
          if (beforeNode.historyBefore && current.historyBefore?.id === beforeNode.historyBefore.id
            && current.historyBefore.seq === beforeNode.historyBefore.seq) {
            const cursor = beforeNode.historyBefore;
            const olderRows = rows.filter(raw => {
              const row = raw as { node_id: string; seq: number; id: string };
              return row.node_id === id && (row.seq < cursor.seq || (row.seq === cursor.seq && row.id < cursor.id));
            });
            dispatch({ type: 'history-page-loaded', nodeId: id, expectedBefore: cursor, before: null,
              messages: buildMessagesByNode(olderRows)[id] ?? [], total: messages[id]?.length ?? 0 });
          } else if (sameTreeMessageNode(beforeNode, current)) {
            dispatch({ type: 'messages-loaded', nodeIds: [id], messagesByNode: { [id]: messages[id] ?? [] } });
          }
        }
      });
    }
    if (nodeIds.some(id => nodesRef.current[id]?.messagesLoaded === false)) {
      throw new Error('Conversation changed while loading history. Please try again.');
    }
    return nodesRef.current;
  }, [dispatch, nodesRef, projectsRef, read]);
  return { loadOlderMessages, ensureCompleteHistory };
}
