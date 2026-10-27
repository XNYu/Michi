export const LOCAL_AGENT_OWNER_ID = 'local-user';

/**
 * Desktop workspaces predate cloud ownership and persist NULL owners. On the
 * desktop every workspace in the local database is the local user's, as
 * listWorkspaces and getWorkspace treat it, including rows a cloud-mode run
 * left with its own owner id.
 */
export function workspaceOwnerMatches(storedOwnerUserId: string | null, ownerUserId: string): boolean {
  if (storedOwnerUserId === ownerUserId) return true;
  return process.env.MICHI_CLOUD !== '1' && ownerUserId === LOCAL_AGENT_OWNER_ID;
}
