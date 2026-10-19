/**
 * Native-terminal commands for remote SSH sign-in. The main process cannot
 * import shared/src/remoteCredentials.ts at runtime, so these mirror its
 * localCommand and remoteCommand; scripts/remote-auth.test.mjs keeps them equal.
 */
export const SIGN_IN_COMMANDS: { local: readonly string[]; remote: readonly string[] | null } = {
  local: ['ssh-add'],
  remote: null,
};
