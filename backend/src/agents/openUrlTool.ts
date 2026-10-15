import { getNode, getWorkspace } from '../services/dbRepository';
import { urlOpenRequests } from '../services/urlOpenRequests';

/** Scope comes exclusively from the runtime session, never the model's arguments. */
export function openUrlTool(binding: { workspaceId: string | null; nodeId?: string | null; ownerUserId?: string | null }, url: unknown) {
  if (!binding.workspaceId) throw new Error('open_url requires a bound workspace');
  if (process.env.MICHI_CLOUD === '1' && !binding.ownerUserId) throw new Error('Missing owner');
  const workspace = getWorkspace(binding.workspaceId, binding.ownerUserId ?? undefined);
  if (!workspace || workspace.deleted_at || workspace.archived_at) throw new Error('Workspace unavailable');
  const node = binding.nodeId ? getNode(binding.nodeId) : null;
  if (binding.nodeId && (!node || node.deleted_at || node.workspace_id !== workspace.id)) throw new Error('Session node is outside its workspace');
  urlOpenRequests.enqueue({ workspaceId: workspace.id, treeId: node?.tree_id ?? null, ownerUserId: binding.ownerUserId ?? null }, url);
  return { content: [{ type: 'text' as const, text: 'Requested opening the URL using the user’s Browser preference. Delivery requires this workspace and tree to be visible in Michi within 30 seconds; this does not confirm the page loaded. Do not also launch an OS browser.' }] };
}
