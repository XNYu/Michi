export const LOCAL_AGENT_OWNER_ID = 'local-user';

/** Desktop workspaces predate cloud ownership and intentionally persist NULL owners. */
export function workspaceOwnerMatches(storedOwnerUserId: string | null, ownerUserId: string): boolean {
  if (storedOwnerUserId === ownerUserId) return true;
  return process.env.MICHI_CLOUD !== '1'
    && storedOwnerUserId === null
    && ownerUserId === LOCAL_AGENT_OWNER_ID;
}
