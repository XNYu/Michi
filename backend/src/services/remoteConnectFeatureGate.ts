/** The one switch for Connect by host: SSH setup of a remote Michi (inspect,
 *  install, start and verify) and automatic recovery of saved SSH connections.
 *  Off unless this variable is exactly '1'. */
export const REMOTE_CONNECT_BY_HOST_ENV = 'MICHI_REMOTE_CONNECT_BY_HOST';

/**
 * Environment-only, read when the backend-connection routes are created at
 * startup. Manual SSH tunnel and Direct URL connections, the proxy and remote
 * folder browsing do not depend on it.
 */
export function isRemoteConnectByHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REMOTE_CONNECT_BY_HOST_ENV] === '1';
}
