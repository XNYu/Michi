import type { Project } from '../chatTypes';

/**
 * Workspaces the backend creates for Michi itself carry `settings.system`
 * (today only `'assistant'`: the ⌘J assistant's conversation). They hold real
 * nodes, so panes and navigation still resolve them, but nothing that lists
 * workspaces to the user shows them.
 */
export const ASSISTANT_SYSTEM_WORKSPACE = 'assistant';

/** Reads the flag out of a workspace's settings JSON; undefined for user workspaces. */
export function parseSystemWorkspace(settings: Record<string, unknown> | null | undefined): string | undefined {
  const value = settings?.system;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function isSystemWorkspace(project: Pick<Project, 'system'> | null | undefined): boolean {
  return !!project?.system;
}

/** The user's own workspaces. Returns `projects` itself when none is a system workspace. */
export function withoutSystemWorkspaces<T extends Pick<Project, 'system'>>(projects: readonly T[]): T[] {
  return projects.some(isSystemWorkspace)
    ? projects.filter((project) => !isSystemWorkspace(project))
    : (projects as T[]);
}

export function systemWorkspaceIds(projects: readonly Pick<Project, 'id' | 'system'>[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const project of projects) if (isSystemWorkspace(project)) ids.add(project.id);
  return ids;
}
