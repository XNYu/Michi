import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import {
  deleteWorkspace,
  moveTreeToWorkspace as apiMoveTreeToWorkspace,
} from '../services/api';
import { getElectron } from '../lib/electronBridge';
import { reduceProject } from './chatReducers';
import { descendants } from './tree';
import type { ChatAction, ChatNodeState, FolderEntry, Project } from './chatTypes';
import type { Prefs } from './prefs';

type PaneUpdater<T> = T | ((prev: T) => T);
type PaneSetter<T> = (updater: PaneUpdater<T>) => void;

interface UseProjectActionsArgs {
  projects: Project[];
  activeProjectId: string | null;
  chatsWorkspaceId: string;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
}

export function useProjectActions({
  projects,
  activeProjectId,
  chatsWorkspaceId,
  nodesRef,
  setProjects,
  setActiveProjectId,
  setNodes,
}: UseProjectActionsArgs) {
  const createProject = useCallback(
    async (name?: string, cwd?: string, initFolders?: FolderEntry[]) => {
      const projectId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const finalName = (name && name.trim()) || nextUntitledName(projects);
      const now = Date.now();

      let resolvedCwd = cwd;
      if (!resolvedCwd) {
        const electron = getElectron();
        if (electron?.resolveSkipCwd) {
          try {
            const r = await electron.resolveSkipCwd(projectId);
            resolvedCwd = r.path;
          } catch {
            // Fall through to undefined; backend will use process.cwd().
          }
        }
      }

      // If dialog provided full folder list, use it directly; otherwise synthesize from cwd
      const folders: FolderEntry[] = initFolders && initFolders.length > 0
        ? initFolders
        : resolvedCwd
          ? [{ id: projectId.slice(0, 16), path: resolvedCwd, addedAt: now }]
          : [];

      const project: Project = {
        id: projectId,
        name: finalName,
        cwd: resolvedCwd,
        folders,
        chatIds: [],
        edges: [],
        createdAt: now,
        trees: [],
        activeTreeId: null,
        artifacts: [],
      };
      setProjects((prev) => [project, ...prev]);
      setActiveProjectId(projectId);
      return projectId;
    },
    [projects, setActiveProjectId, setProjects],
  );

  const enterChatsWorkspace = useCallback(async () => {
    const now = Date.now();
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === chatsWorkspaceId);
      if (existing) {
        return prev.map((p) => {
          if (p.id !== chatsWorkspaceId) return p;
          const { archivedAt, deletedAt, ...rest } = p;
          return rest as Project;
        });
      }
      const fresh: Project = {
        id: chatsWorkspaceId,
        name: 'Chats',
        cwd: undefined,
        folders: [],
        chatIds: [],
        edges: [],
        createdAt: now,
        trees: [],
        activeTreeId: null,
        artifacts: [],
      };
      return [fresh, ...prev];
    });
    setActiveProjectId(chatsWorkspaceId);
    return chatsWorkspaceId;
  }, [chatsWorkspaceId, setActiveProjectId, setProjects]);

  const renameProject = useCallback((projectId: string, name: string) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, name } : p)));
  }, [setProjects]);

  const setProjectCwd = useCallback((projectId: string, cwd: string) => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setProjects((prev) => prev.map((p) => (
      p.id === projectId && p.cwd !== trimmed ? { ...p, cwd: trimmed } : p
    )));
  }, [setProjects]);

  const addFolder = useCallback((projectId: string, folderPath: string, label?: string) => {
    const resolved = folderPath.trim();
    if (!resolved) return;
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      if (existing.length >= 10) return p; // hard limit
      // Nesting check
      const hasNesting = existing.some(
        (f) => resolved.startsWith(f.path + '/') || resolved === f.path || f.path.startsWith(resolved + '/'),
      );
      if (hasNesting) {
        // Schedule toast outside reducer (safe: setState is batched)
        setTimeout(() => toast.error('This folder overlaps with an existing folder (nested or parent)'), 0);
        return p;
      }
      const entry: FolderEntry = {
        id: Math.random().toString(36).slice(2, 10),
        path: resolved,
        label,
        addedAt: Date.now(),
      };
      return { ...p, folders: [...existing, entry] };
    }));
  }, [setProjects]);

  const removeFolder = useCallback((projectId: string, folderId: string) => {
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      // Cannot remove folders[0] (the cwd)
      if (existing.length > 0 && existing[0].id === folderId) return p;
      return { ...p, folders: existing.filter((f) => f.id !== folderId) };
    }));
  }, [setProjects]);

  const updateFolderLabel = useCallback((projectId: string, folderId: string, label: string) => {
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      return {
        ...p,
        folders: existing.map((f) => f.id === folderId ? { ...f, label } : f),
      };
    }));
  }, [setProjects]);

  const setProjectInstructions = useCallback(
    (projectId: string, instructions: string) => {
      const next = instructions.length > 0 ? instructions : undefined;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          if (p.instructions === next) return p;
          if (next === undefined) {
            const { instructions: _omit, ...rest } = p;
            return rest as Project;
          }
          return { ...p, instructions: next };
        }),
      );
    },
    [setProjects],
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        const next = prev.map((p) =>
          p.id === projectId ? { ...p, deletedAt: Date.now() } : p,
        );
        if (activeProjectId === projectId) {
          const live = next.find(
            (p) => !p.deletedAt && !p.archivedAt && p.id !== projectId,
          );
          setActiveProjectId(live?.id ?? null);
        }
        return next;
      });
    },
    [activeProjectId, setActiveProjectId, setProjects],
  );

  const restoreProject = useCallback((projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const { deletedAt, ...rest } = p;
        return rest as Project;
      }),
    );
  }, [setProjects]);

  const archiveProject = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        const next = prev.map((p) =>
          p.id === projectId ? { ...p, archivedAt: Date.now() } : p,
        );
        if (activeProjectId === projectId) {
          const live = next.find(
            (p) => !p.deletedAt && !p.archivedAt && p.id !== projectId,
          );
          setActiveProjectId(live?.id ?? null);
        }
        return next;
      });
    },
    [activeProjectId, setActiveProjectId, setProjects],
  );

  const unarchiveProject = useCallback((projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const { archivedAt, ...rest } = p;
        return rest as Project;
      }),
    );
  }, [setProjects]);

  const purgeProject = useCallback((projectId: string): Promise<void> => {
    const dead = projects.find((p) => p.id === projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (dead) {
      const next = { ...nodesRef.current };
      for (const nid of dead.chatIds) delete next[nid];
      nodesRef.current = next;
      setNodes(next);
    }
    // Returns the deletion Promise so Empty Trash can await all in-flight
    // workspace deletes before clearing local state and re-enabling sync.
    // Callers that don't care (legacy fire-and-forget UI) ignore the Promise;
    // log on failure for both paths.
    return deleteWorkspace(projectId).catch((err) => {
      console.warn('deleteWorkspace failed:', err);
      throw err;
    });
  }, [nodesRef, projects, setNodes, setProjects]);

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
  }, [setActiveProjectId]);

  return {
    createProject,
    enterChatsWorkspace,
    renameProject,
    setProjectCwd,
    addFolder,
    removeFolder,
    updateFolderLabel,
    setProjectInstructions,
    deleteProject,
    restoreProject,
    purgeProject,
    archiveProject,
    unarchiveProject,
    selectProject,
  };
}

