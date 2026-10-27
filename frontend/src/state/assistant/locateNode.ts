import { fetchNodeWorkspace, fetchWorkspace } from '../../services/api/persistence';
import { remoteEntityIdentity } from '../../config/backendIdentity';

/** The id names a thread on a remote connection (`remote:<connection>:<id>`). */
function namesRemoteNode(nodeId: string): boolean {
  try {
    return remoteEntityIdentity(nodeId) !== null;
  } catch {
    // A malformed `remote:` id is still not this machine's.
    return true;
  }
}

/**
 * The workspace snapshot holding `nodeId`, for a thread this window doesn't
 * have yet: one created in another window since this one loaded, which the
 * assistant can name because it reads the backend. Asks the backend where
 * the node lives, then reads that one workspace.
 *
 * Null only when the backend confirms there is no live thread by that id (a
 * deleted one, or one in a deleted workspace, included); throws when it
 * can't be asked, so the caller can try again. A remote connection's thread
 * throws too: this machine's backend can't answer for it, and only that
 * connection's own load brings it in. `readStartedAt` is when the workspace
 * read began, for installWorkspaceSnapshot.
 */
export async function fetchWorkspaceHoldingNode(
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ workspace: unknown; readStartedAt: number } | null> {
  if (namesRemoteNode(nodeId)) throw new Error('A remote thread loads with its connection');
  const where = await fetchNodeWorkspace(nodeId, signal);
  if (!where) return null;
  const readStartedAt = Date.now();
  return { workspace: await fetchWorkspace(where.workspaceId, signal), readStartedAt };
}
