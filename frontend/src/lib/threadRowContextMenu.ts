import type { Tree } from '../state/chatStore';

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
  /** Optional section header (small uppercase label rendered above items). */
  label?: string;
}

export interface ThreadRowActions {
  activateTree: (id: string) => void;
  archiveTree: (id: string) => void;
  unarchiveTree: (id: string) => void;
  pinTree?: (id: string) => void;
  unpinTree?: (id: string) => void;
  renameTree: (id: string, name: string) => void;
  deleteTree: (id: string) => void;
  exportTree: (id: string) => void;
  /** Flip the thread row into inline-rename mode. Implemented by the UI. */
  beginInlineRename?: (id: string) => void;
  /** Move this thread to another workspace. Omit when no other workspace is
   *  available (the menu item is dropped). The picker UI lives elsewhere —
   *  this callback is invoked once the user has chosen a target. */
  moveToWorkspace?: (targetProjectId: string) => void;
  /** Open the move-to-workspace picker dialog. When omitted (or no targets
   *  are available) the menu item is dropped. */
  openMoveDialog?: () => void;
}

/** Workspace eligible as a move destination — anything live (not the current
 *  one, not archived, not deleted). The UI is responsible for filtering. */
export interface MoveTargetWorkspace {
  id: string;
  name: string;
}

export interface BuildThreadRowArgs {
  treeId: string;
  tree: Tree;
  actions: ThreadRowActions;
  /** Other workspaces this thread can be moved to. When empty or absent the
   *  "Move to workspace" section is omitted. */
  moveTargets?: readonly MoveTargetWorkspace[];
  /** Current multi-selection of tree IDs. When the right-clicked tree is in
   *  this set and the set has ≥2 members, the menu shows batch actions for
   *  the entire selection (matching Finder / treeContextMenu behavior). */
  treeSelection?: ReadonlySet<string>;
  /** Callback to clear the selection after a batch action completes. */
  clearTreeSelection?: () => void;
}

export function buildThreadRowContextMenu(args: BuildThreadRowArgs): ContextMenuSection[] {
  const { treeId, tree, actions, moveTargets, treeSelection, clearTreeSelection } = args;

  // Multi-select path: if the right-clicked tree is in the selection and there
  // are ≥2 selected, show batch operations on the whole selection.
  const targetIsSelected = treeSelection?.has(treeId) ?? false;
  const isMulti = targetIsSelected && (treeSelection?.size ?? 0) >= 2;

  if (isMulti) {
    const scope = Array.from(treeSelection!);
    const count = scope.length;
    const sections: ContextMenuSection[] = [
      {
        items: [
          {
            label: `Archive ${count} threads`,
            keys: 'A',
            onSelect: () => {
              for (const id of scope) actions.archiveTree(id);
              clearTreeSelection?.();
            },
          },
          {
            label: `Export ${count} threads…`,
            keys: 'E',
            onSelect: () => {
              for (const id of scope) actions.exportTree(id);
              clearTreeSelection?.();
            },
          },
        ],
      },
      {
        items: [
          {
            label: 'Clear selection',
            keys: 'esc',
            onSelect: () => clearTreeSelection?.(),
          },
          {
            label: `Delete ${count} threads…`,
            danger: true,
            keys: 'D',
            onSelect: () => {
              if (window.confirm(`Move ${count} threads to trash?`)) {
                for (const id of scope) actions.deleteTree(id);
                clearTreeSelection?.();
              }
            },
          },
        ],
      },
    ];
    return sections;
  }

  // Single-target path (original behavior).
  const archived = !!tree.archivedAt;
  const pinned = !!tree.pinnedAt;
  const items: ContextMenuItem[] = [
    {
      label: 'Rename…',
      keys: 'R',
      onSelect: () => {
        if (actions.beginInlineRename) actions.beginInlineRename(treeId);
      },
    },
  ];
  if (actions.pinTree && actions.unpinTree) {
    items.push(
      pinned
        ? { label: 'Unpin', keys: 'P', onSelect: () => actions.unpinTree!(treeId) }
        : { label: 'Pin', keys: 'P', onSelect: () => actions.pinTree!(treeId) },
    );
  }
  items.push(
    archived
      ? { label: 'Unarchive', keys: 'A', onSelect: () => actions.unarchiveTree(treeId) }
      : { label: 'Archive', keys: 'A', onSelect: () => actions.archiveTree(treeId) },
    { label: 'Export this thread…', keys: 'E', onSelect: () => actions.exportTree(treeId) },
  );
  const sections: ContextMenuSection[] = [{ items }];

  if (moveTargets && moveTargets.length > 0 && actions.openMoveDialog) {
    sections[0].items.push({
      label: 'Move to workspace…',
      keys: 'M',
      onSelect: () => actions.openMoveDialog!(),
    });
  }

  sections.push({
    items: [
      {
        label: 'Delete thread…',
        danger: true,
        keys: 'D',
        onSelect: () => {
          if (window.confirm('Move this thread to trash?')) {
            actions.deleteTree(treeId);
          }
        },
      },
    ],
  });
  return sections;
}
