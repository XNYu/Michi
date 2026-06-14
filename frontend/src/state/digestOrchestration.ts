import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { computeSourceFingerprint } from './digest';
import { descendants, findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';

interface UseDigestOrchestrationArgs {
  projects: Project[];
  dispatch: (action: ChatAction) => void;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  sameTree: (a: string, b: string) => boolean;
  newNodeId: () => string;
}

export function useDigestOrchestration({
  projects,
  dispatch,
  nodesRef,
  setProjects,
  setNodes,
  sameTree,
  newNodeId,
}: UseDigestOrchestrationArgs) {
  const digestAbortRef = useRef<Record<string, AbortController>>({});

  const runDigestGeneration = useCallback(
    async (nodeId: string, sources: string[], projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      const abortPrev = digestAbortRef.current[nodeId];
      if (abortPrev) abortPrev.abort();
      const ctl = new AbortController();
      digestAbortRef.current[nodeId] = ctl;
      dispatch({ type: 'digest-started', nodeId });

      const { streamDigest } = await import('../services/digestApi');
      const { buildDigestPayload } = await import('../lib/digestPayload');
      // Use the prior content snapshot (before reset) for incremental refresh.
      const previousContent = nodesRef.current[nodeId]?.digest?.content;
      const snapshot = buildDigestPayload(
        project,
        sources,
        nodesRef.current,
        previousContent,
        nodesRef.current[nodeId]?.digest?.customPrompt,
      );
      try {
        const markdown = await streamDigest(snapshot, {
          signal: ctl.signal,
          onChunk: (text) => {
            if (ctl.signal.aborted) return;
            dispatch({ type: 'digest-chunk', nodeId, text });
          },
        });
        if (ctl.signal.aborted) return;
        const fps: Record<string, string> = {};
        for (const sid of sources) {
          const src = nodesRef.current[sid];
          if (src) fps[sid] = computeSourceFingerprint(src);
        }
        dispatch({
          type: 'digest-generated',
          nodeId,
          content: markdown,
          sourceFingerprints: fps,
          generatedAt: Date.now(),
          sources,
        });
        const h1 = markdown.match(/^#\s+(.+)$/m);
        if (h1) {
          dispatch({ type: 'set-title', nodeId, title: h1[1].trim() });
        }
      } catch (err: any) {
        if (ctl.signal.aborted) return;
        dispatch({ type: 'digest-error', nodeId, message: err?.message || 'digest failed' });
      } finally {
        if (digestAbortRef.current[nodeId] === ctl) {
          delete digestAbortRef.current[nodeId];
        }
      }
    },
    [dispatch, nodesRef, projects],
  );

  const createDigest = useCallback(
    async (projectId: string, sources: string[], customPrompt?: string) => {
      for (let i = 1; i < sources.length; i++) {
        if (!sameTree(sources[0], sources[i])) {
          toast.error('Cannot digest nodes from different threads.');
          throw new Error('cross-tree digest');
        }
      }
      const nodeId = newNodeId();
      dispatch({ type: 'create-digest', nodeId, projectId, sources });
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, nodeId],
                // Only digest-source edges — no branch edge — so the digest
                // node lives outside the conversation tree (and therefore
                // stays out of the structure view).
                edges: [
                  ...p.edges,
                  ...sources.map((src) => ({
                    source: src,
                    target: nodeId,
                    kind: 'digest-source' as const,
                  })),
                ],
              }
            : p,
        ),
      );
      if (customPrompt) {
        dispatch({ type: 'digest-set-prompt', nodeId, customPrompt });
      }
      void runDigestGeneration(nodeId, sources, projectId);
      return nodeId;
    },
    [dispatch, newNodeId, runDigestGeneration, sameTree, setProjects],
  );

  const refreshDigest = useCallback(
    async (nodeId: string) => {
      const node = nodesRef.current[nodeId];
      if (!node || node.kind !== 'digest' || !node.digest) return;
      const project = projects.find((p) => p.id === node.projectId);
      // Recompute sources from the originating tree so chats branched after
      // the digest was first generated are included in the rebuild. Falls
      // back to the saved sources snapshot when the tree can't be resolved
      // (e.g. all original sources have been deleted).
      let sources = node.digest.sources;
      if (project) {
        const isAlive = (id: string) => {
          const n = nodesRef.current[id];
          return !!n && !n.deletedAt;
        };
        const anchor = node.digest.sources.find((sid) => isAlive(sid));
        const treeId = anchor ? findTreeIdForNode(anchor, project) : null;
        const tree = treeId ? project.trees.find((t) => t.id === treeId) : null;
        if (tree && isAlive(tree.rootNodeId)) {
          const descIds = descendants(tree.rootNodeId, project.edges, isAlive);
          const treeChatIds = [tree.rootNodeId, ...descIds].filter((id) => {
            const n = nodesRef.current[id];
            return !!n && n.kind === 'chat' && !n.deletedAt;
          });
          if (treeChatIds.length > 0) sources = treeChatIds;
        }
      }
      await runDigestGeneration(nodeId, sources, node.projectId);
    },
    [nodesRef, projects, runDigestGeneration],
  );

  const setDigestPrompt = useCallback(
    (nodeId: string, customPrompt: string) => {
      dispatch({ type: 'digest-set-prompt', nodeId, customPrompt });
    },
    [dispatch],
  );

  const markDigestViewed = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current[nodeId];
      if (!node || node.kind !== 'digest' || !node.digest) return;
      dispatch({ type: 'digest-viewed', nodeId, viewedAt: Date.now() });
    },
    [dispatch, nodesRef],
  );

  const deleteDigest = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current[nodeId];
      if (!node || node.kind !== 'digest') return;
      digestAbortRef.current[nodeId]?.abort();
      delete digestAbortRef.current[nodeId];
      setProjects((prev) =>
        prev.map((p) =>
          p.chatIds.includes(nodeId)
            ? {
                ...p,
                chatIds: p.chatIds.filter((id) => id !== nodeId),
                edges: p.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
              }
            : p,
        ),
      );
      const next = { ...nodesRef.current };
      delete next[nodeId];
      nodesRef.current = next;
      setNodes(next);
    },
    [nodesRef, setNodes, setProjects],
  );

  return {
    createDigest,
    refreshDigest,
    setDigestPrompt,
    markDigestViewed,
    deleteDigest,
  };
}
