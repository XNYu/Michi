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
 * Open `nodeId`'s pane wherever it lives: switching workspace and/or thread
 * when needed, and landing both the focused pane and sidebar focus on it.
 *
 * Whenever the destination differs from the current slot, seed the target pane
 * via `openPaneInTree` before switching. `openPane` writes through the current
 * pane key, so calling it around workspace/tree state updates can put the pane
 * into the old slot.
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
