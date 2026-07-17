import type { MenuSection } from '../components/ContextMenu';
import type { ChatNodeState, Project } from '../state/chatStore';
import { activeTreeRootNodeId } from '../state/chatStore';

import { requestDigest } from '../lib/digestPrompt';

export interface TreeMenuActions {
  openPane: (id: string) => void;
  createBlankChild: (parentId: string) => Promise<unknown> | void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  deleteNode: (id: string) => void;
  /** Trim a single node out of the conversation, reparenting its children up.
   *  See chatStore for semantics; restore reverses via the trimSnapshot. */
  trimNode: (id: string) => void;
  /** Archive a single node (same mechanics as trim, routed to the Archived
   *  surface instead of Trash). */
  archiveNode: (id: string) => void;
  /** Merge ≥2 nodes into a new woven chat node. */
  createMergedChat: (sourceIds: string[]) => Promise<string>;
  /** Create a digest covering the given chat nodes. */
  createDigest: (projectId: string, sourceIds: string[], customPrompt?: string) => Promise<string>;
  /** Fire the export-panel toggle event. */
  openExportPanel: () => void;
  /** Archive a tree by its tree id. Used by the multi-select menu when every
   *  selected node is the root of a live tree. */
  archiveTree: (treeId: string) => void;
  /** Open the pane for the given node (called after creating a digest). */
  focusOrOpen: (id: string) => void;
  /** Begin inline rename for a node. */
  beginInlineRename?: (id: string) => void;
}

/**
 * Build the context-menu sections for a right-click on a tree row.
 *
 * `targetId` is the node that was right-clicked. If it belongs to the
 * current `selection`, the menu treats the whole selection as the target.
 * If it's outside the selection, the menu applies to the single target
 * only — even if there is a multi-selection. This matches Finder behavior.
 */
export function buildTreeContextMenu({
  targetId,
  project,
  nodes,
  selection,
  actions,
}: {
  targetId: string;
  project: Project;
  nodes: Record<string, ChatNodeState>;
  selection: ReadonlySet<string>;
  actions: TreeMenuActions;
}): MenuSection[] {
  const rootId = activeTreeRootNodeId(project) ?? project.chatIds[0];
  const targetIsSelected = selection.has(targetId);
  const scope: string[] = targetIsSelected && selection.size >= 2
    ? Array.from(selection)
    : [targetId];
  const isMulti = scope.length >= 2;
  const chatScope = scope.filter((id) => nodes[id]?.kind === 'chat');
  const anyRoot = scope.includes(rootId);

  // Map live tree-root nodeId → tree id. Used to decide whether the multi-
  // selection is "all roots" (i.e. archive-able as a batch).
  const treeIdByRoot = new Map<string, string>();
  for (const t of project.trees) {
    if (t.archivedAt) continue;
    treeIdByRoot.set(t.rootNodeId, t.id);
  }
  const allRoots = isMulti && scope.every((id) => treeIdByRoot.has(id));

  if (isMulti) {
    const sections: MenuSection[] = [
      {
        items: [
          {
            id: 'weave',
            label: `Weave ${chatScope.length} chats`,
            keys: 'W',
            disabled: chatScope.length < 2,
            run: () => {
              void actions.createMergedChat(chatScope).then((newId) => {
                actions.focusOrOpen(newId);
                actions.clearSelection();
              }).catch(() => {});
            },
          },
          {
            id: 'digest',
            label: `Digest from ${chatScope.length} chats`,
            keys: 'G',
            disabled: chatScope.length < 1,
            run: () => {
              requestDigest(project.id, chatScope);
              actions.clearSelection();
            },
          },
          {
            id: 'export',
            label: `Export ${scope.length} selected`,
            keys: 'E',
            run: actions.openExportPanel,
          },
        ],
      },
      {
        items: [
          ...(allRoots
            ? [
                {
                  id: 'archive',
                  label: `Archive ${scope.length} threads`,
                  keys: 'A',
                  run: () => {
                    for (const id of scope) {
                      const treeId = treeIdByRoot.get(id);
                      if (treeId) actions.archiveTree(treeId);
                    }
                    actions.clearSelection();
                  },
                },
              ]
            : []),
          ...(allRoots
            ? [] // all-roots is handled by "Archive N threads" above
            : [
                {
                  // Archive each selected node out of the conversation
                  // (children slide up). Active root is skipped — same
                  // protection as bulk delete.
                  id: 'archive-nodes',
                  label: anyRoot
                    ? `Archive ${scope.length} (root excluded)`
                    : `Archive ${scope.length} nodes`,
                  run: () => {
                    for (const id of scope) {
                      if (id === rootId) continue;
                      actions.archiveNode(id);
                    }
                    actions.clearSelection();
                  },
                },
              ]),
          {
            id: 'clear',
            label: 'Clear selection',
            keys: 'esc',
            run: actions.clearSelection,
          },
          {
            id: 'delete',
            label: anyRoot
              ? `Delete ${scope.length} (root excluded)`
              : `Delete ${scope.length} nodes`,
            danger: true,
            keys: 'D',
            run: () => {
              for (const id of scope) {
                if (id === rootId) continue;
                actions.deleteNode(id);
              }
              actions.clearSelection();
            },
          },
        ],
      },
    ];
    return sections;
  }

  // Single target
  const isRoot = targetId === rootId;
  const isChat = nodes[targetId]?.kind === 'chat';

  return [
    {
      items: [
        {
          id: 'open',
          label: 'Open in pane',
          keys: 'O',
          run: () => actions.openPane(targetId),
        },
        {
          id: 'rename',
          label: 'Rename…',
          keys: 'R',
          run: () => actions.beginInlineRename?.(targetId),
        },
        {
          id: 'branch',
          label: 'Branch new chat',
          keys: 'B',
          disabled: !isChat,
          run: () => {
            void Promise.resolve(actions.createBlankChild(targetId)).catch(() => {});
          },
        },
      ],
    },
    {
      items: [
        {
          id: 'select',
          label: targetIsSelected ? 'Deselect' : 'Select',
          keys: 'S',
          run: () => actions.toggleSelection(targetId),
        },
        {
          // "Trim" prunes the single node out of the conversation, sliding
          // its children up. Always allowed — the tree-root case promotes
          // the oldest live child and stays a single-rooted tree (Option A).
          id: 'trim',
          label: 'Trim node',
          keys: 'T',
          run: () => actions.trimNode(targetId),
        },
        {
          // "Archive" is trim that lands in the Archived surface (durable,
          // restorable) instead of Trash. Children slide up either way.
          id: 'archive',
          label: 'Archive node',
          keys: 'A',
          run: () => actions.archiveNode(targetId),
        },
        {
          // "Delete" sends the whole subtree to trash. Root is protected
          // because deleting the entire tree this way would leave the
          // workspace with one fewer tree silently — users who want that
          // should use "Archive thread" or empty the workspace.
          id: 'delete',
          label: isRoot ? 'Delete subtree (root protected)' : 'Delete subtree',
          danger: true,
          keys: 'D',
          disabled: isRoot,
          run: () => actions.deleteNode(targetId),
        },
      ],
    },
  ];
}
