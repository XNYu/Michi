import type { RuntimeHost, SessionRegistryPort } from '../contract/host';
import type { SessionDirectory } from './sessionDirectory';

/** A session directory and the host whose principal, onSessionStateChanged and observability it reads. */
export interface PortDirectory {
  readonly directory: SessionDirectory;
  readonly host: RuntimeHost;
}

/** The SessionRegistryPort methods, in declaration order. */
export const SESSION_PORT_METHODS = [
  'ensureAncestorChainLoaded', 'getSession', 'getAncestors', 'registerSession', 'dropSession',
] as const satisfies ReadonlyArray<keyof SessionRegistryPort>;

// The methods of sessions ports this package built over a session directory,
// each mapped to that directory. A port is recognized by its methods, not its
// object, so a copy of all five ({ ...port }) is the same port. Kept off the
// port's shape: a host's own sessions port has none to report, and the
// package index does not export this module. A method wrapped by the host
// (bind, forwarding) is a new function, so it counts as the host's own.
const methods = new WeakMap<object, PortDirectory>();

/** Records `directory`, read through `host`, as the one `port` registers into and reads from. Returns `port`. */
export function withSessionDirectory<T extends SessionRegistryPort>(port: T, directory: SessionDirectory, host: RuntimeHost): T {
  const behind = { directory, host };
  for (const name of SESSION_PORT_METHODS) methods.set(port[name], behind);
  return port;
}

function methodOwner(port: SessionRegistryPort, name: keyof SessionRegistryPort): PortDirectory | undefined {
  const method: unknown = port[name];
  return typeof method === 'function' ? methods.get(method) : undefined;
}

/**
 * The directory behind a sessions port this package built (createDefaultHost's,
 * when not overridden), or behind a copy of all five of its methods.
 * Undefined for any other port: a host's own, or one mixing methods.
 */
export function sessionDirectoryBehind(port: SessionRegistryPort | null | undefined): PortDirectory | undefined {
  if (!port) return undefined;
  const [first, ...rest] = SESSION_PORT_METHODS.map((name) => methodOwner(port, name));
  return first && rest.every((behind) => behind === first) ? first : undefined;
}

/**
 * Methods of `port` that belong to a port this package built. For a port
 * sessionDirectoryBehind does not recognize, non-empty means it mixes them
 * with its own methods or with another such port's.
 */
export function borrowedSessionMethods(port: SessionRegistryPort | null | undefined): Array<keyof SessionRegistryPort> {
  if (!port) return [];
  return SESSION_PORT_METHODS.filter((name) => methodOwner(port, name) !== undefined);
}
