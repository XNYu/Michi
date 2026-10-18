import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { extractNodeTree as apiExtractNodeTree } from '../services/api';
import { buildMessagesByNode, mapTreeRow } from './chatHydration';
import { descendants, findTreeIdForNode } from './tree';
import type { ChatNodeState, Project } from './chatTypes';

export function useExtractNodeTree({
  projectsRef, activeProjectIdRef, nodesRef, commandsInFlightRef, boundSessionsRef,
  setProjects, setNodes, runWorkspaceMutation, prunePaneIds, setPaneSlot,
  setFocusedNodeId, setSelection, bumpStructureVersion, selectProject,
}: {
  projectsRef: MutableRefObject<Project[]>;
  activeProjectIdRef: MutableRefObject<string | null>;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  commandsInFlightRef: MutableRefObject<Set<string>>;
  boundSessionsRef: MutableRefObject<Set<string>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  runWorkspaceMutation: (projectId: string, mutation: () => Promise<void>) => Promise<void>;
  prunePaneIds: (ids: ReadonlySet<string>) => void;
  setPaneSlot: (projectId: string, treeId: string, panes: string[], focused: string | null) => void;
  setFocusedNodeId: Dispatch<SetStateAction<string | null>>;
  setSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  bumpStructureVersion: () => void;
  selectProject: (projectId: string) => void;
}) {
  // Keep the id after a lost response so another click retrieves the same result.
  const pendingIds = useRef(new Map<string, string>());
  return useCallback(async (nodeId: string) => {
    const node = nodesRef.current[nodeId];
    const project = projectsRef.current.find(p => p.id === node?.projectId);
    if (!node || !project || node.kind !== 'chat' || node.deletedAt || !node.parentNodeId) return;
    const sourceTreeId = findTreeIdForNode(nodeId, project);
    const sourceTree = project.trees.find(t => t.id === sourceTreeId);
    if (!sourceTree || sourceTree.rootNodeId === nodeId || sourceTree.archivedAt || project.archivedAt || project.deletedAt) return;
    const affected = descendants(nodeId, project.edges);
    affected.add(nodeId);
    let parentId: string | undefined = node.parentNodeId;
    while (parentId && !affected.has(parentId)) {
      affected.add(parentId);
      parentId = nodesRef.current[parentId]?.parentNodeId;
    }
    if ([...affected].some(id => nodesRef.current[id]?.status === 'streaming'
      || nodesRef.current[id]?.backgroundTurnAssistantId || commandsInFlightRef.current.has(id))) {
      toast.warning('Wait for replies to finish before extracting this branch.');
      return;
    }
    affected.forEach(id => commandsInFlightRef.current.add(id));
    const treeId = pendingIds.current.get(nodeId) ?? `t-${crypto.randomUUID()}`;
    pendingIds.current.set(nodeId, treeId);
    try {
      await runWorkspaceMutation(project.id, async () => {
        const result = await apiExtractNodeTree(project.id, nodeId, treeId);
        const tree = mapTreeRow(result.tree);
        if (!tree || tree.rootNodeId !== nodeId) throw new Error('Invalid extraction response');
        const messages = buildMessagesByNode(result.messages)[nodeId] ?? [];
        const current = nodesRef.current[nodeId];
        const next = { ...nodesRef.current, [nodeId]: {
          ...current, parentNodeId: undefined, messages, messagesLoaded: true,
          messageCount: messages.length, chatId: null, sessionState: undefined,
          resumeFingerprint: null,
          forkedFromNodeId: result.forkedFromNodeId ?? undefined,
          forkBoundaryMessageId: result.forkBoundaryMessageId ?? undefined,
          inheritedMessageCount: result.inheritedMessageCount ?? 0,
        } };
        nodesRef.current = next;
        bumpStructureVersion();
        setNodes(next);
        boundSessionsRef.current.delete(nodeId);
        const moved = new Set(result.nodeIds);
        setProjects(prev => prev.map(p => p.id === project.id ? {
          ...p, trees: [...p.trees.filter(t => t.id !== tree.id), tree], activeTreeId: tree.id,
          edges: p.edges.filter(e => !((!e.kind || e.kind === 'branch') && e.target === nodeId)
            && !(e.kind === 'link' && moved.has(e.source) !== moved.has(e.target))),
        } : p));
        prunePaneIds(moved);
        setPaneSlot(project.id, tree.id, [nodeId], nodeId);
        if (activeProjectIdRef.current !== project.id) selectProject(project.id);
        setFocusedNodeId(nodeId);
        setSelection(new Set());
        pendingIds.current.delete(nodeId);
      });
      toast.success('Extracted as a new thread with parent history.');
      return treeId;
    } catch (error) {
      toast.error(`Could not extract thread: ${(error as Error).message}`);
    } finally {
      affected.forEach(id => commandsInFlightRef.current.delete(id));
    }
  }, [projectsRef, activeProjectIdRef, nodesRef, commandsInFlightRef, boundSessionsRef,
    setProjects, setNodes, runWorkspaceMutation, prunePaneIds, setPaneSlot,
    setFocusedNodeId, setSelection, bumpStructureVersion, selectProject]);
}
