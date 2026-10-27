import { getDb } from '../db';
import { resolveMetaAgentBehaviour } from './settings';

/**
 * What a new incremental maintenance plan may route to. While background runs
 * may not write workspace homes, the workspace's home page is left out; the
 * chat window still edits it on request.
 */
export function backgroundMaintenanceResources<T extends { kind: string; id: string }>(workspaceId: string, ownerUserId: string, resources: T[]): T[] {
  if (resolveMetaAgentBehaviour(ownerUserId).writeWorkspaceHomes) return resources;
  const home = getDb().prepare("SELECT id FROM pages WHERE workspace_id=? AND role='workspace-home'").get(workspaceId) as { id: string } | undefined;
  return home ? resources.filter((resource) => !(resource.kind === 'page' && resource.id === home.id)) : resources;
}
