import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';

/**
 * Whose Michi Memory a caller reads and writes: the signed-in user in cloud
 * mode (null without one), the local identity on the desktop whoever the
 * session names. This is the rule of the REST API Settings → Memory uses
 * (routes/memories.ts `caller`), so what an agent's memory tools
 * (agents/memoryTools.ts) save is what Settings lists and what the
 * owner-filtered change feed delivers; memoryTools.test.ts checks the two
 * against each other.
 */
export function memoryOwnerId(sessionUserId: string | null | undefined): string | null {
  if (process.env.MICHI_CLOUD === '1') return typeof sessionUserId === 'string' ? sessionUserId.trim() || null : null;
  return LOCAL_AGENT_OWNER_ID;
}
