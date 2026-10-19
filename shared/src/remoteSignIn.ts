import { REMOTE_CREDENTIALS, type RemoteCredentialProvider } from './remoteCredentials';
import type { RemoteAuthenticationTarget } from './remoteDiagnostics';

/** Dialog title and button label for the sign-in terminal. */
export function remoteSignInLabel(provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): string {
  return `Refresh ${provider.name} sign-in`;
}

/** Warning the remote inspection reports for an expired cookie; null when nothing is checked. */
export function remoteCredentialExpiredWarning(provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): string | null {
  if (!provider.remoteCookie || !provider.remoteCommand) return null;
  return `${provider.name} credentials on this remote machine have expired. Run ${provider.remoteCommand.join(' ')} before starting a chat.`;
}

export function isRemoteCredentialWarning(warning: string, provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): boolean {
  const expired = remoteCredentialExpiredWarning(provider);
  return expired !== null && warning === expired;
}

/** Only a provider with a remote sign-in command can act on remote credential errors. */
export function isRemoteCredentialError(message: string, provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): boolean {
  return provider.remoteCommand !== null && !!provider.remoteCredentialError?.test(message);
}

export function isLocalCredentialError(message: string, provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): boolean {
  return !!provider.localCredentialError?.test(message);
}

/** Command a user can run in their own terminal; null when the target has no sign-in command. */
export function remoteSignInCommand(target: RemoteAuthenticationTarget, provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): string | null {
  if (target.scope === 'local') return provider.localCommand.join(' ');
  if (!provider.remoteCommand) return null;
  const destination = (target.user ? target.user + '@' : '') + target.host;
  return `ssh -tt ${target.port ? `-p ${target.port} ` : ''}${destination} '${provider.remoteCommand.join(' ')}'`;
}

/**
 * Python for the remote inspection script. Reads only cookie expiry fields and
 * appends remoteCredentialExpiredWarning() to result['runtimeWarnings'].
 */
export function remoteCredentialCheckPython(provider: RemoteCredentialProvider = REMOTE_CREDENTIALS): string {
  const warning = remoteCredentialExpiredWarning(provider);
  if (!provider.remoteCookie || !warning) return '';
  return `cookie = home / ${JSON.stringify(provider.remoteCookie.path)}
if cookie.is_file():
    try:
        expiries = []
        for line in cookie.read_text().splitlines():
            if line.startswith('#HttpOnly_'): line = line[len('#HttpOnly_'):]
            elif line.startswith('#'): continue
            fields = line.split('\\t')
            if len(fields) >= 7 and ${JSON.stringify(provider.remoteCookie.domain)} in fields[0] and fields[4].isdigit(): expiries.append(int(fields[4]))
        if expiries and all(expiry > 0 and expiry <= time.time() for expiry in expiries):
            result['runtimeWarnings'].append(${JSON.stringify(warning)})
    except OSError: pass
`;
}
