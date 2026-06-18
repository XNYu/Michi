import type { Project } from '../state/chatTypes';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Single-letter keyboard accelerator (e.g. 'R'); displayed in the chip. */
  keys?: string;
}
export interface ContextMenuSection {
  items: ContextMenuItem[];
}

export interface WorkspaceRowActions {
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  /** Flip the workspace row into inline-rename mode. Implemented by the UI. */
  beginInlineRename: (projectId: string) => void;
  /** Open the Workspace Manage page for the given workspace id. */
  openManageWorkspace: (projectId: string) => void;
}

export interface BuildWorkspaceRowArgs {
  project: Project;
  actions: WorkspaceRowActions;
}

export function buildWorkspaceRowContextMenu(
  args: BuildWorkspaceRowArgs,
): ContextMenuSection[] {
  const { project, actions } = args;
  const archived = !!project.archivedAt;
  const pinned = !!project.pinnedAt;
  return [
    {
      items: [
        {
          label: 'Manage workspace',
          keys: 'M',
          onSelect: () => actions.openManageWorkspace(project.id),
        },
      ],
    },
    {
      items: [
        {
          label: 'Rename…',
          keys: 'R',
          onSelect: () => actions.beginInlineRename(project.id),
        },
        pinned
          ? { label: 'Unpin', keys: 'P', onSelect: () => actions.unpinProject(project.id) }
          : { label: 'Pin', keys: 'P', onSelect: () => actions.pinProject(project.id) },
        archived
          ? {
              label: 'Unarchive',
              keys: 'A',
              onSelect: () => actions.unarchiveProject(project.id),
            }
          : {
              label: 'Archive',
              keys: 'A',
              onSelect: () => actions.archiveProject(project.id),
            },
      ],
    },
    {
      items: [
        {
          label: 'Delete workspace…',
          danger: true,
          keys: 'D',
          onSelect: () => {
            if (
              window.confirm(
                `Delete "${project.name}" and all its threads? You can restore it from Trash.`,
              )
            ) {
              actions.deleteProject(project.id);
            }
          },
        },
      ],
    },
  ];
}
