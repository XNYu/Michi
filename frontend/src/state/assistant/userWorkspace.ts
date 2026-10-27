import { useEffect } from 'react';
import type { Project } from '../chatTypes';
import { isSystemWorkspace } from './systemWorkspace';

/**
 * The user's workspace to come back to while the assistant's hidden one is
 * active (its conversation opened as a pane): New thread, Home and the
 * thread views (Overview, Map, Digest) return here instead of acting on, or
 * showing, the assistant's workspace.
 */
let remembered: string | null = null;

const isLiveUserWorkspace = (project: Project | null | undefined): project is Project => !!project
  && !project.deletedAt
  && !project.archivedAt
  && !isSystemWorkspace(project);

/** Note the active workspace; only the user's own ones count. */
export function rememberUserWorkspace(project: Project | null | undefined): void {
  if (isLiveUserWorkspace(project)) remembered = project.id;
}

/** The last user workspace that was active, else the first live one; null when there is none. */
export function userWorkspaceToReturnTo(projects: readonly Project[]): string | null {
  const live = projects.filter(isLiveUserWorkspace);
  return live.find((project) => project.id === remembered)?.id ?? live[0]?.id ?? null;
}

/**
 * While `enabled` and the active workspace is a system one, select the
 * workspace to return to. Pages that act on the active workspace call it.
 */
export function useReturnFromSystemWorkspace(
  enabled: boolean,
  activeProject: Project | null | undefined,
  projects: readonly Project[],
  selectProject: (projectId: string) => void,
): void {
  const inSystem = enabled && isSystemWorkspace(activeProject);
  const target = inSystem ? userWorkspaceToReturnTo(projects) : null;
  useEffect(() => {
    if (target) selectProject(target);
  }, [target, selectProject]);
}

/** Test seam. */
export function resetUserWorkspaceForTests(): void {
  remembered = null;
}
