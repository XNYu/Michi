import type { Project } from '../state/chatTypes';

/** Stable names for the workspace actions, for surfaces that draw their own
 *  glyph per action (the phone action sheet). */
export type WorkspaceRowActionId =
  | 'manage'
  | 'folder'
  | 'rename'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'unarchive'
  | 'delete';

export interface ContextMenuItem {
  id?: WorkspaceRowActionId;
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
  /** Ask the desktop shell to bind a different absolute folder. */
  changeFolder?: (projectId: string) => void;
  /** Ask for confirmation in the caller's own UI; without it, Delete asks
   *  through window.confirm and deletes. */
  requestDelete?: (projectId: string) => void;
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
          id: 'manage',
          label: 'Manage workspace',
          keys: 'M',
          onSelect: () => actions.openManageWorkspace(project.id),
        },
        ...(actions.changeFolder ? [{
          id: 'folder' as const,
          label: project.cwd ? 'Change folder…' : 'Link folder…',
          onSelect: () => actions.changeFolder!(project.id),
        }] : []),
      ],
    },
    {
      items: [
        {
          id: 'rename',
          label: 'Rename…',
          keys: 'R',
          onSelect: () => actions.beginInlineRename(project.id),
        },
        pinned
          ? { id: 'unpin', label: 'Unpin', keys: 'P', onSelect: () => actions.unpinProject(project.id) }
          : { id: 'pin', label: 'Pin', keys: 'P', onSelect: () => actions.pinProject(project.id) },
        archived
          ? {
              id: 'unarchive',
              label: 'Unarchive',
              keys: 'A',
              onSelect: () => actions.unarchiveProject(project.id),
            }
          : {
              id: 'archive',
              label: 'Archive',
              keys: 'A',
              onSelect: () => actions.archiveProject(project.id),
            },
      ],
    },
    {
      items: [
        {
          id: 'delete',
          label: 'Delete workspace…',
          danger: true,
          keys: 'D',
          onSelect: () => {
            if (actions.requestDelete) {
              actions.requestDelete(project.id);
              return;
            }
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
