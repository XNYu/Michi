import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { reduceProject } from './chatReducers';
import type { Project, ProjectAction } from './chatTypes';

interface UseContextActionsArgs {
  projects: Project[];
  activeProjectId: string | null;
  setProjects: Dispatch<SetStateAction<Project[]>>;
}

export function useContextActions({
  projects,
  activeProjectId,
  setProjects,
}: UseContextActionsArgs) {
  const createContext = useCallback(
    (
      name: string,
      filePath: string,
      opts?: {
        url?: string;
        type?: 'doc' | 'file' | 'image' | 'link';
        source?: 'user' | 'agent';
        size?: number;
        kind?: 'embedded' | 'reference';
        origin?: { nodeId: string; messageId?: string };
      },
    ) => {
      const p = projects.find((p) => p.id === activeProjectId);
      if (!p) return;
      setProjects((prev) =>
        prev.map((proj) =>
          proj.id === p.id
            ? reduceProject(proj, {
                type: 'upsert-context',
                projectId: p.id,
                context: {
                  name,
                  filePath,
                  url: opts?.url,
                  type: opts?.type,
                  size: opts?.size,
                  source: opts?.source ?? 'user',
                  origin: opts?.origin,
                  kind: opts?.kind,
                },
              })
            : proj,
        ),
      );
    },
    [activeProjectId, projects, setProjects],
  );

  const updateContext = useCallback(
    (
      contextId: string,
      patch: { name?: string; filePath?: string; size?: number },
    ) => {
      const p = projects.find((p) => p.id === activeProjectId);
      if (!p) return;
      const existing = p.artifacts?.find((c) => c.id === contextId);
      if (!existing) return;
      setProjects((prev) =>
        prev.map((proj) =>
          proj.id === p.id
            ? reduceProject(proj, {
                type: 'upsert-context',
                projectId: p.id,
                context: {
                  id: contextId,
                  name: patch.name ?? existing.name,
                  filePath: patch.filePath ?? existing.filePath,
                  url: existing.url,
                  type: existing.type,
                  size: patch.size ?? existing.size,
                  origin: existing.origin,
                  kind: existing.kind,
                },
              })
            : proj,
        ),
      );
    },
    [activeProjectId, projects, setProjects],
  );

  const deleteContext = useCallback(
    (contextId: string) => {
      const p = projects.find((p) => p.id === activeProjectId);
      if (!p) return;
      setProjects((prev) =>
        prev.map((proj) =>
          proj.id === p.id
            ? reduceProject(proj, { type: 'delete-context', projectId: p.id, contextId })
            : proj,
        ),
      );
    },
    [activeProjectId, projects, setProjects],
  );

  const pinContext = useCallback(
    (contextId: string) => {
      const p = projects.find((p) => p.id === activeProjectId);
      if (!p) return;
      const existing = p.artifacts?.find((c) => c.id === contextId);
      const now = Date.now();
      // Toggle: pinned → unpin, unpinned → pin.
      const action: ProjectAction = existing?.pinnedAt
        ? { type: 'unpin-context', projectId: p.id, contextId }
        : { type: 'pin-context', projectId: p.id, contextId, now };
      setProjects((prev) =>
        prev.map((proj) => (proj.id === p.id ? reduceProject(proj, action) : proj)),
      );
    },
    [activeProjectId, projects, setProjects],
  );

  return {
    createContext,
    updateContext,
    deleteContext,
    pinContext,
  };
}
