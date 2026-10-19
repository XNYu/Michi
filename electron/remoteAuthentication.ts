import type { RemoteAuthenticationTarget } from 'michi-shared';

export interface SignInCommands { local: readonly string[]; remote: readonly string[] | null }

export function remoteAuthenticationProcess(value: unknown, commands: SignInCommands): { binary: string; args: string[] } {
  const target = value as RemoteAuthenticationTarget | null;
  if (!target || typeof target.host !== 'string' || !/^[a-zA-Z0-9_.+:\[\]-]{1,255}$/.test(target.host) || target.host.startsWith('-')
    || (target.user !== undefined && (typeof target.user !== 'string' || !/^[a-zA-Z0-9_.+-]+$/.test(target.user) || target.user.startsWith('-')))
    || (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535))
    || (target.scope !== 'local' && target.scope !== 'remote')) throw new Error('Invalid remote authentication target');
  // Local refresh fixes the SSH identity. Remote refresh fixes credentials used
  // by agents on that host; those are different credential stores.
  if (target.scope === 'local') return { binary: commands.local[0], args: commands.local.slice(1) };
  if (!commands.remote) throw new Error('Remote sign-in is not available in this build');
  return { binary: 'ssh', args: [
    '-tt', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(target.port ? ['-p', String(target.port)] : []),
    target.user ? `${target.user}@${target.host}` : target.host,
    `export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"; exec ${commands.remote.join(' ')}`,
  ] };
}
