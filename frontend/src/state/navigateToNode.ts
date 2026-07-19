import type { Project } from './chatTypes';
import { findTreeIdForNode } from './tree';

export interface NavigateToNodeDeps {
  projects: Project[];
  activeProjectId: string | null;
  selectProject: (projectId: string) => void;
  openPane: (nodeId: string) => void;
  openPaneInTree: (projectId: string, treeId: string, nodeId: string) => void;
  activateTree: (treeId: string, targetProjectId?: string) => void;
  setFocusedNodeId: (nodeId: string | null) => void;
}

/**
 * Open `nodeId`'s pane wherever it lives — switching workspace and/or thread
 * when needed — and land both the focused pane and the sidebar focus on it,
 * so the sidebar reveal effect (WorkspaceTree) expands down to its row.
 *
 * Whenever the destination differs from the current slot (different workspace
 * OR different thread), the pane is seeded via `openPaneInTree` BEFORE the
 * switch: `openPane` writes through the still-active paneKey, so calling it
 * around `selectProject`/`activateTree` (state updates that haven't committed
 * yet) drops the pane into the OLD slot, and the workspace-switch auto-open
 * effect then focuses the destination tree's root instead of the target node.
 * Same stale-slot family as the cross-tree bug fixed in CommandPalette
 * (9c13635), which left the cross-workspace → active-tree path broken.
 */
export function navigateToNode(
  deps: NavigateToNodeDeps,
  nodeId: string,
  projectId?: string,
): void {
  const project =
    (projectId ? deps.projects.find((p) => p.id === projectId) : undefined) ??
    deps.projects.find((p) => p.chatIds.includes(nodeId));
  const treeId = project ? findTreeIdForNode(nodeId, project) : null;
  if (!project || !treeId) {
    // Unknown home (shouldn't happen for live nodes) — keep legacy behavior.
    deps.openPane(nodeId);
    return;
  }
  const crossesProject = project.id !== deps.activeProjectId;
  const crossesTree = treeId !== project.activeTreeId;
  if (crossesProject) deps.selectProject(project.id);
  if (crossesProject || crossesTree) {
    deps.openPaneInTree(project.id, treeId, nodeId);
    deps.activateTree(treeId, project.id);
  } else {
    deps.openPane(nodeId);
  }
  deps.setFocusedNodeId(nodeId);
}
