/**
 * Which workspaces and nodes belong to the Michi assistant. Every chat in an
 * assistant workspace (`settings.system = 'assistant'`) runs as the
 * assistant, current or archived, so none of them can become a worker.
 */

import { isAssistantWorkspaceSettings } from 'michi-shared';
import { getNode, getWorkspace } from '../services/dbRepository';

/**
 * True for the assistant's hidden workspace (any of them). Always false in
 * cloud mode: the assistant reads every workspace and maintains Pages on
 * this machine, so it exists only in the local app.
 */
export function isAssistantWorkspace(workspaceId: string | null | undefined): boolean {
  if (!workspaceId || process.env.MICHI_CLOUD === '1') return false;
  return isAssistantWorkspaceSettings(getWorkspace(workspaceId)?.settings);
}

/** True for every chat node in an assistant workspace. */
export function isAssistantNode(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  const node = getNode(nodeId);
  return !!node && isAssistantWorkspace(node.workspace_id);
}