interface UseTreeActionsArgs {
  projects: Project[];
  activeProjectId: string | null;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  cancelFns: MutableRefObject<Record<string, () => void>>;
  dispatch: (action: ChatAction) => void;
  newNodeId: () => Promise<string>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  setOpenPanes: PaneSetter<string[]>;
  setFocusedPane: PaneSetter<string | null>;
  setPaneSlot: (projectId: string, treeId: string, panes: string[], focused: string | null) => void;
  ensurePaneSlot: (projectId: string, treeId: string, rootNodeId: string) => void;
  setFocusedNodeId: Dispatch<SetStateAction<string | null>>;
  setSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  treeSelection: ReadonlySet<string>;
  setTreeSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  sidebarExpanded: Prefs['sidebarExpanded'];
  setSidebarExpanded: (value: Prefs['sidebarExpanded']) => void;
}

export function useTreeActions({
  projects,
  activeProjectId,
  nodesRef,
  cancelFns,
  dispatch,
  newNodeId,
  setProjects,
  setNodes,
  setOpenPanes,
  setFocusedPane,
  setPaneSlot,
  ensurePaneSlot,
  setFocusedNodeId,
  setSelection,
  treeSelection,
  setTreeSelection,
  sidebarExpanded,
  setSidebarExpanded,
}: UseTreeActionsArgs) {
  const createThread = useCallback(async (modeId?: string) => {
    if (!activeProjectId) return null;
    const nodeId = await newNodeId();
    const treeId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    dispatch({ type: 'create', nodeId, projectId: activeProjectId, modeId });
    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? reduceProject(p, { type: 'create-tree', treeId, rootNodeId: nodeId, now })
          : p,
      ),
    );
    setPaneSlot(activeProjectId, treeId, [nodeId], nodeId);
    setFocusedNodeId(nodeId);
    if (sidebarExpanded.workspaces[activeProjectId] === false) {
      setSidebarExpanded({
        ...sidebarExpanded,
        workspaces: {
          ...sidebarExpanded.workspaces,
          [activeProjectId]: true,
        },
      });
    }
    return nodeId;
  }, [
    activeProjectId,
    dispatch,
    newNodeId,
    setFocusedNodeId,
    setPaneSlot,
    setProjects,
    setSidebarExpanded,
    sidebarExpanded,
  ]);

  const isTreeStreaming = useCallback(
    (project: Project, treeId: string) => {
      const tree = project.trees.find((t) => t.id === treeId);
      if (!tree) return false;
      const rootIdsInTree = [tree.rootNodeId, ...Array.from(descendants(tree.rootNodeId, project.edges))];
      for (const id of rootIdsInTree) {
        if (nodesRef.current[id]?.status === 'streaming') return true;
      }
      return false;
    },
    [nodesRef],
  );

  const archiveTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      if (isTreeStreaming(project, treeId)) {
        toast.warning('Stop streaming nodes in this thread before archiving.');
        return;
      }
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'archive-tree', treeId, now: Date.now() }) : p,
        ),
      );
    },
    [isTreeStreaming, projects, setProjects],
  );

  const unarchiveTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'unarchive-tree', treeId, now: Date.now() }) : p,
        ),
      );
    },
    [projects, setProjects],
  );

  const pinTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'pin-tree', treeId, now: Date.now() }) : p,
        ),
      );
    },
    [projects, setProjects],
  );

  const unpinTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'unpin-tree', treeId }) : p,
        ),
      );
    },
    [projects, setProjects],
  );

  const pinProject = useCallback(
    (projectId: string) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, pinnedAt: Date.now() } : p)),
      );
    },
    [setProjects],
  );

  const unpinProject = useCallback(
    (projectId: string) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const { pinnedAt, ...rest } = p;
          return rest as typeof p;
        }),
      );
    },
    [setProjects],
  );

  const renameTree = useCallback(
    (treeId: string, name: string, targetProjectId?: string) => {
      const projectId = targetProjectId ?? activeProjectId;
      const trimmed = name.trim();
      if (!projectId || !trimmed) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId && p.trees.some((t) => t.id === treeId)
            ? reduceProject(p, { type: 'rename-tree', treeId, name: trimmed })
            : p,
        ),
      );
    },
    [activeProjectId, setProjects],
  );

  const activateTree = useCallback(
    (treeId: string, targetProjectId?: string) => {
      const projectId = targetProjectId ?? activeProjectId;
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      const tree = project.trees.find((t) => t.id === treeId);
      if (!tree) return;
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? reduceProject(p, { type: 'activate-tree', treeId }) : p)),
      );
      ensurePaneSlot(project.id, treeId, tree.rootNodeId);
      if (project.id === activeProjectId) setFocusedNodeId(tree.rootNodeId);

      // Mark all nodes in the activated tree as read so the thread-level
      // unread badge clears even when child branches completed while unfocused.
      const now = Date.now();
      const allIds = descendants(tree.rootNodeId, project.edges);
      allIds.add(tree.rootNodeId);
      for (const nid of allIds) {
        const node = nodesRef.current[nid];
        if (node && (node.lastAssistantAt ?? 0) > (node.viewedAt ?? 0)) {
          dispatch({ type: 'node-viewed', nodeId: nid, viewedAt: now });
        }
      }
    },
    [activeProjectId, dispatch, ensurePaneSlot, nodesRef, projects, setFocusedNodeId, setProjects],
  );

  const deleteTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      if (isTreeStreaming(project, treeId)) {
        toast.warning('Stop streaming nodes in this thread before deleting.');
        return;
      }
      const tree = project.trees.find((t) => t.id === treeId);
      if (!tree) return;
      const liveEdges = project.edges.filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      );
      const doomed = descendants(tree.rootNodeId, liveEdges);
      doomed.add(tree.rootNodeId);
      doomed.forEach((id) => cancelFns.current[id]?.());

      const gid = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const at = Date.now();
      const nextNodes = { ...nodesRef.current };
      doomed.forEach((id) => {
        const cur = nextNodes[id];
        if (!cur) return;
        nextNodes[id] = { ...cur, deletedAt: at, deletionGroupId: gid };
      });
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== project.id) return p;
          if (p.activeTreeId !== treeId) return { ...p };
          const fallback = p.trees
            .filter((t) => t.id !== treeId && !t.archivedAt && !nextNodes[t.rootNodeId]?.deletedAt)
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
          return { ...p, activeTreeId: fallback ? fallback.id : null };
        }),
      );

      setOpenPanes((prev) => prev.filter((id) => !doomed.has(id)));
      setFocusedPane((cur) => (cur && doomed.has(cur) ? null : cur));
      setFocusedNodeId((cur) => (cur && doomed.has(cur) ? null : cur));
      setSelection((prev) => {
        if (![...doomed].some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        doomed.forEach((id) => next.delete(id));
        return next;
      });
    },
    [
      cancelFns,
      isTreeStreaming,
      nodesRef,
      projects,
      setFocusedNodeId,
      setFocusedPane,
      setNodes,
      setOpenPanes,
      setProjects,
      setSelection,
    ],
  );

  const moveTreeToWorkspace = useCallback(
    async (treeId: string, targetProjectId: string) => {
      const source = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!source) return;
      if (source.id === targetProjectId) return;
      const target = projects.find((p) => p.id === targetProjectId);
      if (!target) {
        toast.error('Target workspace not found.');
        return;
      }
      if (isTreeStreaming(source, treeId)) {
        toast.warning('Stop streaming nodes in this thread before moving.');
        return;
      }
      const tree = source.trees.find((t) => t.id === treeId);
      if (!tree) return;

      const liveEdges = source.edges.filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      );
      const moving = descendants(tree.rootNodeId, liveEdges);
      moving.add(tree.rootNodeId);

      try {
        await apiMoveTreeToWorkspace(treeId, source.id, target.id);
      } catch (err) {
        toast.error(`Move failed: ${(err as Error).message}`);
        return;
      }

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id === source.id) {
            const trees = p.trees.filter((t) => t.id !== treeId);
            const chatIds = p.chatIds.filter((id) => !moving.has(id));
            const edges = p.edges.filter(
              (e) => !moving.has(e.source) && !moving.has(e.target),
            );
            let activeTreeId = p.activeTreeId;
            if (activeTreeId === treeId) {
              const fallback = trees
                .filter((t) => !t.archivedAt && !nodesRef.current[t.rootNodeId]?.deletedAt)
                .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
              activeTreeId = fallback ? fallback.id : null;
            }
            return { ...p, trees, chatIds, edges, activeTreeId };
          }
          if (p.id === target.id) {
            const trees = [...p.trees, tree];
            const chatIds = [...p.chatIds, ...Array.from(moving).filter((id) => !p.chatIds.includes(id))];
            const movingEdges = source.edges.filter(
              (e) => moving.has(e.source) && moving.has(e.target),
            );
            const edges = [...p.edges, ...movingEdges];
            return { ...p, trees, chatIds, edges };
          }
          return p;
        }),
      );

      const nextNodes = { ...nodesRef.current };
      moving.forEach((id) => {
        const cur = nextNodes[id];
        if (!cur) return;
        nextNodes[id] = { ...cur, projectId: target.id };
      });
      nodesRef.current = nextNodes;
      setNodes(nextNodes);

      toast.success(`Moved thread to ${target.name || 'workspace'}.`);
    },
    [isTreeStreaming, nodesRef, projects, setNodes, setProjects],
  );

  const bulkArchiveTrees = useCallback(() => {
    treeSelection.forEach((id) => archiveTree(id));
    setTreeSelection(new Set());
  }, [archiveTree, setTreeSelection, treeSelection]);

  const bulkDeleteTrees = useCallback(() => {
    treeSelection.forEach((id) => deleteTree(id));
    setTreeSelection(new Set());
  }, [deleteTree, setTreeSelection, treeSelection]);

  const bulkUnarchiveTrees = useCallback(() => {
    treeSelection.forEach((id) => unarchiveTree(id));
    setTreeSelection(new Set());
  }, [setTreeSelection, treeSelection, unarchiveTree]);

  return {
    createThread,
    archiveTree,
    unarchiveTree,
    pinTree,
    unpinTree,
    pinProject,
    unpinProject,
    renameTree,
    activateTree,
    deleteTree,
    moveTreeToWorkspace,
    bulkArchiveTrees,
    bulkDeleteTrees,
    bulkUnarchiveTrees,
  };
}

function nextUntitledName(existing: readonly Project[]): string {
  const taken = new Set<number>();
  for (const p of existing) {
    if (p.deletedAt) continue;
    const m = /^Untitled-(\d+)$/.exec(p.name);
    if (m) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `Untitled-${n}`;
}
