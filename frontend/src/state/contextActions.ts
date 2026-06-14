import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { reduceProject } from './chatReducers';
import type { Project } from './chatTypes';

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
        autoInject?: boolean;
        source?: 'user' | 'agent';
        size?: number;
        kind?: 'embedded' | 'reference';
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
                  size: opts?.size,
                  source: opts?.source ?? 'user',
                  autoInject: opts?.autoInject,
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
      patch: { name?: string; filePath?: string; autoInject?: boolean; size?: number },
    ) => {
      const p = projects.find((p) => p.id === activeProjectId);
      if (!p) return;
      const existing = p.contexts?.find((c) => c.id === contextId);
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
                  size: patch.size ?? existing.size,
                  autoInject: patch.autoInject ?? existing.autoInject,
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

  const toggleAutoInject = useCallback(
    (contextId: string) => {
      const p = projects.find((p) => p.id === activeProjectId);
      if (!p) return;
      setProjects((prev) =>
        prev.map((proj) =>
          proj.id === p.id
            ? reduceProject(proj, { type: 'toggle-auto-inject', projectId: p.id, contextId })
            : proj,
        ),
      );
    },
    [activeProjectId, projects, setProjects],
  );

  return {
    createContext,
    updateContext,
    deleteContext,
    toggleAutoInject,
  };
}
