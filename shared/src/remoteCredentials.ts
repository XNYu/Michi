/**
 * Sign-in system behind remote SSH connections: the commands Michi offers when
 * SSH authentication or a remote agent's credentials expire, and how that expiry
 * is recognised. This file and electron/remoteCredentials.ts are the only places
 * that name it. A build for another environment replaces both; the logic in
 * remoteSignIn.ts and its callers stays the same.
 */
export interface RemoteCredentialProvider {
  /** Shown in sign-in UI, e.g. "Refresh <name> sign-in". */
  name: string;
  /** Sentence describing the local refresh, completed by ", then Michi will check SSH again." */
  localAction: string;
  /** Interactive command on this computer that refreshes the identity SSH uses. */
  localCommand: readonly string[];
  /** Interactive command run on the remote machine for credentials its agents use; null when there is none. */
  remoteCommand: readonly string[] | null;
  /** Netscape-format cookie file under the remote home whose expiry is checked when connecting. */
  remoteCookie: { path: string; domain: string } | null;
  /** Agent or runtime error text meaning the remote machine's credentials expired. */
  remoteCredentialError: RegExp | null;
  /** SSH error text meaning this computer's sign-in expired. */
  localCredentialError: RegExp | null;
}

export const REMOTE_CREDENTIALS: RemoteCredentialProvider = {
  name: 'SSH',
  localAction: 'Load your SSH key on this computer',
  localCommand: ['ssh-add'],
  remoteCommand: null,
  remoteCookie: null,
  remoteCredentialError: null,
  localCredentialError: null,
};
