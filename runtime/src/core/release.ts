import type { RuntimeSessionOwner } from '../contract/types';
import { assertOwner } from '../contract/types';

/**
 * Validates ownership before releasing a runtime session. Every
 * `AgentRuntime.releaseSession()` implementation MUST call this (or an
 * equivalent owner check) when `expectedOwner` is provided.
 *
 * A stale Attempt MUST NOT release a session that has been rebound to a new
 * chat or another Run's session. When ownership does not match, this function
 * throws and the session is left intact for its real owner.
 *
 * @param sessionOwner  The owner currently bound to the session.
 * @param expectedOwner The owner the caller claims. When provided, must match.
 */
export function assertReleaseOwnership(
  sessionOwner: RuntimeSessionOwner,
  expectedOwner: RuntimeSessionOwner | undefined,
): void {
  if (expectedOwner !== undefined) {
    try { assertOwner(sessionOwner, expectedOwner); }
    catch (error) { throw Object.assign(error as Error, { code: 'SESSION_OWNER_MISMATCH' }); }
  }
}
