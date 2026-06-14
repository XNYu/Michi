import { authClient } from './auth';
import { STATE_KEY_PREFIX, LEGACY_STATE_KEY, MIGRATED_KEY } from '../state/workspacePersistence';

/**
 * Clear all per-user workspace state from localStorage, then sign out and
 * reload. This prevents one user's data from flashing in the UI after
 * another user signs in on the same browser.
 *
 * Keys cleared:
 *   - michi:v1:state:<userId>  (all per-user namespaced keys)
 *   - michi:v1:state           (legacy shared key, in case migration ran)
 *   - michi:migrated           (migration sentinel)
 *
 * michi:prefs and michi:markdownRenderer are intentionally left intact —
 * they are UI preferences, not user data.
 */
export async function signOutAndReset(): Promise<void> {
  for (const k of Object.keys(localStorage)) {
    if (
      k.startsWith(STATE_KEY_PREFIX) ||
      k === LEGACY_STATE_KEY ||
      k === MIGRATED_KEY
    ) {
      localStorage.removeItem(k);
    }
  }
  try {
    await authClient.signOut();
  } catch {
    /* swallow — reload regardless */
  }
  window.location.assign('/');
}
